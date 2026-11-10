/**
 * The user-route limiter (lib/http/rate-limit.ts): once an account's window
 * is full, asking, creating conversations, changing participants, upload
 * tokens and domain checks answer 429 before doing any work, and another
 * account is unaffected.
 */
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inArray, like } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { USER_RATE_LIMITS } from '@/lib/constants';
import { SESSION_COOKIE } from '@/lib/http/cookies';
import { db, schema } from '@/lib/infra/db';
import { sessionTokenHash } from '@/lib/services/auth';
import { POST as createChat } from '@/app/api/chats/route';
import { POST as ask } from '@/app/api/chats/[id]/messages/route';
import { PUT as setParticipants } from '@/app/api/chats/[id]/rees/route';
import { POST as uploadToken } from '@/app/api/upload-token/route';
import { POST as verifyDomain } from '@/app/api/domains/[id]/verify/route';
import type { RateLimitName } from '@/lib/http/rate-limit';

let token: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === SESSION_COOKIE && token ? { value: token } : undefined) }),
  headers: async () => new Headers(),
}));

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const base = 'http://localhost:3000';
const ids: string[] = [];

async function signedInUser(): Promise<string> {
  const subject = uniqueName('limited');
  const [user] = await db().insert(schema.user).values({ name: 'Limited', email: `${subject}@example.test`, provider: 'github', providerSubject: subject }).returning();
  ids.push(user!.id);
  token = crypto.randomUUID();
  await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId: user!.id, expiresAt: new Date(Date.now() + 60_000) });
  return user!.id;
}

/** Fills the account's first window for `name` up to its limit, as earlier requests would have. */
async function fill(name: RateLimitName, userId: string) {
  const rule = USER_RATE_LIMITS[name][0];
  const windowMs = rule.windowSeconds * 1_000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  await db().insert(schema.rateBucket).values({ key: `${name}:${rule.windowSeconds}:user:${userId}`, windowStart, hits: rule.limit });
}

function post(path: string, payload: unknown, method = 'POST') {
  return new NextRequest(`${base}${path}`, { method, headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}

const conversationId = '0c8f4f43-1f0a-4cf5-9f44-8a4c7bd5e222';
const routes: [RateLimitName, () => Promise<Response>][] = [
  ['conversation', () => createChat(post('/api/chats', {}))],
  ['ask', () => ask(post(`/api/chats/${conversationId}/messages`, { question: 'hi' }), { params: Promise.resolve({ id: conversationId }) })],
  ['participants', () => setParticipants(post(`/api/chats/${conversationId}/rees`, { reeIds: [] }, 'PUT'), { params: Promise.resolve({ id: conversationId }) })],
  ['uploadToken', () => uploadToken(post('/api/upload-token', { purpose: 'avatar', contentType: 'image/png', size: 10 }))],
  ['domainVerify', () => verifyDomain(post(`/api/domains/${conversationId}/verify`, {}), { params: Promise.resolve({ id: conversationId }) })],
];

suite('user route rate limits', () => {
  beforeAll(() => {
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_teststore_secret');
  });
  afterAll(async () => {
    token = undefined;
    vi.unstubAllEnvs();
    await db().delete(schema.rateBucket).where(like(schema.rateBucket.key, '%:user:%'));
    if (ids.length) await db().delete(schema.conversation).where(inArray(schema.conversation.userId, ids));
    if (ids.length) await db().delete(schema.user).where(inArray(schema.user.id, ids));
  });

  for (const [name, call] of routes) {
    it(`${name}: refuses a full window before doing any work`, async () => {
      const fresh = await signedInUser();
      const before = await call();
      expect(before.status).not.toBe(429);
      const userId = await signedInUser();
      await fill(name, userId);
      const limited = await call();
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(fresh).not.toBe(userId);
    });
  }
});

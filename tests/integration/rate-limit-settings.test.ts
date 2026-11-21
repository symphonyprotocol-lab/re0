/**
 * The console's rate limits (lib/services/rate-limit-settings.ts): a stored
 * row replaces a limit's code default, a limit without one keeps the
 * default, an exempt account never gets a 429, and only an administrator
 * may read or change any of it through /api/admin/rate-limits.
 */
import { freezeDateAtWindowStart, TEST_DATABASE_URL, uniqueName } from './setup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { USER_RATE_LIMITS } from '@/lib/constants';
import { db, schema } from '@/lib/infra/db';
import { rateLimited } from '@/lib/http/rate-limit';
import { openAdminSession } from '@/lib/services/admin';
import {
  addRateLimitExemption,
  effectiveRateRules,
  forgetRateLimitSettings,
  resetRateLimit,
  saveRateLimit,
} from '@/lib/services/rate-limit-settings';
import * as limitsRoute from '@/app/api/admin/rate-limits/route';
import * as exemptionsRoute from '@/app/api/admin/rate-limits/exemptions/route';
import * as exemptionRoute from '@/app/api/admin/rate-limits/exemptions/[userId]/route';

const session = vi.hoisted(() => ({ token: null as string | null }));
vi.mock('next/headers', async () => {
  const { ADMIN_SESSION_COOKIE } = await import('@/lib/http/cookies');
  return {
    cookies: async () => ({ get: (name: string) => (name === ADMIN_SESSION_COOKIE && session.token ? { value: session.token } : undefined) }),
    headers: async () => new Headers(),
  };
});

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const base = 'http://localhost:3000';
const users: string[] = [];
let administratorId: string;

async function account(): Promise<{ id: string; email: string }> {
  const subject = uniqueName('limits');
  const email = `${subject}@example.test`;
  const [user] = await db().insert(schema.user).values({ name: 'Limits', email, provider: 'github', providerSubject: subject }).returning();
  users.push(user!.id);
  return { id: user!.id, email };
}

const caller = (userId: string) => ({ userId, headers: new Headers() });

function request(path: string, method: string, payload?: unknown, origin = base) {
  return new NextRequest(`${base}${path}`, {
    method,
    headers: { origin, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

suite('console rate limits and exemptions', () => {
  beforeAll(async () => {
    const [admin] = await db().insert(schema.administrator).values({ name: 'Limits', email: `${uniqueName('limits-admin')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x' }).returning({ id: schema.administrator.id });
    administratorId = admin!.id;
    vi.stubEnv('APP_BASE_URL', base);
  });
  beforeEach(async () => {
    await db().delete(schema.rateLimitSetting);
    await db().delete(schema.rateLimitExemption);
    forgetRateLimitSettings();
    freezeDateAtWindowStart(60);
  });
  afterEach(() => {
    vi.useRealTimers();
    session.token = null;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db().delete(schema.rateLimitSetting);
    await db().delete(schema.rateLimitExemption);
    forgetRateLimitSettings();
    await db().delete(schema.rateBucket).where(like(schema.rateBucket.key, '%:user:%'));
    await db().delete(schema.adminAudit).where(eq(schema.adminAudit.administratorId, administratorId));
    await db().delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
    if (users.length) await db().delete(schema.user).where(inArray(schema.user.id, users));
  });

  it('uses the code defaults while nothing is stored', async () => {
    const { id } = await account();
    expect(await effectiveRateRules('uploadToken', id)).toEqual(USER_RATE_LIMITS.uploadToken);
    const perMinute = USER_RATE_LIMITS.domainVerify[0].limit;
    for (let i = 0; i < perMinute; i += 1) expect(await rateLimited('domainVerify', caller(id))).toBeNull();
    expect((await rateLimited('domainVerify', caller(id)))?.status).toBe(429);
  });

  it('counts against a stored override, and goes back to the default on reset', async () => {
    const { id } = await account();
    await saveRateLimit(administratorId, 'uploadToken', { perMinute: 2, perHour: 3 });
    expect(await rateLimited('uploadToken', caller(id))).toBeNull();
    expect(await rateLimited('uploadToken', caller(id))).toBeNull();
    const limited = await rateLimited('uploadToken', caller(id));
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);

    // Raised above the default: an account past the default minute window still goes ahead.
    const other = await account();
    const defaultMinute = USER_RATE_LIMITS.uploadToken[0].limit;
    await db().insert(schema.rateBucket).values({ key: `uploadToken:60:user:${other.id}`, windowStart: new Date(), hits: defaultMinute });
    await saveRateLimit(administratorId, 'uploadToken', { perMinute: defaultMinute + 10, perHour: 10_000 });
    expect(await rateLimited('uploadToken', caller(other.id))).toBeNull();

    await resetRateLimit(administratorId, 'uploadToken');
    expect(await effectiveRateRules('uploadToken', other.id)).toEqual(USER_RATE_LIMITS.uploadToken);
    expect((await rateLimited('uploadToken', caller(other.id)))?.status).toBe(429);

    const actions = await db().select({ action: schema.adminAudit.action }).from(schema.adminAudit).where(and(eq(schema.adminAudit.administratorId, administratorId), eq(schema.adminAudit.target, 'uploadToken')));
    expect(actions.map((row) => row.action).sort()).toEqual(['rate_limit.reset', 'rate_limit.update', 'rate_limit.update']);
  });

  it('refuses values out of bounds or a minute above the hour', async () => {
    for (const input of [{ perMinute: 0, perHour: 10 }, { perMinute: 5, perHour: 4 }, { perMinute: 1.5, perHour: 10 }, { perMinute: '5', perHour: 10 }]) {
      await expect(saveRateLimit(administratorId, 'comment', input)).rejects.toMatchObject({ code: 'invalid_rate_limit' });
    }
    await expect(saveRateLimit(administratorId, 'nope', { perMinute: 1, perHour: 1 })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets an exempt account through every limit without counting it', async () => {
    const exempt = await account();
    const counted = await account();
    await saveRateLimit(administratorId, 'comment', { perMinute: 1, perHour: 1 });
    await addRateLimitExemption(administratorId, { email: exempt.email.toUpperCase(), note: 'official' });
    for (let i = 0; i < 5; i += 1) {
      for (const name of Object.keys(USER_RATE_LIMITS) as (keyof typeof USER_RATE_LIMITS)[]) {
        expect(await rateLimited(name, caller(exempt.id))).toBeNull();
      }
    }
    const buckets = await db().select().from(schema.rateBucket).where(like(schema.rateBucket.key, `%:user:${exempt.id}`));
    expect(buckets).toEqual([]);
    expect(await rateLimited('comment', caller(counted.id))).toBeNull();
    expect((await rateLimited('comment', caller(counted.id)))?.status).toBe(429);
  });

  it('answers only an administrator, and only from the same origin', async () => {
    const target = await account();
    const userContext = { params: Promise.resolve({ userId: target.id }) };

    expect((await limitsRoute.GET(request('/api/admin/rate-limits', 'GET'))).status).toBe(401);
    expect((await limitsRoute.PUT(request('/api/admin/rate-limits', 'PUT', { name: 'browse', perMinute: 1, perHour: 1 }))).status).toBe(401);
    expect((await limitsRoute.DELETE(request('/api/admin/rate-limits', 'DELETE', { name: 'browse' }))).status).toBe(401);
    expect((await exemptionsRoute.POST(request('/api/admin/rate-limits/exemptions', 'POST', { userId: target.id }))).status).toBe(401);
    expect((await exemptionRoute.DELETE(request(`/api/admin/rate-limits/exemptions/${target.id}`, 'DELETE'), userContext)).status).toBe(401);
    expect(await db().select().from(schema.rateLimitSetting)).toEqual([]);
    expect(await db().select().from(schema.rateLimitExemption)).toEqual([]);

    session.token = (await openAdminSession(administratorId)).token;
    expect((await limitsRoute.PUT(request('/api/admin/rate-limits', 'PUT', { name: 'browse', perMinute: 1, perHour: 1 }, 'https://attacker.test'))).status).toBe(403);
    expect((await exemptionsRoute.POST(request('/api/admin/rate-limits/exemptions', 'POST', { userId: target.id }, 'https://attacker.test'))).status).toBe(403);
    expect(await db().select().from(schema.rateLimitSetting)).toEqual([]);

    const saved = await limitsRoute.PUT(request('/api/admin/rate-limits', 'PUT', { name: 'browse', perMinute: 7, perHour: 70 }));
    expect(saved.status).toBe(200);
    expect((await saved.json()).limit).toMatchObject({ name: 'browse', perMinute: 7, perHour: 70, overridden: true });
    expect((await limitsRoute.PUT(request('/api/admin/rate-limits', 'PUT', { name: 'browse', perMinute: 0, perHour: 70 }))).status).toBe(422);
    expect((await limitsRoute.PUT(request('/api/admin/rate-limits', 'PUT', { name: 'nope', perMinute: 1, perHour: 1 }))).status).toBe(404);

    const added = await exemptionsRoute.POST(request('/api/admin/rate-limits/exemptions', 'POST', { email: target.email, note: 'RE0 Official' }));
    expect(added.status).toBe(200);
    expect((await added.json()).exemption).toMatchObject({ userId: target.id, email: target.email, note: 'RE0 Official' });
    expect((await exemptionsRoute.POST(request('/api/admin/rate-limits/exemptions', 'POST', { email: 'nobody@example.test' }))).status).toBe(404);

    const read = await (await limitsRoute.GET(request('/api/admin/rate-limits', 'GET'))).json();
    expect(read.limits.find((row: { name: string }) => row.name === 'browse')).toMatchObject({ perMinute: 7, perHour: 70, defaults: { perMinute: USER_RATE_LIMITS.browse[0].limit, perHour: USER_RATE_LIMITS.browse[1].limit } });
    expect(read.limits.find((row: { name: string }) => row.name === 'ask')).toMatchObject({ overridden: false, perMinute: USER_RATE_LIMITS.ask[0].limit });
    expect(read.exemptions.map((row: { userId: string }) => row.userId)).toEqual([target.id]);

    expect((await exemptionRoute.DELETE(request(`/api/admin/rate-limits/exemptions/${target.id}`, 'DELETE'), userContext)).status).toBe(200);
    expect((await exemptionRoute.DELETE(request(`/api/admin/rate-limits/exemptions/${target.id}`, 'DELETE'), userContext)).status).toBe(404);
    const reset = await limitsRoute.DELETE(request('/api/admin/rate-limits', 'DELETE', { name: 'browse' }));
    expect((await reset.json()).limit).toMatchObject({ overridden: false, perMinute: USER_RATE_LIMITS.browse[0].limit });

    const audited = await db().select({ action: schema.adminAudit.action }).from(schema.adminAudit).where(eq(schema.adminAudit.target, target.id));
    expect(audited.map((row) => row.action).sort()).toEqual(['rate_limit.exempt.add', 'rate_limit.exempt.remove']);
  });
});

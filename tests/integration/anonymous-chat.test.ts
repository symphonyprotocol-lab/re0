/**
 * Anonymous chat with free Rees: eligibility read on every request, the
 * daily rounds taken atomically per key (fingerprint, anonymous id, address)
 * and rolled over by UTC day, a round given back when the question gets no
 * answer or fails before any text, and nothing written to the ledger, holds,
 * conversations or messages -- only an `anonymous_answer` row the owner's
 * statistics count.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, count, eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { consoleAdministrator } from '../fixtures/console-administrator';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

/* The console's routes read the session from `next/headers`: here nobody is signed in to the console. */
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const anonymous = await import('@/lib/services/anonymous-chat');
const { answerCounts, reeStatistics, statisticsQuery } = await import('@/lib/services/statistics');
const { publicReeBySlug } = await import('@/lib/services/public-rees');
const { GET, POST } = await import('@/app/api/rees/[id]/anonymous-chat/route');
const { ANONYMOUS_ATTEMPTS_FACTOR, ANONYMOUS_IP_ROUNDS_PER_DAY, ANONYMOUS_LIMITS_CACHE_MS, ANONYMOUS_PLATFORM_ROUNDS_PER_DAY, ANONYMOUS_REE_ROUNDS_PER_DAY, ANONYMOUS_ROUNDS_PER_DAY } = await import('@/lib/constants');
const { ANONYMOUS_CAPACITY_REACHED, ANONYMOUS_ID_COOKIE, ANONYMOUS_NETWORK_LIMIT, ANONYMOUS_QUOTA_EXCEEDED, FINGERPRINT_HEADER, anonymousDay, ipBucket } = await import('@/lib/domain/anonymous-chat');
const { db, schema } = await import('@/lib/infra/db');
const share = await import('@/lib/services/share');
const { publicReeRef } = await import('@/lib/services/public-rees');
const { VISITOR_COOKIE } = await import('@/lib/http/share');
const { adminOverview } = await import('@/lib/services/admin-overview');
const settings = await import('@/lib/services/anonymous-chat-settings');
const pricingRoute = await import('@/app/api/admin/pricing/route');
const { AdminInputError } = await import('@/lib/services/admin');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');

const QUESTION = 'When are refunds issued to the original payment method?';
const base = 'http://localhost:3000';

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
  /* `FAIL FIRST` gets a provider error before any text: the fake has no such mode of its own. */
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === `${fake.baseUrl}/chat/completions` && typeof init?.body === 'string' && init.body.includes('FAIL FIRST')) {
      return new Response(JSON.stringify({ error: { message: 'bad request', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return original(input, init);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await fake?.close();
});

/** A public, published Ree with ready knowledge about refunds, at `fee`. */
async function freeRee(fee = 0) {
  const subject = uniqueName('anon-owner');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'Owner', avatarUrl: null }, 'en', '/');
  await rees.saveDraft(userId, { ...newReeDraft(), name: 'Refund desk', category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  const id = await knowledge.addKnowledge(userId, ree, {
    kind: 'text',
    title: 'Refund policy',
    content: 'Refunds are issued to the original payment method within 14 days of the request. The refund goes back to the card or account that paid.',
  });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true, queryFee: fee }).where(eq(schema.ree.id, ree.id));
  return { ownerId: userId, reeId: ree.id };
}

function fingerprint(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

function ask(reeId: string, visitor: { fingerprint?: string; ip: string; cookie?: string; shareVisitor?: string }, question = QUESTION, extra: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { origin: base, host: 'localhost:3000', 'content-type': 'application/json' };
  if (visitor.ip) headers['x-real-ip'] = visitor.ip;
  if (visitor.fingerprint) headers[FINGERPRINT_HEADER] = visitor.fingerprint;
  const cookies = [visitor.cookie && `${ANONYMOUS_ID_COOKIE}=${visitor.cookie}`, visitor.shareVisitor && `${VISITOR_COOKIE}=${visitor.shareVisitor}`].filter(Boolean);
  if (cookies.length) headers.cookie = cookies.join('; ');
  return POST(new NextRequest(`${base}/api/rees/${reeId}/anonymous-chat`, { method: 'POST', headers, body: JSON.stringify({ question, lang: 'en', ...extra }) }), { params: Promise.resolve({ id: reeId }) });
}

function quota(reeId: string, visitor: { fingerprint: string; ip: string; cookie?: string }) {
  const headers: Record<string, string> = { 'x-real-ip': visitor.ip, [FINGERPRINT_HEADER]: visitor.fingerprint };
  if (visitor.cookie) headers.cookie = `${ANONYMOUS_ID_COOKIE}=${visitor.cookie}`;
  return GET(new NextRequest(`${base}/api/rees/${reeId}/anonymous-chat`, { headers }), { params: Promise.resolve({ id: reeId }) });
}

async function read(response: Response) {
  const raw = await response.text();
  const events = raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: string; data?: Record<string, unknown> });
  return {
    text: events.filter((event) => event.type === 'text-delta').map((event) => event.delta).join(''),
    outcome: events.find((event) => event.type === 'data-outcome')?.data as { noAnswer: boolean; failed: boolean; cost: number; reason: string | null; citations: unknown[] } | undefined,
    quota: events.find((event) => event.type === 'data-quota')?.data as { limit: number; remaining: number; blocked: string | null } | undefined,
  };
}

let ipCounter = 0;
/** A fresh address per visitor, so the per-address limits of one test do not reach another's. */
function ip(): string {
  ipCounter += 1;
  return `198.51.${Math.floor(Math.random() * 200)}.${ipCounter % 250}`;
}

async function roundsOf(hashes: string[], day: string) {
  const rows = await db()
    .select({ hash: schema.anonymousChatQuota.keyHash, rounds: schema.anonymousChatQuota.rounds })
    .from(schema.anonymousChatQuota)
    .where(and(inArray(schema.anonymousChatQuota.keyHash, hashes), eq(schema.anonymousChatQuota.day, day)));
  return new Map(rows.map((row) => [row.hash, row.rounds]));
}

/** The fingerprint and cookie keys: the visitor's own. */
const own = (keys: { hash: string; scope: string }[]) => keys.filter((key) => key.scope === 'visitor').map((key) => key.hash);

/** Sets a key's counts for today, and answers how to put them back. */
async function seed(hash: string, rounds: number, attempts = rounds) {
  const day = anonymousDay();
  const [before] = await db().select().from(schema.anonymousChatQuota).where(and(eq(schema.anonymousChatQuota.keyHash, hash), eq(schema.anonymousChatQuota.day, day)));
  await db()
    .insert(schema.anonymousChatQuota)
    .values({ keyHash: hash, day, rounds, attempts })
    .onConflictDoUpdate({ target: [schema.anonymousChatQuota.keyHash, schema.anonymousChatQuota.day], set: { rounds, attempts } });
  return async () => {
    if (before) await db().update(schema.anonymousChatQuota).set({ rounds: before.rounds, attempts: before.attempts }).where(and(eq(schema.anonymousChatQuota.keyHash, hash), eq(schema.anonymousChatQuota.day, day)));
    else await db().delete(schema.anonymousChatQuota).where(and(eq(schema.anonymousChatQuota.keyHash, hash), eq(schema.anonymousChatQuota.day, day)));
  };
}

const keysFor = (address = ip(), reeId: string = crypto.randomUUID()) => anonymous.visitorKeys({ fingerprint: fingerprint(), anonymousId: crypto.randomUUID(), ip: address, reeId });

describeWithDb('anonymous chat quota', () => {
  it('never lets concurrent requests take a key past its daily limit', async () => {
    const keys = await keysFor();
    const results = await Promise.all(Array.from({ length: 25 }, () => anonymous.reserveRound(keys)));
    expect(results.filter((result) => result.ok)).toHaveLength(ANONYMOUS_ROUNDS_PER_DAY);
    const rounds = await roundsOf(own(keys), anonymousDay());
    expect([...rounds.values()]).toEqual([ANONYMOUS_ROUNDS_PER_DAY, ANONYMOUS_ROUNDS_PER_DAY]);
    expect(Math.min(...results.flatMap((result) => (result.ok ? [result.quota.remaining] : [])))).toBe(0);
    expect(results.find((result) => !result.ok)).toMatchObject({ ok: false, scope: 'visitor' });
    expect(await anonymous.anonymousQuota(keys)).toEqual({ limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: 0, blocked: null });
  });

  it('caps one address across fingerprints, and takes nothing on the other keys when one is full', async () => {
    const address = ip();
    const visitors = await Promise.all(Array.from({ length: Math.ceil(ANONYMOUS_IP_ROUNDS_PER_DAY / ANONYMOUS_ROUNDS_PER_DAY) + 2 }, () => keysFor(address)));
    const results = await Promise.all(visitors.flatMap((keys) => Array.from({ length: ANONYMOUS_ROUNDS_PER_DAY }, () => anonymous.reserveRound(keys))));
    expect(results.filter((result) => result.ok)).toHaveLength(ANONYMOUS_IP_ROUNDS_PER_DAY);
    expect(results.filter((result) => !result.ok).every((result) => !result.ok && result.scope === 'network')).toBe(true);
    const ipHash = visitors[0]!.find((key) => key.scope === 'network')!.hash;
    expect((await roundsOf([ipHash], anonymousDay())).get(ipHash)).toBe(ANONYMOUS_IP_ROUNDS_PER_DAY);
    /* A refused round took nothing on the fingerprint and cookie keys: they add up to what the address let through. */
    const personal = await roundsOf(visitors.flatMap(own), anonymousDay());
    expect([...personal.values()].reduce((sum, value) => sum + value, 0)).toBe(ANONYMOUS_IP_ROUNDS_PER_DAY * 2);
  });

  it('starts again on the next UTC day, and gives a round back on the day it was taken', async () => {
    const keys = await keysFor();
    const visitor = own(keys);
    const lateEvening = new Date('2026-03-01T23:59:30Z');
    for (let index = 0; index < ANONYMOUS_ROUNDS_PER_DAY; index += 1) expect((await anonymous.reserveRound(keys, lateEvening)).ok).toBe(true);
    expect((await anonymous.reserveRound(keys, lateEvening)).ok).toBe(false);
    const nextMorning = new Date('2026-03-02T00:00:05Z');
    const fresh = await anonymous.reserveRound(keys, nextMorning);
    expect(fresh).toMatchObject({ ok: true, day: '2026-03-02', quota: { remaining: ANONYMOUS_ROUNDS_PER_DAY - 1 } });
    await anonymous.releaseRound(keys, '2026-03-01');
    expect([...(await roundsOf(visitor, '2026-03-01')).values()]).toEqual([ANONYMOUS_ROUNDS_PER_DAY - 1, ANONYMOUS_ROUNDS_PER_DAY - 1]);
    expect([...(await roundsOf(visitor, '2026-03-02')).values()]).toEqual([1, 1]);
    /* The hourly job drops days before yesterday. */
    await anonymous.clearAnonymousQuota(new Date('2026-03-03T12:00:00Z'));
    expect((await roundsOf(visitor, '2026-03-01')).size).toBe(0);
    expect((await roundsOf(visitor, '2026-03-02')).size).toBe(2);
  });

  it('caps attempts too: rounds given back never return the attempt', async () => {
    const keys = await keysFor();
    const attempts = ANONYMOUS_ROUNDS_PER_DAY * ANONYMOUS_ATTEMPTS_FACTOR;
    for (let index = 0; index < attempts; index += 1) {
      const reserved = await anonymous.reserveRound(keys);
      expect(reserved.ok).toBe(true);
      if (reserved.ok) await anonymous.releaseRound(keys, reserved.day);
    }
    expect([...(await roundsOf(own(keys), anonymousDay())).values()]).toEqual([0, 0]);
    expect(await anonymous.reserveRound(keys)).toMatchObject({ ok: false, scope: 'visitor', quota: { remaining: 0 } });
    expect((await anonymous.anonymousQuota(keys)).remaining).toBe(0);
  });

  it('stores only HMACs of the fingerprint, cookie and address, and counts an IPv6 address by its /64', async () => {
    const raw = fingerprint();
    const reeId = crypto.randomUUID();
    const keys = await anonymous.visitorKeys({ fingerprint: raw, anonymousId: crypto.randomUUID(), ip: '203.0.113.9', reeId });
    expect(keys.map((key) => key.hash.split(':')[0])).toEqual(['fp', 'id', 'ip', 'ree', 'all']);
    expect(keys.map((key) => key.scope)).toEqual(['visitor', 'visitor', 'network', 'ree', 'platform']);
    for (const key of keys.slice(0, 3)) expect(key.hash).not.toContain(raw);
    expect(keys.some((key) => key.hash.includes('203.0.113.9'))).toBe(false);

    const network = async (address: string) => (await anonymous.visitorKeys({ fingerprint: raw, anonymousId: crypto.randomUUID(), ip: address, reeId })).find((key) => key.scope === 'network')!.hash;
    expect(await network('2001:db8:1:2:aaaa::1')).toBe(await network('2001:0db8:0001:0002:ffff:eeee:dddd:1'));
    expect(await network('2001:db8:1:2::1')).not.toBe(await network('2001:db8:1:3::1'));
    expect(await network('::ffff:203.0.113.9')).toBe(await network('203.0.113.9'));
  });
});

describeWithDb('anonymous chat eligibility', () => {
  it('answers only public, published Rees whose query fee is 0, read again on every request', async () => {
    const { reeId } = await freeRee();
    expect((await anonymous.freeReeForAnonymous(reeId))?.id).toBe(reeId);
    const visitor = { fingerprint: fingerprint(), ip: ip() };

    await db().update(schema.ree).set({ queryFee: 5 }).where(eq(schema.ree.id, reeId));
    const paid = await ask(reeId, visitor);
    expect(paid.status).toBe(404);
    expect(await paid.json()).toMatchObject({ error: 'anonymous_unavailable' });
    expect((await quota(reeId, visitor)).status).toBe(404);

    await db().update(schema.ree).set({ queryFee: 0, isPublished: false }).where(eq(schema.ree.id, reeId));
    expect((await ask(reeId, visitor)).status).toBe(404);
    /* Private too. A published Ree is always public, not taken down and not deleted (ree_published_public_check), so unpublished covers those. */
    await db().update(schema.ree).set({ isPublic: false }).where(eq(schema.ree.id, reeId));
    expect((await ask(reeId, visitor)).status).toBe(404);
    await db().update(schema.ree).set({ isPublic: true, isPublished: true }).where(eq(schema.ree.id, reeId));
    expect((await ask(reeId, visitor)).status).toBe(200);
    expect(await anonymous.freeReeForAnonymous('not-a-uuid')).toBeNull();
  });

  it('refuses a request without a fingerprint, without a client address, or from another origin', async () => {
    const { reeId } = await freeRee();
    const missing = await ask(reeId, { ip: ip() });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'fingerprint_required' });
    /* Without an address only keys the client makes up would count. */
    const noAddress = await ask(reeId, { fingerprint: fingerprint(), ip: '' });
    expect(noAddress.status).toBe(400);
    expect(await noAddress.json()).toMatchObject({ error: 'client_ip_required' });
    expect((await quota(reeId, { fingerprint: fingerprint(), ip: '' })).status).toBe(400);
    const foreign = await POST(
      new NextRequest(`${base}/api/rees/${reeId}/anonymous-chat`, { method: 'POST', headers: { origin: 'https://evil.example', host: 'localhost:3000', [FINGERPRINT_HEADER]: fingerprint() }, body: JSON.stringify({ question: QUESTION }) }),
      { params: Promise.resolve({ id: reeId }) },
    );
    expect(foreign.status).toBe(403);
  });
});

describeWithDb('anonymous chat answers', () => {
  it('answers with citations, counts the round, and writes no ledger, hold, conversation or message', async () => {
    const { ownerId, reeId } = await freeRee();
    const visitor = { fingerprint: fingerprint(), ip: ip() };
    const counted = async () => {
      const [entries] = await db().select({ n: count() }).from(schema.creditEntry).where(eq(schema.creditEntry.reeId, reeId));
      const [holds] = await db().select({ n: count() }).from(schema.creditHold).where(eq(schema.creditHold.reeId, reeId));
      const [messages] = await db().select({ n: count() }).from(schema.message).where(eq(schema.message.reeId, reeId));
      const [owned] = await db().select({ n: count() }).from(schema.conversationRee).where(eq(schema.conversationRee.reeId, reeId));
      return { entries: entries!.n, holds: holds!.n, messages: messages!.n, conversations: owned!.n };
    };
    const before = await counted();

    const response = await ask(reeId, visitor);
    expect(response.status).toBe(200);
    const cookie = /re0_anon=([0-9a-f-]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
    expect(cookie).toBeTruthy();
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    const result = await read(response);
    expect(result.text).toContain('14 days');
    expect(result.outcome).toMatchObject({ noAnswer: false, failed: false, cost: 0 });
    expect(result.outcome!.citations.length).toBeGreaterThan(0);
    expect(result.quota).toEqual({ limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: ANONYMOUS_ROUNDS_PER_DAY - 1, blocked: null });

    expect(await counted()).toEqual(before);
    const [answers] = await db().select({ n: count() }).from(schema.anonymousAnswer).where(eq(schema.anonymousAnswer.reeId, reeId));
    expect(answers!.n).toBe(1);
    expect((await answerCounts([reeId], null)).get(reeId)).toBe(1);
    /* The owner earned nothing: the fee is 0 and nobody was charged. */
    const [earned] = await db().select({ n: count() }).from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, ownerId), eq(schema.creditEntry.reason, 'query_fee_earned')));
    expect(earned!.n).toBe(0);

    /* The same browser with its cookie sees the round gone. */
    expect(await (await quota(reeId, { ...visitor, cookie })).json()).toEqual({ limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: ANONYMOUS_ROUNDS_PER_DAY - 1, blocked: null });
  });

  it('gives the round back when there is no answer or the model fails before any text, and keeps it after text was shown', async () => {
    const { reeId } = await freeRee();
    const visitor = { fingerprint: fingerprint(), ip: ip(), cookie: crypto.randomUUID() };

    const outOfScope = await read(await ask(reeId, visitor, 'xylophone zebra quantum gravel'));
    expect(outOfScope.outcome).toMatchObject({ noAnswer: true, reason: 'out_of_scope' });
    expect(outOfScope.quota?.remaining).toBe(ANONYMOUS_ROUNDS_PER_DAY);

    const declined = await read(await ask(reeId, visitor, `${QUESTION} DECLINE`));
    expect(declined.outcome).toMatchObject({ noAnswer: true });
    expect(declined.quota?.remaining).toBe(ANONYMOUS_ROUNDS_PER_DAY);

    const failedEarly = await read(await ask(reeId, visitor, `${QUESTION} FAIL FIRST`));
    expect(failedEarly.text).toBe('');
    expect(failedEarly.outcome).toMatchObject({ failed: true, cost: 0 });
    expect(failedEarly.quota?.remaining).toBe(ANONYMOUS_ROUNDS_PER_DAY);

    const failedLate = await read(await ask(reeId, visitor, `${QUESTION} STREAM ERROR`));
    expect(failedLate.text).not.toBe('');
    expect(failedLate.outcome).toMatchObject({ failed: true });
    expect(failedLate.quota?.remaining).toBe(ANONYMOUS_ROUNDS_PER_DAY - 1);

    /* A short reply that ends on the sentinel is no answer -- but its text was shown, so the round counts. */
    const lateRefusal = await read(await ask(reeId, visitor, `${QUESTION} LATE REFUSAL`));
    expect(lateRefusal.text).not.toBe('');
    expect(lateRefusal.outcome).toMatchObject({ noAnswer: true, reason: 'out_of_scope' });
    expect(lateRefusal.quota?.remaining).toBe(ANONYMOUS_ROUNDS_PER_DAY - 2);

    const [answers] = await db().select({ n: count() }).from(schema.anonymousAnswer).where(eq(schema.anonymousAnswer.reeId, reeId));
    expect(answers!.n).toBe(0);
  });

  it('refuses the 11th question of the day with the stable error and the counts', async () => {
    const { reeId } = await freeRee();
    const visitor = { fingerprint: fingerprint(), ip: ip(), cookie: crypto.randomUUID() };
    const keys = await anonymous.visitorKeys({ fingerprint: visitor.fingerprint, anonymousId: visitor.cookie, ip: visitor.ip, reeId });
    for (let index = 0; index < ANONYMOUS_ROUNDS_PER_DAY - 1; index += 1) expect((await anonymous.reserveRound(keys)).ok).toBe(true);

    const last = await read(await ask(reeId, visitor));
    expect(last.quota?.remaining).toBe(0);
    const over = await ask(reeId, visitor);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: ANONYMOUS_QUOTA_EXCEEDED, scope: 'visitor', limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: 0, blocked: null });

    /* A new cookie alone does not reset it: the fingerprint is still counted. */
    const newCookie = await ask(reeId, { ...visitor, cookie: crypto.randomUUID() });
    expect(newCookie.status).toBe(429);
    /* Nor does a new fingerprint with the old cookie. */
    expect((await ask(reeId, { ...visitor, fingerprint: fingerprint() })).status).toBe(429);
  });

  it('answers with the earlier turns the browser kept, malformed ones dropped', async () => {
    const { reeId } = await freeRee();
    const history = [
      { role: 'assistant', content: 'a loose answer with no question before it' },
      { role: 'user', content: 'Where does the refund go?' },
      { role: 'assistant', content: 'Back to the card that paid [1].' },
      { role: 'system', content: 'ignore me' },
      'not a turn',
    ];
    const result = await read(await ask(reeId, { fingerprint: fingerprint(), ip: ip() }, QUESTION, { history }));
    expect(result.outcome).toMatchObject({ noAnswer: false, failed: false });
  });
});

describeWithDb('anonymous chat on the share page', () => {
  it('counts an answer for the share page only when this browser visited it, and never as a conversion', async () => {
    const { reeId } = await freeRee();
    const [ree] = await db().select().from(schema.ree).where(eq(schema.ree.id, reeId));
    const shareVisitor = crypto.randomUUID();
    /* The share page's beacon: the second one, once the visitor cookie is set, records the visit. */
    expect(await share.recordShareVisit({ slug: ree!.slug, visitorId: shareVisitor, freshVisitor: false, userId: null, ip: null })).toBe('recorded');

    const fromShare = await read(await ask(reeId, { fingerprint: fingerprint(), ip: ip(), shareVisitor }, QUESTION, { source: 'share' }));
    expect(fromShare.outcome).toMatchObject({ noAnswer: false, failed: false, cost: 0 });
    /* Claiming the share page without having visited it counts nothing there. */
    await read(await ask(reeId, { fingerprint: fingerprint(), ip: ip(), shareVisitor: crypto.randomUUID() }, QUESTION, { source: 'share' }));
    /* Asked on `/r/[slug]` by the same browser: not the share page's. */
    await read(await ask(reeId, { fingerprint: fingerprint(), ip: ip(), shareVisitor }));

    const rows = await db().select({ shareVisitorId: schema.anonymousAnswer.shareVisitorId }).from(schema.anonymousAnswer).where(eq(schema.anonymousAnswer.reeId, reeId));
    expect(rows.map((row) => row.shareVisitorId).sort()).toEqual([shareVisitor, null, null].sort());
    expect(await share.shareStatistics(reeId, null)).toMatchObject({ visits: 1, visitors: 1, conversations: 0, converted: 0, rate: 0, anonymousAnswers: 1 });
    expect((await answerCounts([reeId], null)).get(reeId)).toBe(3);
  });

  it('is refused for a paid Ree and once the share link stops working, as on the public page', async () => {
    const { reeId } = await freeRee();
    const [ree] = await db().select().from(schema.ree).where(eq(schema.ree.id, reeId));
    const visitor = { fingerprint: fingerprint(), ip: ip(), shareVisitor: crypto.randomUUID() };
    expect(await share.recordShareVisit({ slug: ree!.slug, visitorId: visitor.shareVisitor, freshVisitor: false, userId: null, ip: null })).toBe('recorded');

    await db().update(schema.ree).set({ queryFee: 3 }).where(eq(schema.ree.id, reeId));
    const paid = await ask(reeId, visitor, QUESTION, { source: 'share' });
    expect(paid.status).toBe(404);
    expect(await paid.json()).toMatchObject({ error: 'anonymous_unavailable' });

    /* A share link has no state of its own: it stops working when the Ree is unpublished or made private. */
    await db().update(schema.ree).set({ queryFee: 0, isPublished: false }).where(eq(schema.ree.id, reeId));
    expect(await publicReeRef(ree!.slug)).toBeNull();
    expect((await ask(reeId, visitor, QUESTION, { source: 'share' })).status).toBe(404);
    await db().update(schema.ree).set({ isPublic: false }).where(eq(schema.ree.id, reeId));
    expect((await ask(reeId, visitor, QUESTION, { source: 'share' })).status).toBe(404);

    const [answers] = await db().select({ n: count() }).from(schema.anonymousAnswer).where(eq(schema.anonymousAnswer.reeId, reeId));
    expect(answers!.n).toBe(0);
  });

  it('shares the daily rounds with the public page', async () => {
    const { reeId } = await freeRee();
    const visitor = { fingerprint: fingerprint(), ip: ip(), cookie: crypto.randomUUID() };
    const keys = await anonymous.visitorKeys({ fingerprint: visitor.fingerprint, anonymousId: visitor.cookie, ip: visitor.ip, reeId });
    for (let index = 0; index < ANONYMOUS_ROUNDS_PER_DAY - 1; index += 1) expect((await anonymous.reserveRound(keys)).ok).toBe(true);
    /* The tenth on `/r/[slug]`, the eleventh on the share page. */
    expect((await read(await ask(reeId, visitor))).quota?.remaining).toBe(0);
    const over = await ask(reeId, visitor, QUESTION, { source: 'share' });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: ANONYMOUS_QUOTA_EXCEEDED, remaining: 0 });
  });
});

describeWithDb('the console overview', () => {
  it('counts anonymous answers in the 30-day answers once, and none from before the window', async () => {
    const { reeId } = await freeRee();
    const administrator = await consoleAdministrator();
    const now = new Date();
    const totals = async () => {
      const overview = await adminOverview(administrator, now);
      return {
        answers: overview.trend.reduce((sum, day) => sum + day.answers, 0),
        anonymous: overview.trend.reduce((sum, day) => sum + day.anonymous, 0),
        earned: overview.earned30,
        revenue: overview.revenue30.usd,
      };
    };
    const before = await totals();
    await db()
      .insert(schema.anonymousAnswer)
      .values([
        { reeId, createdAt: new Date(now.getTime() - 3_600_000) },
        { reeId, createdAt: new Date(now.getTime() - 2 * 86_400_000), shareVisitorId: crypto.randomUUID() },
        /* Before the window. */
        { reeId, createdAt: new Date(now.getTime() - 31 * 86_400_000) },
      ]);
    /* One answered through the endpoint as well: its row counts, and it writes nothing the ledger-based trend reads. */
    await read(await ask(reeId, { fingerprint: fingerprint(), ip: ip() }));
    const after = await totals();
    expect(after.anonymous - before.anonymous).toBe(3);
    expect(after.answers - before.answers).toBe(3);
    /* No fee, no money: the earned and revenue figures do not move. */
    expect(after.earned).toBe(before.earned);
    expect(after.revenue).toBe(before.revenue);
  });
});

describeWithDb('anonymous chat shared limits', () => {
  it('tells a new visitor behind a used-up address so, with their own rounds intact', async () => {
    const { reeId } = await freeRee();
    const address = ip();
    const ipHash = await anonymous.quotaKeyHash('ip', ipBucket(address));
    const restore = await seed(ipHash, ANONYMOUS_IP_ROUNDS_PER_DAY);
    try {
      const visitor = { fingerprint: fingerprint(), ip: address };
      expect(await (await quota(reeId, visitor)).json()).toEqual({ limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: ANONYMOUS_ROUNDS_PER_DAY, blocked: 'network' });
      const refused = await ask(reeId, visitor);
      expect(refused.status).toBe(429);
      expect(await refused.json()).toEqual({ error: ANONYMOUS_NETWORK_LIMIT, scope: 'network', limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: ANONYMOUS_ROUNDS_PER_DAY, blocked: 'network' });
    } finally {
      await restore();
    }
  });

  it('stops a Ree at its daily cap and the platform at its own, with the capacity code', async () => {
    const { reeId } = await freeRee();
    const visitor = { fingerprint: fingerprint(), ip: ip() };
    const restoreRee = await seed(`ree:${reeId}`, ANONYMOUS_REE_ROUNDS_PER_DAY);
    try {
      const refused = await ask(reeId, visitor);
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ error: ANONYMOUS_CAPACITY_REACHED, scope: 'ree', blocked: 'capacity', remaining: ANONYMOUS_ROUNDS_PER_DAY });
      expect(await (await quota(reeId, visitor)).json()).toMatchObject({ blocked: 'capacity' });
    } finally {
      await restoreRee();
    }
    /* Another free Ree is not affected by that one's cap. */
    const other = await freeRee();
    expect((await ask(other.reeId, { fingerprint: fingerprint(), ip: ip() })).status).toBe(200);

    const restorePlatform = await seed('all:', ANONYMOUS_PLATFORM_ROUNDS_PER_DAY);
    try {
      const refused = await ask(other.reeId, { fingerprint: fingerprint(), ip: ip() });
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ error: ANONYMOUS_CAPACITY_REACHED, scope: 'platform', blocked: 'capacity' });
    } finally {
      await restorePlatform();
    }
  });
});

describeWithDb('where anonymous answers are counted', () => {
  it('in the owner’s statistics, list and trend, never in the public count or its order', async () => {
    const { ownerId, reeId } = await freeRee();
    const [ree] = await db().select().from(schema.ree).where(eq(schema.ree.id, reeId));
    await read(await ask(reeId, { fingerprint: fingerprint(), ip: ip() }));

    /* The public count (and MCP's, and the "most answered" order) leaves them out: anyone can ask for them. */
    expect((await publicReeBySlug(ree!.slug))!.answers).toBe(0);
    /* The owner's own list and statistics count them. */
    const listed = await rees.listRees(ownerId, { q: '', visibility: 'all', sort: 'answers_desc', size: 12, page: 1 });
    expect(listed.items.find((item) => item.id === reeId)?.answers).toBe(1);
    const today = await reeStatistics(reeId, statisticsQuery({ period: 'day' }), { withIncome: true });
    expect(today.answers).toBe(1);
    expect(today.trend!.bars.reduce((sum, bar) => sum + bar.value, 0)).toBe(1);
  });

  it('on the share page within the period asked for', async () => {
    const { reeId } = await freeRee();
    const visitorId = crypto.randomUUID();
    await db()
      .insert(schema.anonymousAnswer)
      .values([
        { reeId, shareVisitorId: visitorId },
        { reeId, shareVisitorId: visitorId, createdAt: new Date(Date.now() - 40 * 86_400_000) },
        { reeId },
      ]);
    expect((await share.shareStatistics(reeId, null)).anonymousAnswers).toBe(2);
    const day = await reeStatistics(reeId, statisticsQuery({ period: 'day' }), { withIncome: true });
    expect(day.share.anonymousAnswers).toBe(1);
  });
});

describeWithDb('caps set in the console', () => {
  const reset = async () => {
    await db().delete(schema.anonymousChatSettings);
    settings.forgetAnonymousChatLimits();
  };
  const defaults = () => ({
    visitorRoundsPerDay: ANONYMOUS_ROUNDS_PER_DAY,
    reeRoundsPerDay: ANONYMOUS_REE_ROUNDS_PER_DAY,
    platformRoundsPerDay: ANONYMOUS_PLATFORM_ROUNDS_PER_DAY,
    ipRoundsPerDay: ANONYMOUS_IP_ROUNDS_PER_DAY,
    attemptsFactor: ANONYMOUS_ATTEMPTS_FACTOR,
  });

  it('uses the defaults until an administrator saves', async () => {
    await reset();
    expect(await settings.anonymousChatLimits()).toEqual({
      visitorRoundsPerDay: ANONYMOUS_ROUNDS_PER_DAY,
      reeRoundsPerDay: ANONYMOUS_REE_ROUNDS_PER_DAY,
      platformRoundsPerDay: ANONYMOUS_PLATFORM_ROUNDS_PER_DAY,
      ipRoundsPerDay: ANONYMOUS_IP_ROUNDS_PER_DAY,
      attemptsFactor: ANONYMOUS_ATTEMPTS_FACTOR,
      revision: 'default',
    });
    const keys = await keysFor();
    expect(keys.map((key) => [key.scope, key.limit, key.attempts])).toEqual([
      ['visitor', ANONYMOUS_ROUNDS_PER_DAY, ANONYMOUS_ROUNDS_PER_DAY * ANONYMOUS_ATTEMPTS_FACTOR],
      ['visitor', ANONYMOUS_ROUNDS_PER_DAY, ANONYMOUS_ROUNDS_PER_DAY * ANONYMOUS_ATTEMPTS_FACTOR],
      ['network', ANONYMOUS_IP_ROUNDS_PER_DAY, ANONYMOUS_IP_ROUNDS_PER_DAY * ANONYMOUS_ATTEMPTS_FACTOR],
      ['ree', ANONYMOUS_REE_ROUNDS_PER_DAY, ANONYMOUS_REE_ROUNDS_PER_DAY * ANONYMOUS_ATTEMPTS_FACTOR],
      ['platform', ANONYMOUS_PLATFORM_ROUNDS_PER_DAY, ANONYMOUS_PLATFORM_ROUNDS_PER_DAY * ANONYMOUS_ATTEMPTS_FACTOR],
    ]);
  });

  it('enforces a saved per-Ree cap at once, audited, and returns to the defaults without a row', async () => {
    await reset();
    const administrator = await consoleAdministrator();
    const { reeId } = await freeRee();
    try {
      const saved = await settings.saveAnonymousChatLimits(administrator.id, { ...defaults(), revision: 'default', reeRoundsPerDay: 2 });
      expect(saved).toMatchObject({ reeRoundsPerDay: 2 });
      expect(saved.revision).not.toBe('default');
      const [entry] = await db().select().from(schema.adminAudit).where(and(eq(schema.adminAudit.action, 'anonymous_chat.update'), eq(schema.adminAudit.administratorId, administrator.id)));
      expect(entry).toMatchObject({ target: 'limits', after: { reeRoundsPerDay: 2 } });

      for (let index = 0; index < 2; index += 1) expect((await read(await ask(reeId, { fingerprint: fingerprint(), ip: ip() }))).outcome).toMatchObject({ noAnswer: false });
      const third = await ask(reeId, { fingerprint: fingerprint(), ip: ip() });
      expect(third.status).toBe(429);
      expect(await third.json()).toMatchObject({ error: ANONYMOUS_CAPACITY_REACHED, scope: 'ree', blocked: 'capacity' });

      /* A stale form is refused rather than overwriting a newer save. */
      await expect(settings.saveAnonymousChatLimits(administrator.id, { ...defaults(), revision: 'default', reeRoundsPerDay: 9 })).rejects.toMatchObject({ code: 'pricing_conflict' });
    } finally {
      await reset();
    }
    expect((await ask(reeId, { fingerprint: fingerprint(), ip: ip() })).status).toBe(200);
  });

  it('rejects caps that are not whole numbers from 1 to the maximum', async () => {
    await reset();
    const administrator = await consoleAdministrator();
    const valid = { ...defaults(), revision: 'default' };
    for (const bad of [
      { reeRoundsPerDay: 0 },
      { platformRoundsPerDay: 1.5 },
      { ipRoundsPerDay: '100' },
      { ipRoundsPerDay: 10_000_001 },
      { platformRoundsPerDay: undefined },
      { visitorRoundsPerDay: 0 },
      { visitorRoundsPerDay: 1_001 },
      { attemptsFactor: 0 },
      { attemptsFactor: 1.5 },
      { attemptsFactor: 11 },
      { attemptsFactor: undefined },
      { revision: undefined },
    ]) {
      const attempt = settings.saveAnonymousChatLimits(administrator.id, { ...valid, ...bad });
      await expect(attempt).rejects.toBeInstanceOf(AdminInputError);
      await expect(attempt).rejects.toMatchObject({ code: 'invalid_anonymous_limits' });
    }
    expect(await db().select().from(schema.anonymousChatSettings)).toHaveLength(0);
  });

  it('enforces a saved per-browser count, reports it as the limit, and never shows less than 0 once lowered', async () => {
    await reset();
    const administrator = await consoleAdministrator();
    const { reeId } = await freeRee();
    const visitor = { fingerprint: fingerprint(), ip: ip(), cookie: crypto.randomUUID() };
    try {
      const saved = await settings.saveAnonymousChatLimits(administrator.id, { ...defaults(), revision: 'default', visitorRoundsPerDay: 3 });
      expect(await (await quota(reeId, visitor)).json()).toEqual({ limit: 3, remaining: 3, blocked: null });
      for (let index = 0; index < 3; index += 1) expect((await read(await ask(reeId, visitor))).quota).toMatchObject({ limit: 3, remaining: 2 - index });
      const fourth = await ask(reeId, visitor);
      expect(fourth.status).toBe(429);
      expect(await fourth.json()).toEqual({ error: ANONYMOUS_QUOTA_EXCEEDED, scope: 'visitor', limit: 3, remaining: 0, blocked: null });

      /* Lowered under what this visitor already used today: nothing left, never a negative count. */
      await settings.saveAnonymousChatLimits(administrator.id, { ...defaults(), revision: saved.revision, visitorRoundsPerDay: 2 });
      expect(await (await quota(reeId, visitor)).json()).toEqual({ limit: 2, remaining: 0, blocked: null });
      expect(await (await ask(reeId, visitor)).json()).toMatchObject({ error: ANONYMOUS_QUOTA_EXCEEDED, limit: 2, remaining: 0 });
    } finally {
      await reset();
    }
  });

  it('applies a saved attempts factor: at 1, refunds cannot be retried beyond the rounds', async () => {
    await reset();
    const administrator = await consoleAdministrator();
    try {
      await settings.saveAnonymousChatLimits(administrator.id, { ...defaults(), revision: 'default', visitorRoundsPerDay: 3, attemptsFactor: 1 });
      const keys = await keysFor();
      expect(keys.filter((key) => key.scope === 'visitor').map((key) => [key.limit, key.attempts])).toEqual([[3, 3], [3, 3]]);
      for (let index = 0; index < 3; index += 1) {
        const reserved = await anonymous.reserveRound(keys);
        expect(reserved.ok).toBe(true);
        if (reserved.ok) await anonymous.releaseRound(keys, reserved.day);
      }
      expect([...(await roundsOf(own(keys), anonymousDay())).values()]).toEqual([0, 0]);
      expect(await anonymous.reserveRound(keys)).toMatchObject({ ok: false, scope: 'visitor', quota: { limit: 3, remaining: 0 } });
    } finally {
      await reset();
    }
  });

  it('is saved only by a signed-in administrator', async () => {
    await reset();
    const response = await pricingRoute.PUT(
      new NextRequest(`${base}/api/admin/pricing`, {
        method: 'PUT',
        headers: { origin: base, host: 'localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'anonymous_chat', revision: 'default', visitorRoundsPerDay: 1, reeRoundsPerDay: 1, platformRoundsPerDay: 1, ipRoundsPerDay: 1, attemptsFactor: 1 }),
      }),
    );
    expect(response.status).toBe(401);
    expect(await db().select().from(schema.anonymousChatSettings)).toHaveLength(0);
  });

  it('reaches other servers within the cache window', async () => {
    await reset();
    const at = Date.now();
    expect((await settings.currentAnonymousChatLimits(at)).reeRoundsPerDay).toBe(ANONYMOUS_REE_ROUNDS_PER_DAY);
    /* Saved by another server: this one's cache still holds the old caps for a while. */
    await db().insert(schema.anonymousChatSettings).values({ reeRoundsPerDay: 7, platformRoundsPerDay: 70, ipRoundsPerDay: 700 });
    try {
      expect((await settings.currentAnonymousChatLimits(at + 1_000)).reeRoundsPerDay).toBe(ANONYMOUS_REE_ROUNDS_PER_DAY);
      expect(await settings.currentAnonymousChatLimits(at + ANONYMOUS_LIMITS_CACHE_MS)).toMatchObject({ reeRoundsPerDay: 7, platformRoundsPerDay: 70, ipRoundsPerDay: 700 });
    } finally {
      await reset();
    }
  });
});

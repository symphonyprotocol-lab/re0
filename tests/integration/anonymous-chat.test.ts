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

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const anonymous = await import('@/lib/services/anonymous-chat');
const { answerCounts } = await import('@/lib/services/statistics');
const { GET, POST } = await import('@/app/api/rees/[id]/anonymous-chat/route');
const { ANONYMOUS_IP_ROUNDS_PER_DAY, ANONYMOUS_ROUNDS_PER_DAY } = await import('@/lib/constants');
const { ANONYMOUS_ID_COOKIE, ANONYMOUS_QUOTA_EXCEEDED, FINGERPRINT_HEADER } = await import('@/lib/domain/anonymous-chat');
const { db, schema } = await import('@/lib/infra/db');
const share = await import('@/lib/services/share');
const { publicReeRef } = await import('@/lib/services/public-rees');
const { VISITOR_COOKIE } = await import('@/lib/http/share');
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
  const headers: Record<string, string> = { origin: base, host: 'localhost:3000', 'x-real-ip': visitor.ip, 'content-type': 'application/json' };
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
    quota: events.find((event) => event.type === 'data-quota')?.data as { limit: number; remaining: number } | undefined,
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

describeWithDb('anonymous chat quota', () => {
  it('never lets concurrent requests take a key past its daily limit', async () => {
    const keys = await anonymous.visitorKeys({ fingerprint: fingerprint(), anonymousId: crypto.randomUUID(), ip: null });
    const results = await Promise.all(Array.from({ length: 25 }, () => anonymous.reserveRound(keys)));
    expect(results.filter((result) => result.ok)).toHaveLength(ANONYMOUS_ROUNDS_PER_DAY);
    const day = new Date().toISOString().slice(0, 10);
    const rounds = await roundsOf(keys.map((key) => key.hash), day);
    expect([...rounds.values()]).toEqual([ANONYMOUS_ROUNDS_PER_DAY, ANONYMOUS_ROUNDS_PER_DAY]);
    expect(Math.min(...results.flatMap((result) => (result.ok ? [result.quota.remaining] : [])))).toBe(0);
    expect(await anonymous.anonymousQuota(keys)).toEqual({ limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: 0 });
  });

  it('caps one address across fingerprints, and takes nothing on the other keys when one is full', async () => {
    const address = ip();
    const visitors = await Promise.all(Array.from({ length: 6 }, () => anonymous.visitorKeys({ fingerprint: fingerprint(), anonymousId: crypto.randomUUID(), ip: address })));
    const results = await Promise.all(visitors.flatMap((keys) => Array.from({ length: ANONYMOUS_ROUNDS_PER_DAY }, () => anonymous.reserveRound(keys))));
    expect(results.filter((result) => result.ok)).toHaveLength(ANONYMOUS_IP_ROUNDS_PER_DAY);
    const day = new Date().toISOString().slice(0, 10);
    const rounds = await roundsOf(visitors.flat().map((key) => key.hash), day);
    const ipHash = visitors[0]!.at(-1)!.hash;
    expect(rounds.get(ipHash)).toBe(ANONYMOUS_IP_ROUNDS_PER_DAY);
    /* A refused round took nothing on the fingerprint and cookie keys: they add up to what the address let through. */
    const personal = visitors.flatMap((keys) => keys.slice(0, 2)).map((key) => rounds.get(key.hash) ?? 0);
    expect(personal.reduce((sum, value) => sum + value, 0)).toBe(ANONYMOUS_IP_ROUNDS_PER_DAY * 2);
  });

  it('starts again on the next UTC day, and gives a round back on the day it was taken', async () => {
    const keys = await anonymous.visitorKeys({ fingerprint: fingerprint(), anonymousId: crypto.randomUUID(), ip: null });
    const lateEvening = new Date('2026-03-01T23:59:30Z');
    for (let index = 0; index < ANONYMOUS_ROUNDS_PER_DAY; index += 1) expect((await anonymous.reserveRound(keys, lateEvening)).ok).toBe(true);
    expect((await anonymous.reserveRound(keys, lateEvening)).ok).toBe(false);
    const nextMorning = new Date('2026-03-02T00:00:05Z');
    const fresh = await anonymous.reserveRound(keys, nextMorning);
    expect(fresh).toMatchObject({ ok: true, day: '2026-03-02', quota: { remaining: ANONYMOUS_ROUNDS_PER_DAY - 1 } });
    await anonymous.releaseRound(keys, '2026-03-01');
    expect([...(await roundsOf(keys.map((key) => key.hash), '2026-03-01')).values()]).toEqual([ANONYMOUS_ROUNDS_PER_DAY - 1, ANONYMOUS_ROUNDS_PER_DAY - 1]);
    expect([...(await roundsOf(keys.map((key) => key.hash), '2026-03-02')).values()]).toEqual([1, 1]);
    /* The hourly job drops days before yesterday. */
    await anonymous.clearAnonymousQuota(new Date('2026-03-03T12:00:00Z'));
    expect((await roundsOf(keys.map((key) => key.hash), '2026-03-01')).size).toBe(0);
    expect((await roundsOf(keys.map((key) => key.hash), '2026-03-02')).size).toBe(2);
  });

  it('stores only HMACs of the fingerprint, cookie and address', async () => {
    const raw = fingerprint();
    const keys = await anonymous.visitorKeys({ fingerprint: raw, anonymousId: crypto.randomUUID(), ip: '203.0.113.9' });
    expect(keys.map((key) => key.hash.split(':')[0])).toEqual(['fp', 'id', 'ip']);
    for (const key of keys) expect(key.hash).not.toContain(raw);
    expect(keys.some((key) => key.hash.includes('203.0.113.9'))).toBe(false);
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

  it('refuses a request without a fingerprint, or from another origin', async () => {
    const { reeId } = await freeRee();
    const missing = await ask(reeId, { ip: ip() });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'fingerprint_required' });
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
    expect(result.quota).toEqual({ limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: ANONYMOUS_ROUNDS_PER_DAY - 1 });

    expect(await counted()).toEqual(before);
    const [answers] = await db().select({ n: count() }).from(schema.anonymousAnswer).where(eq(schema.anonymousAnswer.reeId, reeId));
    expect(answers!.n).toBe(1);
    expect((await answerCounts([reeId], null)).get(reeId)).toBe(1);
    /* The owner earned nothing: the fee is 0 and nobody was charged. */
    const [earned] = await db().select({ n: count() }).from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, ownerId), eq(schema.creditEntry.reason, 'query_fee_earned')));
    expect(earned!.n).toBe(0);

    /* The same browser with its cookie sees the round gone. */
    expect(await (await quota(reeId, { ...visitor, cookie })).json()).toEqual({ limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: ANONYMOUS_ROUNDS_PER_DAY - 1 });
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

    const [answers] = await db().select({ n: count() }).from(schema.anonymousAnswer).where(eq(schema.anonymousAnswer.reeId, reeId));
    expect(answers!.n).toBe(0);
  });

  it('refuses the 11th question of the day with the stable error and the counts', async () => {
    const { reeId } = await freeRee();
    const visitor = { fingerprint: fingerprint(), ip: ip(), cookie: crypto.randomUUID() };
    const keys = await anonymous.visitorKeys({ fingerprint: visitor.fingerprint, anonymousId: visitor.cookie, ip: visitor.ip });
    for (let index = 0; index < ANONYMOUS_ROUNDS_PER_DAY - 1; index += 1) expect((await anonymous.reserveRound(keys)).ok).toBe(true);

    const last = await read(await ask(reeId, visitor));
    expect(last.quota?.remaining).toBe(0);
    const over = await ask(reeId, visitor);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: ANONYMOUS_QUOTA_EXCEEDED, limit: ANONYMOUS_ROUNDS_PER_DAY, remaining: 0 });

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
    const keys = await anonymous.visitorKeys({ fingerprint: visitor.fingerprint, anonymousId: visitor.cookie, ip: visitor.ip });
    for (let index = 0; index < ANONYMOUS_ROUNDS_PER_DAY - 1; index += 1) expect((await anonymous.reserveRound(keys)).ok).toBe(true);
    /* The tenth on `/r/[slug]`, the eleventh on the share page. */
    expect((await read(await ask(reeId, visitor))).quota?.remaining).toBe(0);
    const over = await ask(reeId, visitor, QUESTION, { source: 'share' });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: ANONYMOUS_QUOTA_EXCEEDED, remaining: 0 });
  });
});

/**
 * Per-answer billing of public posts (the user's choice, 2026-11-19):
 * posting costs nothing; each free Ree of someone else answers at once for
 * the author's base fee, most relevant first, and one the balance cannot
 * cover waits for the author to agree; a paid Ree answers only once the
 * author agrees (the user's rule), for the base fee plus its query fee,
 * which goes to its owner. Each answer settles once: charged when it
 * answered, given back when it did not. The author's own Rees and RE0's
 * example posts charge nobody.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { NextRequest } from 'next/server';
import { inArray } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { PostInput, ProcessDeps } from '@/lib/services/posts';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let token: string | undefined;
const later: (() => unknown)[] = [];
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 're0_session' && token ? { value: token } : undefined) }),
  headers: async () => new Headers(),
}));
/* The route's background answer runs when the test says so. */
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: (task: () => unknown) => void later.push(task) }));

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const posts = await import('@/lib/services/posts');
const { listPublicQa } = await import('@/lib/services/public-qa');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { POST: reportPostRoute } = await import('@/app/api/posts/[id]/report/route');
const { publishOwnAnswer } = await import('@/lib/services/public-qa');
const { reeCards } = await import('@/lib/services/explore');
const { consoleAdministrator } = await import('../fixtures/console-administrator');
const writes = {
  publish: (await import('@/app/api/posts/route')).POST,
  summary: (await import('@/app/api/posts/[id]/summary/route')).POST,
  followUp: (await import('@/app/api/posts/[id]/follow-up/route')).POST,
  save: (await import('@/app/api/posts/[id]/save/route')).POST,
  trash: (await import('@/app/api/posts/[id]/route')).PATCH,
  helpful: (await import('@/app/api/posts/answers/[answerId]/helpful/route')).POST,
};

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  await fake?.close();
});

async function user(prefix: string, credits = 0) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  /* A known balance: whatever sign-up gave, then exactly `credits`. */
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
  if (credits > 0) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

/** A public, published Ree with ready knowledge about refunds; free unless a fee is given. */
async function publicRee(queryFee = 0) {
  /* Adding knowledge holds credits. */
  const ownerId = await user('post-owner', 1_000);
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Refund desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, {
    kind: 'text',
    title: 'Refund policy',
    content: 'Refunds are issued to the original payment method within 14 days of the request. The refund goes back to the card or account that paid.',
  });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true, queryFee }).where(eq(schema.ree.id, ree.id));
  return { ownerId, reeId: ree.id };
}

const QUESTION = 'When are refunds issued to the original payment method?';
const approve = async () => ({ publish: true });

/** Answers from the given Rees, without a search or a model. */
function stub(reeIds: string[], answered = true): ProcessDeps {
  return {
    judge: approve,
    match: async () => ({ answerers: reeIds.map((reeId) => ({ reeId, similarity: 0.8, mentioned: false })), candidates: reeIds.length + 2, skipped: 2, vector: null }),
    answerOne: async () => (answered ? { state: 'answered', text: 'Within 14 days [1].', citations: [], model: 'stub' } : { state: 'no_answer', model: 'stub' }),
  };
}

async function postRow(id: string) {
  const [row] = await db().select().from(schema.post).where(eq(schema.post.id, id));
  return row!;
}

async function publish(userId: string, question = QUESTION, extra: Partial<PostInput> = {}) {
  const result = await posts.publishPost(userId, { question, lang: 'en', ...extra });
  if (!result.ok) throw new Error(result.error);
  return result;
}

const { POST_PAID_ANSWER_STALE_MS } = await import('@/lib/domain/post');
const { QUERY_BASE_FEE } = await import('@/lib/constants');
const { planSeedPosts, applySeedPosts } = await import('@/lib/services/seed-posts');
const { POST: requestRoute } = await import('@/app/api/posts/answers/[answerId]/request/route');
const { sessionTokenHash } = await import('@/lib/services/auth');

const FEE_20 = 20;
const BASE = QUERY_BASE_FEE;
const answered = (text = 'Within 14 days [1].') => async () => ({ state: 'answered' as const, text, citations: [], model: 'stub' });

/** A post by `author` matched to the given Rees, in this order; records which were asked to answer at once. */
async function matched(author: string, reeIds: string[], question = `${QUESTION} ${crypto.randomUUID()}`) {
  const posted = await publish(author, question);
  const asked: string[] = [];
  await posts.processPost(posted.id, {
    judge: approve,
    match: async () => ({ answerers: reeIds.map((reeId, index) => ({ reeId, similarity: 0.9 - index / 100, mentioned: false })), candidates: reeIds.length, skipped: 0, vector: null }),
    answerOne: async ({ reeId }) => {
      asked.push(reeId);
      return { state: 'answered', text: 'Within 14 days [1].', citations: [], model: 'stub' };
    },
  });
  return { postId: posted.id, asked };
}

async function requestOf(postId: string, reeId: string) {
  const [row] = await db().select().from(schema.postAnswer).where(and(eq(schema.postAnswer.postId, postId), eq(schema.postAnswer.reeId, reeId)));
  return row!;
}

async function paidRee(fee = FEE_20) {
  const made = await publicRee(fee);
  await db().update(schema.ree).set({ answersPosts: true }).where(eq(schema.ree.id, made.reeId));
  return made;
}

const topUp = (userId: string, amount: number) => db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount, reason: 'admin_adjust', refId: crypto.randomUUID() }));

describeWithDb('public posts are charged per answer', () => {
  it('charges each free answer the base fee and asks before a paid Ree, which then pays its owner the query fee', async () => {
    const free = await publicRee();
    const paid = await paidRee();
    const author = await user('pp-author', 1_000);
    const post = await matched(author, [free.reeId, paid.reeId]);
    expect(post.asked).toEqual([free.reeId]);
    expect(await balanceOf(db(), author)).toBe(1_000 - BASE);
    expect((await requestOf(post.postId, paid.reeId)).state).toBe('awaiting');

    /* Others see the one answer and no request; the author sees the request at base fee + query fee, and what they spent. */
    for (const viewer of [undefined, await user('pp-other', 0)]) {
      const view = (await posts.getPost(post.postId, viewer))!;
      expect(view.answered).toBe(1);
      expect(view.answers.map((entry) => entry.reeId)).toEqual([free.reeId]);
      expect(view.paidRequests).toEqual([]);
      expect(view.spent).toBeNull();
    }
    const mine = (await posts.getPost(post.postId, author))!;
    expect(mine.paidRequests).toMatchObject([{ reeId: paid.reeId, price: BASE + FEE_20, state: 'awaiting' }]);
    expect(mine.spent).toBe(BASE);
    const notices = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.kind, 'post_paid_requests')));
    expect(notices).toMatchObject([{ refId: post.postId, params: { n: 1 } }]);

    /* A price above the one shown is refused with the new one; nobody else can agree. */
    const requestId = mine.paidRequests[0]!.id;
    expect(await posts.agreePaidAnswer(author, requestId, BASE)).toEqual({ ok: false, error: 'price_changed', price: BASE + FEE_20 });
    expect(await posts.agreePaidAnswer(await user('pp-stranger', 1_000), requestId, 999)).toEqual({ ok: false, error: 'not_found' });

    const ownerBefore = await balanceOf(db(), paid.ownerId);
    expect(await posts.agreePaidAnswer(author, requestId, BASE + FEE_20)).toEqual({ ok: true });
    expect(await balanceOf(db(), author)).toBe(1_000 - BASE - BASE - FEE_20);
    await posts.answerPaid(requestId, { answerOne: answered() });
    expect(await balanceOf(db(), author)).toBe(1_000 - BASE - BASE - FEE_20);
    expect(await balanceOf(db(), paid.ownerId)).toBe(ownerBefore + FEE_20);
    const earned = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, paid.ownerId), eq(schema.creditEntry.reason, 'query_fee_earned'), eq(schema.creditEntry.refId, requestId)));
    expect(earned.reduce((sum, entry) => sum + entry.delta, 0)).toBe(FEE_20);
    expect(await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.reason, 'query_base'), eq(schema.creditEntry.refId, requestId)))).toHaveLength(1);
    /* The free Ree's owner earns nothing. */
    expect(await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, free.ownerId), eq(schema.creditEntry.reason, 'query_fee_earned')))).toHaveLength(0);

    const view = (await posts.getPost(post.postId, author))!;
    expect(view.answered).toBe(2);
    expect(view.answers.find((entry) => entry.reeId === paid.reeId)).toMatchObject({ paid: true, state: 'answered' });
    expect(view.answers.find((entry) => entry.reeId === free.reeId)).toMatchObject({ paid: false });
    expect(view.paidRequests).toEqual([]);
    expect(view.spent).toBe(BASE + BASE + FEE_20);
    expect(await posts.agreePaidAnswer(author, requestId, 999)).toEqual({ ok: false, error: 'already' });
  });

  it('answers the free Rees the balance covers, most relevant first, and asks before the rest; agreeing later charges the base fee', async () => {
    const free = [await publicRee(), await publicRee(), await publicRee()];
    const author = await user('pp-short', BASE + 10);
    const post = await matched(author, free.map((entry) => entry.reeId));
    /* Only the closest one fitted. */
    expect(post.asked).toEqual([free[0]!.reeId]);
    expect(await balanceOf(db(), author)).toBe(10);
    const requests = (await posts.getPost(post.postId, author))!.paidRequests;
    expect(requests.map((entry) => ({ reeId: entry.reeId, price: entry.price, state: entry.state }))).toEqual([
      { reeId: free[1]!.reeId, price: BASE, state: 'awaiting' },
      { reeId: free[2]!.reeId, price: BASE, state: 'awaiting' },
    ]);
    expect(await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.kind, 'post_paid_requests')))).toMatchObject([{ params: { n: 2 } }]);
    expect(await posts.agreePaidAnswer(author, requests[0]!.id, BASE)).toEqual({ ok: false, error: 'insufficient', balance: 10, needed: BASE });

    await topUp(author, BASE);
    expect(await posts.agreePaidAnswer(author, requests[0]!.id, BASE)).toEqual({ ok: true });
    await posts.answerPaid(requests[0]!.id, { answerOne: answered() });
    expect(await balanceOf(db(), author)).toBe(10);
    const row = await requestOf(post.postId, free[1]!.reeId);
    expect(row).toMatchObject({ state: 'answered', price: BASE, feeHoldId: null });
    /* A free Ree's answer agreed to later is not a paid one. */
    expect((await posts.getPost(post.postId))!.answers.find((entry) => entry.reeId === free[1]!.reeId)).toMatchObject({ paid: false });
  });

  it('charges nobody for the author\'s own Rees, free or paid, nor on RE0\'s example posts', async () => {
    const author = await user('pp-own', BASE);
    const ownFree = await publicRee();
    const ownPaid = await paidRee();
    await db().update(schema.ree).set({ ownerId: author }).where(inArray(schema.ree.id, [ownFree.reeId, ownPaid.reeId]));
    const post = await matched(author, [ownFree.reeId, ownPaid.reeId]);
    expect(post.asked.sort()).toEqual([ownFree.reeId, ownPaid.reeId].sort());
    expect(await balanceOf(db(), author)).toBe(BASE);
    for (const reeId of [ownFree.reeId, ownPaid.reeId]) expect(await requestOf(post.postId, reeId)).toMatchObject({ state: 'answered', baseHoldId: null, price: null });

    /* Example posts: free Rees only, and nobody is charged. */
    const paid = await paidRee();
    const marker = `Example ${crypto.randomUUID()}?`;
    await db().update(schema.ree).set({ sampleQuestions: [marker] }).where(eq(schema.ree.id, paid.reeId));
    expect((await planSeedPosts({ perCategory: 1_000 })).map((entry) => entry.question)).not.toContain(marker);
    const free = await publicRee();
    const question = `Seed ${crypto.randomUUID()}?`;
    await applySeedPosts([{ reeId: free.reeId, reeName: 'x', category: 'business', question, lang: 'en' }], {
      judge: approve,
      match: async () => ({ answerers: [{ reeId: free.reeId, similarity: 0.9, mentioned: true }, { reeId: paid.reeId, similarity: 0.8, mentioned: false }], candidates: 2, skipped: 0, vector: null }),
      answerOne: answered(),
    });
    const [seed] = await db().select().from(schema.post).where(eq(schema.post.question, question));
    const rows = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, seed!.id));
    expect(rows.map((entry) => ({ reeId: entry.reeId, state: entry.state, hold: entry.baseHoldId }))).toEqual([{ reeId: free.reeId, state: 'answered', hold: null }]);
  });

  it('gives an agreed answer that could not be given everything back, lets the author agree again, and says already for a second tab', async () => {
    const paid = await paidRee();
    const price = BASE + FEE_20;
    const author = await user('pp-retry', price * 2);
    const post = await matched(author, [paid.reeId]);
    expect(await balanceOf(db(), author)).toBe(price * 2);
    const [request] = (await posts.getPost(post.postId, author))!.paidRequests;

    const [one, two] = await Promise.all([posts.agreePaidAnswer(author, request!.id, price), posts.agreePaidAnswer(author, request!.id, price)]);
    expect([one, two]).toEqual(expect.arrayContaining([{ ok: true }, { ok: false, error: 'already' }]));
    expect(await balanceOf(db(), author)).toBe(price);

    /* The background answer never ran: the sweep gives everything back, once. */
    await posts.sweepPaidRequests(new Date(Date.now() + POST_PAID_ANSWER_STALE_MS + 60_000));
    await posts.sweepPaidRequests(new Date(Date.now() + POST_PAID_ANSWER_STALE_MS + 60_000));
    expect(await balanceOf(db(), author)).toBe(price * 2);
    expect((await posts.getPost(post.postId, author))!.paidRequests).toMatchObject([{ id: request!.id, state: 'refunded', price }]);

    /* Again, this time it finds no answer: refunded again; then it answers. */
    expect(await posts.agreePaidAnswer(author, request!.id, price)).toEqual({ ok: true });
    await posts.answerPaid(request!.id, { answerOne: async () => ({ state: 'no_answer', model: 'stub' }) });
    expect(await balanceOf(db(), author)).toBe(price * 2);
    expect(await posts.agreePaidAnswer(author, request!.id, price)).toEqual({ ok: true });
    await posts.answerPaid(request!.id, { answerOne: answered() });
    expect(await balanceOf(db(), author)).toBe(price);
    expect((await posts.getPost(post.postId))!.answers).toMatchObject([{ reeId: paid.reeId, paid: true }]);

    /* A refunded one can also be declined; a plain request too. */
    const other = await paidRee();
    const second = await matched(author, [other.reeId]);
    const [again] = (await posts.getPost(second.postId, author))!.paidRequests;
    expect(await posts.agreePaidAnswer(author, again!.id, price)).toEqual({ ok: true });
    await posts.answerPaid(again!.id, { answerOne: async () => ({ state: 'failed', model: 'stub' }) });
    expect((await posts.getPost(second.postId, author))!.paidRequests).toMatchObject([{ state: 'refunded' }]);
    expect(await posts.declinePaidAnswer(author, again!.id)).toBe(true);
    expect(await posts.declinePaidAnswer(author, again!.id)).toBe(false);
    expect((await posts.getPost(second.postId, author))!.paidRequests).toEqual([]);
    expect(await balanceOf(db(), author)).toBe(price);
  });

  it('closes a request whose Ree goes private, stops answering posts or is deleted, and keeps one that turned free (it costs the base fee)', async () => {
    const author = await user('pp-gone', 1_000);
    const hidden = await paidRee();
    const off = await paidRee();
    const deleted = await paidRee();
    const nowFree = await paidRee();
    const post = await matched(author, [hidden.reeId, off.reeId, deleted.reeId, nowFree.reeId]);
    expect(await balanceOf(db(), author)).toBe(1_000);
    const requests = (await posts.getPost(post.postId, author))!.paidRequests;
    const idOf = (reeId: string) => requests.find((entry) => entry.reeId === reeId)!.id;

    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, hidden.reeId));
    expect(await posts.agreePaidAnswer(author, idOf(hidden.reeId), 999)).toEqual({ ok: false, error: 'unavailable' });
    expect((await requestOf(post.postId, hidden.reeId)).state).toBe('declined');
    await db().update(schema.ree).set({ answersPosts: false }).where(eq(schema.ree.id, off.reeId));
    expect(await posts.closeUnavailableRequests(off.reeId)).toBe(1);
    await db().update(schema.ree).set({ deletedAt: new Date(), isPublic: false, isPublished: false }).where(eq(schema.ree.id, deleted.reeId));
    await posts.sweepPaidRequests();
    expect((await requestOf(post.postId, deleted.reeId)).state).toBe('declined');
    expect(await Promise.all([posts.closeUnavailableRequests(null), posts.closeUnavailableRequests(off.reeId)])).toEqual([0, 0]);

    /* A Ree that turned free still answers on request, now for the base fee only. */
    await db().update(schema.ree).set({ queryFee: 0 }).where(eq(schema.ree.id, nowFree.reeId));
    expect((await posts.getPost(post.postId, author))!.paidRequests).toMatchObject([{ reeId: nowFree.reeId, price: BASE }]);
    expect(await posts.agreePaidAnswer(author, idOf(nowFree.reeId), BASE + FEE_20)).toEqual({ ok: true });
    await posts.answerPaid(idOf(nowFree.reeId), { answerOne: answered() });
    expect(await balanceOf(db(), author)).toBe(1_000 - BASE);
    expect(await balanceOf(db(), author)).toBe(1_000 - BASE);
  });

  it('answers through the route: signed in only, a changed price, too little balance, agree, decline', async () => {
    const paid = [await paidRee(), await paidRee()];
    const author = await user('pp-route', BASE);
    const post = await matched(author, paid.map((entry) => entry.reeId));
    const [first, second] = (await posts.getPost(post.postId, author))!.paidRequests;
    const call = (id: string, payload: unknown) =>
      requestRoute(new NextRequest(`http://localhost:3000/api/posts/answers/${id}/request`, { method: 'POST', headers: { origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(payload) }), { params: Promise.resolve({ answerId: id }) });
    token = undefined;
    expect((await call(first!.id, { action: 'agree', price: first!.price })).status).toBe(401);

    token = crypto.randomUUID();
    await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId: author, expiresAt: new Date(Date.now() + 60_000) });
    expect((await call(first!.id, { action: 'nope' })).status).toBe(422);
    const poor = await call(first!.id, { action: 'agree', price: first!.price });
    expect(poor.status).toBe(402);
    expect(await poor.json()).toEqual({ error: 'insufficient', balance: BASE, needed: first!.price });
    await topUp(author, FEE_20);
    const changed = await call(first!.id, { action: 'agree', price: first!.price - 1 });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'price_changed', price: first!.price });
    expect((await call(first!.id, { action: 'agree', price: first!.price })).status).toBe(200);
    expect(later).toHaveLength(1);
    const again = await call(first!.id, { action: 'agree', price: first!.price });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'already' });
    expect((await call(second!.id, { action: 'decline' })).status).toBe(200);
    expect((await call(second!.id, { action: 'decline' })).status).toBe(404);
    token = undefined;
  });
});

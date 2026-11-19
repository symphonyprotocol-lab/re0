/**
 * Paid Rees answer a public post only once its author agrees (2026-11-19,
 * the user's rule): a related paid Ree waits as a request only the author
 * sees; agreeing charges the price shown like a private question (base fee
 * to the platform, query fee to the owner) and the Ree answers; declining
 * drops it. The post's own fee stays held while nothing answered and a
 * request is open, and is given back once every request is declined, every
 * agreed answer failed, or 7 days pass with none agreed.
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
const { POST_FEE, POST_FREE_PER_DAY, POST_SUMMARY_FEE } = await import('@/lib/domain/post');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { POST: reportPostRoute } = await import('@/app/api/posts/[id]/report/route');
const { publishOwnAnswer } = await import('@/lib/services/public-qa');
const { reeCards } = await import('@/lib/services/explore');
const { consoleAdministrator } = await import('../fixtures/console-administrator');
const { POST_FEE: FEE } = await import('@/lib/domain/post');
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

const { POST_PAID_REQUEST_REFUND_MS, POST_PAID_ANSWER_STALE_MS } = await import('@/lib/domain/post');
const { QUERY_BASE_FEE } = await import('@/lib/constants');
const { planSeedPosts } = await import('@/lib/services/seed-posts');
const { POST: requestRoute } = await import('@/app/api/posts/answers/[answerId]/request/route');
const { sessionTokenHash } = await import('@/lib/services/auth');

const FEE_20 = 20;
const answered = (text = 'Within 14 days [1].') => async () => ({ state: 'answered' as const, text, citations: [], model: 'stub' });

/** A post by `author` matched to the given Rees; only the free ones answer here. */
async function matched(author: string, reeIds: string[], question = `${QUESTION} ${crypto.randomUUID()}`) {
  const posted = await publish(author, question);
  const asked: string[] = [];
  await posts.processPost(posted.id, {
    judge: approve,
    match: async () => ({ answerers: reeIds.map((reeId) => ({ reeId, similarity: 0.8, mentioned: false })), candidates: reeIds.length, skipped: 0, vector: null }),
    answerOne: async ({ reeId }) => {
      asked.push(reeId);
      return { state: 'answered', text: 'Within 14 days [1].', citations: [], model: 'stub' };
    },
  });
  return { postId: posted.id, charge: posted.charge, asked };
}

async function requestOf(postId: string, reeId: string) {
  const [row] = await db().select().from(schema.postAnswer).where(and(eq(schema.postAnswer.postId, postId), eq(schema.postAnswer.reeId, reeId)));
  return row!;
}

async function holdStatus(postId: string) {
  const row = await postRow(postId);
  if (!row.holdId) return null;
  const [hold] = await db().select({ status: schema.creditHold.status }).from(schema.creditHold).where(eq(schema.creditHold.id, row.holdId));
  return hold!.status;
}

/** Uses up the day's free posts so the next one is held. */
async function spendFree(author: string) {
  for (let index = 0; index < POST_FREE_PER_DAY; index += 1) await publish(author, `${QUESTION} spent ${crypto.randomUUID()}`);
}

describeWithDb('paid Rees answer a post once its author agrees', () => {
  it('asks the author first: free Rees answer, the paid one waits unseen by anyone else; agreeing charges it like a private question and pays the owner', async () => {
    const free = await publicRee();
    const paid = await publicRee(FEE_20);
    await db().update(schema.ree).set({ answersPosts: true }).where(eq(schema.ree.id, paid.reeId));
    const author = await user('pp-author', 1_000);
    const post = await matched(author, [free.reeId, paid.reeId]);
    expect(post.asked).toEqual([free.reeId]);
    expect((await requestOf(post.postId, paid.reeId)).state).toBe('awaiting');

    /* Others see one answer and no request; the author sees the request at base fee + query fee. */
    for (const viewer of [undefined, await user('pp-other', 0)]) {
      const view = (await posts.getPost(post.postId, viewer))!;
      expect(view.answered).toBe(1);
      expect(view.answers.map((entry) => entry.reeId)).toEqual([free.reeId]);
      expect(view.paidRequests).toEqual([]);
    }
    const mine = (await posts.getPost(post.postId, author))!;
    expect(mine.paidRequests).toMatchObject([{ reeId: paid.reeId, price: QUERY_BASE_FEE + FEE_20, state: 'awaiting' }]);
    const notices = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.kind, 'post_paid_requests')));
    expect(notices).toMatchObject([{ refId: post.postId, params: { n: 1 } }]);

    /* A price above the one shown is refused with the new one. */
    const requestId = mine.paidRequests[0]!.id;
    expect(await posts.agreePaidAnswer(author, requestId, QUERY_BASE_FEE)).toEqual({ ok: false, error: 'price_changed', price: QUERY_BASE_FEE + FEE_20 });
    /* Nobody else can agree. */
    expect(await posts.agreePaidAnswer(await user('pp-stranger', 1_000), requestId, 999)).toEqual({ ok: false, error: 'not_found' });

    const before = await balanceOf(db(), author);
    const ownerBefore = await balanceOf(db(), paid.ownerId);
    expect(await posts.agreePaidAnswer(author, requestId, QUERY_BASE_FEE + FEE_20)).toEqual({ ok: true });
    expect(await balanceOf(db(), author)).toBe(before - QUERY_BASE_FEE - FEE_20);
    await posts.answerPaid(requestId, { answerOne: answered() });
    expect(await balanceOf(db(), author)).toBe(before - QUERY_BASE_FEE - FEE_20);
    expect(await balanceOf(db(), paid.ownerId)).toBe(ownerBefore + FEE_20);
    const earned = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, paid.ownerId), eq(schema.creditEntry.reason, 'query_fee_earned'), eq(schema.creditEntry.refId, requestId)));
    expect(earned.reduce((sum, entry) => sum + entry.delta, 0)).toBe(FEE_20);
    /* The base fee is a question to that Ree, like a private one. */
    expect(await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.reason, 'query_base'), eq(schema.creditEntry.refId, requestId)))).toHaveLength(1);

    const view = (await posts.getPost(post.postId))!;
    expect(view.answered).toBe(2);
    expect(view.answers.find((entry) => entry.reeId === paid.reeId)).toMatchObject({ paid: true, state: 'answered' });
    expect(view.answers.find((entry) => entry.reeId === free.reeId)).toMatchObject({ paid: false });
    expect((await posts.getPost(post.postId, author))!.paidRequests).toEqual([]);
    /* Agreeing twice is not possible. */
    expect(await posts.agreePaidAnswer(author, requestId, 999)).toEqual({ ok: false, error: 'not_found' });
  });

  it('refuses agreeing without the balance, and holds nothing', async () => {
    const paid = await publicRee(FEE_20);
    await db().update(schema.ree).set({ answersPosts: true }).where(eq(schema.ree.id, paid.reeId));
    const author = await user('pp-poor', 0);
    const post = await matched(author, [paid.reeId]);
    const [request] = (await posts.getPost(post.postId, author))!.paidRequests;
    expect(await posts.agreePaidAnswer(author, request!.id, request!.price)).toEqual({ ok: false, error: 'insufficient', balance: 0, needed: QUERY_BASE_FEE + FEE_20 });
    expect((await requestOf(post.postId, paid.reeId)).state).toBe('awaiting');
  });

  it('keeps the post fee held while only paid Rees wait, and gives it and the free post back when the author declines them all', async () => {
    const paid = [await publicRee(FEE_20), await publicRee(FEE_20)];
    await db().update(schema.ree).set({ answersPosts: true }).where(inArray(schema.ree.id, paid.map((entry) => entry.reeId)));
    const author = await user('pp-decline', POST_FEE);
    await spendFree(author);
    const post = await matched(author, paid.map((entry) => entry.reeId));
    expect(post.charge).toBe('paid');
    expect(await holdStatus(post.postId)).toBe('held');
    expect(await balanceOf(db(), author)).toBe(0);

    const requests = (await posts.getPost(post.postId, author))!.paidRequests;
    expect(await posts.declinePaidAnswer(author, requests[0]!.id)).toBe(true);
    expect(await holdStatus(post.postId)).toBe('held');
    expect(await posts.declinePaidAnswer(author, requests[1]!.id)).toBe(true);
    expect(await holdStatus(post.postId)).toBe('released');
    expect(await balanceOf(db(), author)).toBe(POST_FEE);
    expect((await postRow(post.postId)).freeDay).toBeNull();
    expect(await posts.declinePaidAnswer(author, requests[1]!.id)).toBe(false);
  });

  it('gives everything back when an agreed paid Ree finds no answer', async () => {
    const paid = await publicRee(FEE_20);
    await db().update(schema.ree).set({ answersPosts: true }).where(eq(schema.ree.id, paid.reeId));
    const author = await user('pp-none', POST_FEE + QUERY_BASE_FEE + FEE_20);
    await spendFree(author);
    const post = await matched(author, [paid.reeId]);
    const [request] = (await posts.getPost(post.postId, author))!.paidRequests;
    expect(await posts.agreePaidAnswer(author, request!.id, request!.price)).toEqual({ ok: true });
    await posts.answerPaid(request!.id, { answerOne: async () => ({ state: 'no_answer', model: 'stub' }) });
    expect(await balanceOf(db(), author)).toBe(POST_FEE + QUERY_BASE_FEE + FEE_20);
    expect(await holdStatus(post.postId)).toBe('released');
    expect((await requestOf(post.postId, paid.reeId)).state).toBe('no_answer');
  });

  it('settles the post fee once an agreed paid Ree answers, when nothing else did', async () => {
    const paid = await publicRee(FEE_20);
    await db().update(schema.ree).set({ answersPosts: true }).where(eq(schema.ree.id, paid.reeId));
    const author = await user('pp-settle', POST_FEE + QUERY_BASE_FEE + FEE_20);
    await spendFree(author);
    const post = await matched(author, [paid.reeId]);
    const [request] = (await posts.getPost(post.postId, author))!.paidRequests;
    expect(await posts.agreePaidAnswer(author, request!.id, request!.price)).toEqual({ ok: true });
    await posts.answerPaid(request!.id, { answerOne: answered() });
    expect(await holdStatus(post.postId)).toBe('settled');
    expect(await balanceOf(db(), author)).toBe(0);
  });

  it('gives the post fee back after 7 days with no request agreed, keeps the requests open, and gives back an agreed answer no run finished', async () => {
    const paid = await publicRee(FEE_20);
    await db().update(schema.ree).set({ answersPosts: true }).where(eq(schema.ree.id, paid.reeId));
    const author = await user('pp-week', POST_FEE + QUERY_BASE_FEE + FEE_20);
    await spendFree(author);
    const post = await matched(author, [paid.reeId]);
    await posts.sweepPaidRequests(new Date(Date.now() + POST_PAID_REQUEST_REFUND_MS - 60_000));
    expect(await holdStatus(post.postId)).toBe('held');
    await posts.sweepPaidRequests(new Date(Date.now() + POST_PAID_REQUEST_REFUND_MS + 60_000));
    expect(await holdStatus(post.postId)).toBe('released');
    expect((await postRow(post.postId)).freeDay).toBeNull();
    expect(await balanceOf(db(), author)).toBe(POST_FEE + QUERY_BASE_FEE + FEE_20);

    /* Still open: agreeing now charges the answer only; a run that died gives it back. */
    const [request] = (await posts.getPost(post.postId, author))!.paidRequests;
    expect(request).toMatchObject({ state: 'awaiting' });
    expect(await posts.agreePaidAnswer(author, request!.id, request!.price)).toEqual({ ok: true });
    expect(await balanceOf(db(), author)).toBe(POST_FEE);
    expect((await posts.getPost(post.postId, author))!.paidRequests).toMatchObject([{ state: 'answering' }]);
    await posts.sweepPaidRequests(new Date(Date.now() + POST_PAID_ANSWER_STALE_MS + 60_000));
    expect(await balanceOf(db(), author)).toBe(POST_FEE + QUERY_BASE_FEE + FEE_20);
    expect((await requestOf(post.postId, paid.reeId)).state).toBe('failed');
  });

  it('lets the author\'s own paid Ree answer at once, free, and keeps paid Rees out of example posts', async () => {
    const author = await user('pp-own', 0);
    const own = await publicRee(FEE_20);
    await db().update(schema.ree).set({ ownerId: author, answersPosts: true }).where(eq(schema.ree.id, own.reeId));
    const post = await matched(author, [own.reeId]);
    expect(post.asked).toEqual([own.reeId]);
    expect((await requestOf(post.postId, own.reeId)).state).toBe('answered');

    const paid = await publicRee(FEE_20);
    const marker = `Example ${crypto.randomUUID()}?`;
    await db().update(schema.ree).set({ answersPosts: true, sampleQuestions: [marker] }).where(eq(schema.ree.id, paid.reeId));
    expect((await planSeedPosts({ perCategory: 1_000 })).map((entry) => entry.question)).not.toContain(marker);
  });

  it('answers through the route: signed in only, a changed price, too little balance, agree, decline', async () => {
    const paid = [await publicRee(FEE_20), await publicRee(FEE_20)];
    await db().update(schema.ree).set({ answersPosts: true }).where(inArray(schema.ree.id, paid.map((entry) => entry.reeId)));
    const author = await user('pp-route', 0);
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
    expect(await poor.json()).toEqual({ error: 'insufficient', balance: 0, needed: first!.price });
    await db().transaction((tx) => addGrant(tx, { userId: author, source: 'pack', amount: first!.price, reason: 'admin_adjust', refId: crypto.randomUUID() }));
    const changed = await call(first!.id, { action: 'agree', price: first!.price - 1 });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'price_changed', price: first!.price });
    expect((await call(first!.id, { action: 'agree', price: first!.price })).status).toBe(200);
    expect(later).toHaveLength(1);
    expect((await call(second!.id, { action: 'decline' })).status).toBe(200);
    expect((await call(second!.id, { action: 'decline' })).status).toBe(404);
    token = undefined;
  });
});

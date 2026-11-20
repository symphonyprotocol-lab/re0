/**
 * Public posts after review round 3 (2026-11-19): the exchange 继续问
 * copies from a post counts in no figure -- verification, owner statistics,
 * ranking, explore, the console -- and takes no vote, while a real question
 * asked after it counts like any (N1); the one-minute duplicate rule only
 * matches live posts (O-a); a stale summary is rewritten free at most twice
 * and never through the author's own Rees (O-b).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { NextRequest } from 'next/server';
import { inArray } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { PostInput, ProcessDeps } from '@/lib/services/posts';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const posts = await import('@/lib/services/posts');
const { listPublicQa } = await import('@/lib/services/public-qa');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { POST_SUMMARY_FEE } = await import('@/lib/domain/post');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { POST: reportPostRoute } = await import('@/app/api/posts/[id]/report/route');
const { publishOwnAnswer } = await import('@/lib/services/public-qa');
const { reeCards } = await import('@/lib/services/explore');
const { consoleAdministrator } = await import('../fixtures/console-administrator');
const { roleMetrics } = await import('@/lib/services/roles');
const { savedCounts } = await import('@/lib/services/statistics');
const { computeRanks } = await import('@/lib/services/rank');
const { adminOverview } = await import('@/lib/services/admin-overview');
const { setFeedback } = await import('@/lib/services/conversations');
const privatePosts = await import('@/lib/services/private-posts');
const { QUERY_BASE_FEE } = await import('@/lib/constants');
const { POST_SUMMARY_FREE_REWRITES } = await import('@/lib/domain/post');

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

async function entries(userId: string, refId: string) {
  return db().select({ reason: schema.creditEntry.reason, delta: schema.creditEntry.delta, note: schema.creditEntry.note }).from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.refId, refId)));
}

async function publish(userId: string, question = QUESTION, extra: Partial<PostInput> = {}) {
  const result = await posts.publishPost(userId, { question, lang: 'en', ...extra });
  if (!result.ok) throw new Error(result.error);
  return result;
}



async function figures(ownerId: string, reeId: string) {
  await computeRanks();
  const [rank] = await db().select({ rank: schema.ree.rank }).from(schema.ree).where(eq(schema.ree.id, reeId));
  const administrator = await consoleAdministrator();
  return {
    external: (await roleMetrics(db(), ownerId)).externalQuestions,
    saved: (await savedCounts([reeId], null)).get(reeId) ?? 0,
    explore: (await reeCards([reeId], new Map(), { includeIntros: false }))[0]!.answers,
    asked7: (rank!.rank as { asked7?: number }).asked7 ?? 0,
    questions30: (await adminOverview(administrator)).questions30,
  };
}

describeWithDb('public posts, review round 3', () => {
  it('counts the copied exchange of 继续问 nowhere, and a real question after it like any (N1)', async () => {
    const { ownerId, reeId } = await publicRee();
    const author = await user('r3-follow', 500);
    const posted = await publish(author);
    await posts.processPost(posted.id, stub([reeId]));
    const [shown] = (await posts.getPost(posted.id))!.answers;
    const before = await figures(ownerId, reeId);

    const conversationIds: string[] = [];
    for (let index = 0; index < 4; index += 1) conversationIds.push((await posts.followUpPost(author, posted.id, shown!.id))!);
    expect(await figures(ownerId, reeId)).toEqual(before);

    /* The copied answer takes no vote either. */
    const [copied] = await db().select({ id: schema.message.id }).from(schema.message).where(and(eq(schema.message.conversationId, conversationIds[0]!), eq(schema.message.role, 'ree')));
    await expect(setFeedback(author, copied!.id, 'up')).rejects.toThrow();

    /* A real question after it -- a private question to the same Ree now -- is charged and counts. */
    const balance = await balanceOf(db(), author);
    const asked = await privatePosts.publishPrivatePost(author, { question: 'And when are refunds issued to the card?', reeIds: [reeId], fees: { [reeId]: QUERY_BASE_FEE }, lang: 'en' });
    if (!asked.ok) throw new Error(asked.error);
    await privatePosts.processPrivatePost(asked.id, { answerOne: stub([reeId]).answerOne });
    expect(await balanceOf(db(), author)).toBe(balance - QUERY_BASE_FEE);
    const after = await figures(ownerId, reeId);
    expect(after.external).toBe(before.external + 1);
    expect(after.saved).toBe(before.saved + 1);
    expect(after.explore).toBe(before.explore + 1);
    expect(after.questions30).toBe(before.questions30 + 1);
  });

  it('matches only a live post as the same submit (O-a)', async () => {
    const author = await user('r3-dedup', 1_000);
    const first = await publish(author, `${QUESTION} trashed`);
    expect(await posts.setPostTrashed(author, first.id, true)).toBe(true);
    const again = await publish(author, `${QUESTION} trashed`);
    expect(again.id).not.toBe(first.id);
    expect(again.duplicate).toBeUndefined();

    const refused = await publish(author, `${QUESTION} refused`);
    await posts.processPost(refused.id, { judge: async () => ({ publish: false }) });
    expect((await publish(author, `${QUESTION} refused`)).id).not.toBe(refused.id);
  });

  it('rewrites a stale summary free at most twice, and never when the author\'s own Ree made it stale (O-b)', async () => {
    const others = [await publicRee(), await publicRee(), await publicRee(), await publicRee()];
    const author = await user('r3-rewrite', 500);
    /* The author owns one answering Ree too. */
    const own = await publicRee();
    await db().update(schema.ree).set({ ownerId: author }).where(eq(schema.ree.id, own.reeId));
    const posted = await publish(author);
    await posts.processPost(posted.id, stub([own.reeId, ...others.map((entry) => entry.reeId)]));
    expect(await posts.summarizePost(author, posted.id, 'en', approve)).toBe('done');
    const paidOnce = await balanceOf(db(), author);

    /* Their own Ree goes private: the summary is stale, the rewrite is paid. */
    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, own.reeId));
    expect((await posts.getPost(posted.id, author))).toMatchObject({ summaryStale: true, summaryRewriteFree: false });
    expect(await posts.summarizePost(author, posted.id, 'en', approve)).toBe('done');
    expect(await balanceOf(db(), author)).toBe(paidOnce - POST_SUMMARY_FEE);

    /* Another owner hides their answer: free, and counted. */
    const hide = async (owner: { ownerId: string; reeId: string }) => {
      const [row] = await db().select().from(schema.postAnswer).where(and(eq(schema.postAnswer.postId, posted.id), eq(schema.postAnswer.reeId, owner.reeId)));
      expect(await posts.ownerActOnAnswer(owner.ownerId, owner.reeId, row!.id, 'hide')).toBe(true);
    };
    let balance = await balanceOf(db(), author);
    await hide(others[0]!);
    expect((await posts.getPost(posted.id, author))?.summaryRewriteFree).toBe(true);
    expect(await posts.summarizePost(author, posted.id, 'en', approve)).toBe('done');
    expect(await balanceOf(db(), author)).toBe(balance);
    expect((await postRow(posted.id)).summaryRewrites).toBe(1);

    /* Past the limit (as if used up), the next rewrite is paid. */
    await db().update(schema.post).set({ summaryRewrites: POST_SUMMARY_FREE_REWRITES }).where(eq(schema.post.id, posted.id));
    await hide(others[1]!);
    expect((await posts.getPost(posted.id, author))?.summaryRewriteFree).toBe(false);
    balance = await balanceOf(db(), author);
    expect(await posts.summarizePost(author, posted.id, 'en', approve)).toBe('done');
    expect(await balanceOf(db(), author)).toBe(balance - POST_SUMMARY_FEE);
  });

  it('looks only at the answers that dropped out: an author\'s own Ree still answering keeps a rewrite free (#161)', async () => {
    const others = [await publicRee(), await publicRee()];
    const author = await user('r3-dropped', 500);
    const own = await publicRee();
    await db().update(schema.ree).set({ ownerId: author }).where(eq(schema.ree.id, own.reeId));
    const posted = await publish(author, `${QUESTION} dropped`);
    await posts.processPost(posted.id, stub([own.reeId, ...others.map((entry) => entry.reeId)]));
    expect(await posts.summarizePost(author, posted.id, 'en', approve)).toBe('done');

    /* Another owner hides theirs; the author's own answer is still shown and was in the summary: free. */
    const [row] = await db().select().from(schema.postAnswer).where(and(eq(schema.postAnswer.postId, posted.id), eq(schema.postAnswer.reeId, others[0]!.reeId)));
    expect(await posts.ownerActOnAnswer(others[0]!.ownerId, others[0]!.reeId, row!.id, 'hide')).toBe(true);
    expect((await posts.getPost(posted.id, author))).toMatchObject({ summaryStale: true, summaryRewriteFree: true });
    const balance = await balanceOf(db(), author);
    expect(await posts.summarizePost(author, posted.id, 'en', approve)).toBe('done');
    expect(await balanceOf(db(), author)).toBe(balance);
  });
});

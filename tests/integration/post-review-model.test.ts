/**
 * A post's review on the model, as a real one behaves (2026-11-19): the
 * question is reviewed alone; a reply cut off mid-JSON (a thinking model out
 * of budget) is asked again within the same check; prose or a code fence
 * around the JSON is fine. A check that still gets no verdict leaves the post
 * pending, and the posts sweep -- `npm run cron:local -- posts` locally --
 * retries it until it passes, or rejects it after the last attempt.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { NextRequest } from 'next/server';
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
const { syncPublicQa } = await import('@/lib/services/public-qa-sync');
const { listPublicQa } = await import('@/lib/services/public-qa');
const { addGrant, balanceOf, placeHold } = await import('@/lib/services/credits');
const { POST_MAX_ANSWERS, POST_SUMMARY_FEE } = await import('@/lib/domain/post');
const { QUERY_BASE_FEE } = await import('@/lib/constants');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { POST: reportPost } = await import('@/app/api/posts/answers/[answerId]/report/route');

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

describeWithDb('reviewing a post on the model', () => {
  it('publishes in one check when the first reply is cut off, reviewing the question alone', async () => {
    const author = await user('review-cut', 100);
    const posted = await publish(author, `${QUESTION} REVIEW CUT ONCE ${crypto.randomUUID()}`);
    expect(await posts.moderatePost(posted.id)).toBe('published');
    expect(await postRow(posted.id)).toMatchObject({ status: 'published', moderationAttempts: 1 });
  });

  it('leaves a post whose replies never carry a verdict pending, and lets the sweep retry it', async () => {
    const author = await user('review-stuck', 100);
    const posted = await publish(author, `${QUESTION} REVIEW ALWAYS CUT ${crypto.randomUUID()}`);
    expect(await posts.moderatePost(posted.id)).toBe('pending');
    expect(await postRow(posted.id)).toMatchObject({ status: 'pending', moderationAttempts: 1 });
    /* The sweep picks it up a minute on and tries again; the last attempt gives up (nothing was charged). */
    await db().update(schema.post).set({ createdAt: new Date(Date.now() - 5 * 60_000) }).where(eq(schema.post.id, posted.id));
    const { reeId } = await publicRee();
    /* The model's own review, not the stub's approval. */
    const { judge: _approve, ...sweep } = stub([reeId]);
    await posts.processStalePosts(sweep);
    expect(await postRow(posted.id)).toMatchObject({ status: 'pending', moderationAttempts: 2 });
    await posts.processStalePosts(sweep);
    expect(await postRow(posted.id)).toMatchObject({ status: 'rejected', moderationAttempts: 3 });
    expect(await balanceOf(db(), author)).toBe(100);
  });

  it('reviews a normal post in one call and publishes it', async () => {
    const author = await user('review-ok', 100);
    const posted = await publish(author, `${QUESTION} ${crypto.randomUUID()}`);
    expect(await posts.moderatePost(posted.id)).toBe('published');
    const refused = await publish(author, `${QUESTION} UNPUBLISHABLE ${crypto.randomUUID()}`);
    expect(await posts.moderatePost(refused.id)).toBe('rejected');
  });
});

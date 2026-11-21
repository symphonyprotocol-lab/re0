/**
 * "有帮助" on a post itself (2026-11-20): the card's and the post page's 👍
 * was the sum of its answers' votes and could not be pressed. Now a
 * signed-in reader marks the post helpful once (again takes it back); the
 * number shown is the post's votes plus its first-round answers', and
 * 为你推荐 ranks by the same total.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { pointModelsAt, resetRewardSettings, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let token: string | undefined;
const later: (() => unknown)[] = [];
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 're0_session' && token ? { value: token } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: (task: () => unknown) => void later.push(task) }));

const { createSession, sessionTokenHash } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const posts = await import('@/lib/services/posts');
const { addGrant } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { POST: helpfulRoute } = await import('@/app/api/posts/[id]/helpful/route');

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
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
  if (credits > 0) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

async function publicRee(queryFee = 0) {
  const ownerId = await user('fu-owner', 1_000);
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Refund desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: 'Refund policy', content: 'Refunds are issued to the original payment method within 14 days of the request.' });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true, queryFee, answersPosts: queryFee > 0 ? true : null }).where(eq(schema.ree.id, ree.id));
  return { ownerId, reeId: ree.id };
}

const approve = async () => ({ publish: true });

/** A post by `author` answered in its first round by these Rees. */
async function answeredPost(author: string, reeIds: string[]) {
  const posted = await posts.publishPost(author, { question: `When are refunds issued? ${crypto.randomUUID()}`, lang: 'en' });
  if (!posted.ok) throw new Error(posted.error);
  await posts.processPost(posted.id, {
    judge: approve,
    match: async () => ({ answerers: reeIds.map((reeId, index) => ({ reeId, similarity: 0.9 - index / 100, mentioned: false })), candidates: reeIds.length, skipped: 0, vector: null }),
    answerOne: async ({ reeId }) => ({ state: 'answered', text: `First round from ${reeId}.`, citations: [], model: 'stub' }),
  });
  return posted.id;
}

describeWithDb('有帮助 on a post itself', () => {
  it('counts once per user, takes it back, and adds to the first-round answers\' votes', async () => {
    const one = await publicRee();
    const author = await user('ph-author', 1_000);
    const postId = await answeredPost(author, [one.reeId]);
    const [first] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, postId));
    const reader = await user('ph-reader', 0);
    const other = await user('ph-other', 0);
    expect(await posts.setAnswerHelpful(other, first!.id, true)).toMatchObject({ helpful: 1 });

    expect(await posts.setPostHelpful(reader, postId, true)).toMatchObject({ helpful: 2, voted: true });
    /* Again is a no-op, not a second vote. */
    expect(await posts.setPostHelpful(reader, postId, true)).toMatchObject({ helpful: 2, voted: true });
    expect(await posts.setPostHelpful(author, postId, true)).toMatchObject({ helpful: 3, voted: true });
    expect((await db().select().from(schema.post).where(eq(schema.post.id, postId)))[0]!.helpfulCount).toBe(2);

    const seen = (await posts.getPost(postId, reader))!;
    expect(seen).toMatchObject({ helpful: 3, voted: true });
    expect((await posts.getPost(postId))!).toMatchObject({ helpful: 3, voted: false });
    const feed = await posts.listFeed('latest', { viewerId: reader, size: 50 });
    expect(feed.items.find((entry) => entry.id === postId)).toMatchObject({ helpful: 3, voted: true });

    expect(await posts.setPostHelpful(reader, postId, false)).toMatchObject({ helpful: 2, voted: false });
    expect(await posts.setPostHelpful(reader, postId, false)).toMatchObject({ helpful: 2, voted: false });
    expect((await posts.getPost(postId, reader))!).toMatchObject({ helpful: 2, voted: false });
  });

  it('ranks 为你推荐 by the post\'s own votes too', async () => {
    const one = await publicRee();
    const author = await user('ph-rank', 1_000);
    const plain = await answeredPost(author, [one.reeId]);
    const liked = await answeredPost(author, [one.reeId]);
    /* Same age: the later post would come first; its votes are what put the other ahead. */
    await db().update(schema.post).set({ publishedAt: new Date(Date.now() - 3_600_000) }).where(eq(schema.post.id, plain));
    await db().update(schema.post).set({ publishedAt: new Date(Date.now() - 3_600_000) }).where(eq(schema.post.id, liked));
    for (let index = 0; index < 3; index += 1) await posts.setPostHelpful(await user('ph-fan', 0), liked, true);
    const ids = (await posts.listFeed('for_you', { size: 100 })).items.map((entry) => entry.id);
    expect(ids.indexOf(liked)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(liked)).toBeLessThan(ids.indexOf(plain));
  });

  it('takes no vote on a post nobody else can see, and needs a signed-in reader', async () => {
    const one = await publicRee();
    const author = await user('ph-hidden', 1_000);
    const postId = await answeredPost(author, [one.reeId]);
    expect(await posts.setPostTrashed(author, postId, true)).toBe(true);
    expect(await posts.setPostHelpful(await user('ph-late', 0), postId, true)).toBeNull();
    expect(await posts.setPostHelpful(author, crypto.randomUUID(), true)).toBeNull();
    expect(await posts.setPostTrashed(author, postId, false)).toBe(true);

    const call = (payload: unknown) =>
      helpfulRoute(new NextRequest(`http://localhost:3000/api/posts/${postId}/helpful`, { method: 'POST', headers: { origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(payload) }), { params: Promise.resolve({ id: postId }) });
    token = undefined;
    expect((await call({ on: true })).status).toBe(401);
    const reader = await user('ph-route', 0);
    token = crypto.randomUUID();
    await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId: reader, expiresAt: new Date(Date.now() + 60_000) });
    const response = await call({ on: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ helpful: 1, voted: true, taskReward: 0 });
    token = undefined;
  });
});

describeWithDb('starter tasks: the first post and the first 有帮助', () => {
  /* Every other suite runs with these rewards off (setup.ts). */
  beforeAll(async () => {
    const row = { invitesEnabled: true, withdrawableInvites: 1_000, withdrawableInvitesPerInviter: 20, inviteCredits: 0, firstReeCredits: 0, firstPostCredits: 1_000, firstHelpfulCredits: 600, checkInCredits: 0, checkInMaxDays: 30, checkInWindowMonths: 3, revision: crypto.randomUUID(), updatedBy: null };
    await db().insert(schema.rewardSettings).values(row).onConflictDoUpdate({ target: schema.rewardSettings.id, set: row });
  });
  afterAll(resetRewardSettings);
  const entries = (userId: string, reason: 'task_first_post' | 'task_first_helpful') =>
    db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.reason, reason)));

  it('pays a first public post once it passes review, never for a refused one, and once only', async () => {
    const refused = await user('st-refused', 1_000);
    const posted = await posts.publishPost(refused, { question: `Refused question ${crypto.randomUUID()}`, lang: 'en' });
    if (!posted.ok) throw new Error(posted.error);
    /* Pending: nothing yet. Refused: nothing ever. */
    expect(await entries(refused, 'task_first_post')).toHaveLength(0);
    expect(await posts.moderatePost(posted.id, async () => ({ publish: false }))).toBe('rejected');
    expect(await entries(refused, 'task_first_post')).toHaveLength(0);

    const one = await publicRee();
    const author = await user('st-author', 1_000);
    const first = await answeredPost(author, [one.reeId]);
    expect((await entries(author, 'task_first_post')).map((entry) => [entry.delta, entry.refId])).toEqual([[1_000, first]]);
    await answeredPost(author, [one.reeId]);
    expect(await entries(author, 'task_first_post')).toHaveLength(1);
  });

  it('does not review, publish or pay a public post trashed before its review; restored, it is reviewed and pays', async () => {
    const author = await user('st-trash', 1_000);
    const posted = await posts.publishPost(author, { question: `Trashed while pending ${crypto.randomUUID()}`, lang: 'en' });
    if (!posted.ok) throw new Error(posted.error);
    expect(await posts.setPostTrashed(author, posted.id, true)).toBe(true);
    let judged = 0;
    const judge = async () => {
      judged += 1;
      return { publish: true };
    };
    expect(await posts.moderatePost(posted.id, judge)).toBe('gone');
    expect(judged).toBe(0);
    const [held] = await db().select().from(schema.post).where(eq(schema.post.id, posted.id));
    expect(held).toMatchObject({ status: 'pending', moderationAttempts: 0 });
    expect(await entries(author, 'task_first_post')).toHaveLength(0);

    /* Trashed between the claim and the verdict: still not published, and still pending for later. */
    const racing = async () => {
      await posts.setPostTrashed(author, posted.id, true);
      return { publish: true };
    };
    expect(await posts.setPostTrashed(author, posted.id, false)).toBe(true);
    expect(await posts.moderatePost(posted.id, racing)).toBe('gone');
    expect((await db().select().from(schema.post).where(eq(schema.post.id, posted.id)))[0]).toMatchObject({ status: 'pending' });
    expect(await entries(author, 'task_first_post')).toHaveLength(0);
    /* A refusal does not reach it in the trash either. */
    expect(await posts.moderatePost(posted.id, async () => ({ publish: false }))).toBe('gone');

    expect(await posts.setPostTrashed(author, posted.id, false)).toBe(true);
    expect(await posts.moderatePost(posted.id, judge)).toBe('published');
    expect((await entries(author, 'task_first_post')).map((entry) => entry.refId)).toEqual([posted.id]);
  });

  it('pays a first 有帮助 only on someone else\'s content: not one\'s own post, any answer under it, or one\'s own Ree\'s answer', async () => {
    const one = await publicRee();
    const author = await user('st-voter', 1_000);
    const postId = await answeredPost(author, [one.reeId]);
    const [reply] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, postId));

    /* Own post, another owner's Ree's answer under one's own post, own Ree's answer: counted as votes, but no reward. */
    expect(await posts.setPostHelpful(author, postId, true)).toMatchObject({ voted: true, taskReward: 0 });
    expect(await posts.setAnswerHelpful(author, reply!.id, true)).toMatchObject({ helpful: 1, voted: true, taskReward: 0 });
    expect(await posts.setAnswerHelpful(one.ownerId, reply!.id, true)).toMatchObject({ helpful: 2, voted: true, taskReward: 0 });
    expect(await entries(author, 'task_first_helpful')).toHaveLength(0);
    expect(await entries(one.ownerId, 'task_first_helpful')).toHaveLength(0);

    /* Someone else's Ree's answer under someone else's post: paid; taking it back and voting again pays nothing more. */
    const reader = await user('st-reader', 0);
    expect(await posts.setAnswerHelpful(reader, reply!.id, true)).toMatchObject({ helpful: 3, taskReward: 600 });
    expect(await posts.setAnswerHelpful(reader, reply!.id, false)).toMatchObject({ voted: false, taskReward: 0 });
    expect(await posts.setAnswerHelpful(reader, reply!.id, true)).toMatchObject({ voted: true, taskReward: 0 });
    expect(await entries(reader, 'task_first_helpful')).toHaveLength(1);

    /* Someone else's post: the Ree owner's first. A vote already cast, sent again, is no new vote and pays nothing. */
    expect(await posts.setPostHelpful(one.ownerId, postId, true)).toMatchObject({ taskReward: 600 });
    expect(await posts.setPostHelpful(one.ownerId, postId, true)).toMatchObject({ taskReward: 0 });
    expect(await entries(one.ownerId, 'task_first_helpful')).toHaveLength(1);
  });
});

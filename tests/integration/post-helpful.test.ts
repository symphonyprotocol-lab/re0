/**
 * "有帮助" on a post itself (2026-11-20): the card's and the post page's 👍
 * was the sum of its answers' votes and could not be pressed. Now a
 * signed-in reader marks the post helpful once (again takes it back); the
 * number shown is the post's votes plus its first-round answers', and
 * 为你推荐 ranks by the same total.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
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

    expect(await posts.setPostHelpful(reader, postId, true)).toEqual({ helpful: 2, voted: true });
    /* Again is a no-op, not a second vote. */
    expect(await posts.setPostHelpful(reader, postId, true)).toEqual({ helpful: 2, voted: true });
    expect(await posts.setPostHelpful(author, postId, true)).toEqual({ helpful: 3, voted: true });
    expect((await db().select().from(schema.post).where(eq(schema.post.id, postId)))[0]!.helpfulCount).toBe(2);

    const seen = (await posts.getPost(postId, reader))!;
    expect(seen).toMatchObject({ helpful: 3, voted: true });
    expect((await posts.getPost(postId))!).toMatchObject({ helpful: 3, voted: false });
    const feed = await posts.listFeed('latest', { viewerId: reader, size: 50 });
    expect(feed.items.find((entry) => entry.id === postId)).toMatchObject({ helpful: 3, voted: true });

    expect(await posts.setPostHelpful(reader, postId, false)).toEqual({ helpful: 2, voted: false });
    expect(await posts.setPostHelpful(reader, postId, false)).toEqual({ helpful: 2, voted: false });
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
    expect(await response.json()).toEqual({ helpful: 1, voted: true });
    token = undefined;
  });
});

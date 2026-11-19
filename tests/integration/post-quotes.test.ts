/**
 * "引用提问" (2026-11-19): anyone but a post's author asks on in public by
 * quoting the post, or one of its answers, in a post of their own. The
 * quote must be visible now; quoting an answer names its Ree, which answers
 * first with the quoted exchange as context; the post is billed and counted
 * like any other; the quoted author hears about it; once the quoted content
 * can no longer be seen the card says so and leaks nothing; one level only.
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
const { POST_FEE, POST_FREE_PER_DAY, POST_SUMMARY_FEE } = await import('@/lib/domain/post');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { POST: reportPostRoute } = await import('@/app/api/posts/[id]/report/route');
const { publishOwnAnswer } = await import('@/lib/services/public-qa');
const { reeCards } = await import('@/lib/services/explore');
const { consoleAdministrator } = await import('../fixtures/console-administrator');
const { POST_FEE: FEE } = await import('@/lib/domain/post');

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



async function answeredPost(prefix: string, extra: Partial<PostInput> = {}) {
  const { ownerId, reeId } = await publicRee();
  const author = await user(prefix, 0);
  const posted = await publish(author, `${QUESTION} ${prefix}`, extra);
  await posts.processPost(posted.id, stub([reeId]));
  const [shown] = (await posts.getPost(posted.id))!.answers;
  return { ownerId, reeId, author, postId: posted.id, answerId: shown!.id };
}

describeWithDb('quoting a post or an answer', () => {
  it('names the quoted answer\'s Ree, answers with the quote as context, and tells the quoted author once', async () => {
    const original = await answeredPost('q-original');
    const quoter = await user('q-quoter', 0);
    const posted = await publish(quoter, 'And what about refunds to a closed card?', { quotePostId: original.postId, quoteAnswerId: original.answerId });
    expect(posted.charge).toBe('free');
    expect(await postRow(posted.id)).toMatchObject({ quoteKind: 'answer', quotePostId: original.postId, quoteAnswerId: original.answerId, mentionReeId: original.reeId });

    const contexts: unknown[] = [];
    await posts.processPost(posted.id, {
      judge: approve,
      answerOne: async (input) => {
        contexts.push(input.context);
        return { state: 'answered', text: 'Within 14 days [1].', citations: [], model: 'stub' };
      },
    });
    const [answer] = await db().select().from(schema.postAnswer).where(and(eq(schema.postAnswer.postId, posted.id), eq(schema.postAnswer.reeId, original.reeId)));
    expect(answer).toMatchObject({ mentioned: true, state: 'answered' });
    expect(contexts[0]).toMatchObject({ question: expect.stringContaining('q-original'), answer: 'Within 14 days [1].' });

    const notices = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, original.author), eq(schema.notice.kind, 'post_quoted')));
    expect(notices.map((notice) => notice.refId)).toEqual([posted.id]);

    const view = (await posts.getPost(posted.id))!;
    expect(view.quote).toMatchObject({ kind: 'answer', available: true, postId: original.postId, answer: { id: original.answerId } });
    expect((await posts.getPost(original.postId))!.quotes).toBe(1);
    expect((await posts.listFeed('latest', { quotesOf: original.postId })).items.map((item) => item.id)).toEqual([posted.id]);

    /* Quoting one's own post tells no one. */
    const self = await publish(original.author, 'A follow-up of my own?', { quotePostId: original.postId });
    await posts.processPost(self.id, stub([]));
    expect(await db().select().from(schema.notice).where(and(eq(schema.notice.userId, original.author), eq(schema.notice.kind, 'post_quoted')))).toHaveLength(1);
  });

  it('bills a quoting post like any post: free ones first, then held, refunded when nobody answers', async () => {
    const original = await answeredPost('q-billed');
    const quoter = await user('q-payer', FEE);
    for (let index = 0; index < POST_FREE_PER_DAY; index += 1) await publish(quoter, `${QUESTION} spent ${index}`);
    const paid = await publish(quoter, 'Quoted, past the free ones', { quotePostId: original.postId });
    expect(paid.charge).toBe('paid');
    expect(await balanceOf(db(), quoter)).toBe(0);
    await posts.processPost(paid.id, stub([]));
    expect(await balanceOf(db(), quoter)).toBe(FEE);
  });

  it('refuses to quote what cannot be seen', async () => {
    const quoter = await user('q-refused', 0);
    const refuse = async (input: Partial<PostInput>) => expect(await posts.publishPost(quoter, { question: 'Quoting this?', lang: 'en', ...input })).toEqual({ ok: false, error: 'quote_unavailable' });

    const pendingAuthor = await user('q-pending', 0);
    const pending = await publish(pendingAuthor, `${QUESTION} pending`);
    await refuse({ quotePostId: pending.id });

    const rejected = await publish(pendingAuthor, `${QUESTION} rejected`);
    await posts.processPost(rejected.id, { judge: async () => ({ publish: false }) });
    await refuse({ quotePostId: rejected.id });

    const trashed = await answeredPost('q-trashed');
    expect(await posts.setPostTrashed(trashed.author, trashed.postId, true)).toBe(true);
    await refuse({ quotePostId: trashed.postId });

    const hidden = await answeredPost('q-hidden');
    const administrator = await consoleAdministrator();
    expect(await posts.adminSetPost(administrator.id, hidden.postId, false)).toBe(true);
    await refuse({ quotePostId: hidden.postId });

    const hiddenAnswer = await answeredPost('q-hidden-answer');
    expect(await posts.ownerActOnAnswer(hiddenAnswer.ownerId, hiddenAnswer.reeId, hiddenAnswer.answerId, 'hide')).toBe(true);
    await refuse({ quotePostId: hiddenAnswer.postId, quoteAnswerId: hiddenAnswer.answerId });
    /* An answer of another post is not this post's. */
    const other = await answeredPost('q-other');
    await refuse({ quotePostId: other.postId, quoteAnswerId: hiddenAnswer.answerId });
    await refuse({ quotePostId: crypto.randomUUID() });
  });

  it('shows "no longer available" -- and nothing of it -- once the quoted content cannot be seen', async () => {
    const original = await answeredPost('q-gone');
    const quoter = await user('q-watcher', 0);
    const onAnswer = await publish(quoter, 'About that answer?', { quotePostId: original.postId, quoteAnswerId: original.answerId });
    const onPost = await publish(quoter, 'About that post?', { quotePostId: original.postId });
    for (const id of [onAnswer.id, onPost.id]) await posts.processPost(id, stub([]));

    /* The answering Ree goes private: the answer card goes, the post card stays. */
    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, original.reeId));
    expect((await posts.getPost(onAnswer.id, quoter))!.quote).toEqual({ kind: 'answer', available: false });
    expect((await posts.getPost(onPost.id, quoter))!.quote).toMatchObject({ kind: 'post', available: true });

    /* The quoted post goes to its author's trash: both cards go; nothing of its text is in either view. */
    expect(await posts.setPostTrashed(original.author, original.postId, true)).toBe(true);
    for (const id of [onAnswer.id, onPost.id]) {
      const view = (await posts.getPost(id, quoter))!;
      expect(view.quote).toEqual({ kind: view.quote!.kind, available: false });
      expect(JSON.stringify(view)).not.toContain('q-gone');
    }
    expect((await posts.getPost(original.postId, original.author))!.quotes).toBe(2);
  });

  it('keeps an anonymous author anonymous in the card, and shows one level only', async () => {
    const original = await answeredPost('q-anon', { anonymous: true });
    const first = await publish(await user('q-first', 0), 'Quoting the anonymous one?', { quotePostId: original.postId });
    await posts.processPost(first.id, stub([original.reeId]));
    const second = await publish(await user('q-second', 0), 'Quoting the quote?', { quotePostId: first.id });
    await posts.processPost(second.id, stub([original.reeId]));

    expect((await posts.getPost(first.id))!.quote).toMatchObject({ available: true, author: { kind: 'hidden' } });
    const view = (await posts.getPost(second.id))!;
    expect(view.quote).toMatchObject({ available: true, postId: first.id });
    expect(view.quote).not.toHaveProperty('quote');
    expect(JSON.stringify(view.quote)).not.toContain(original.postId);
  });
});

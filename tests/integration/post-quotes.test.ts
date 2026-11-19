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
const { POST: askTokenRoute } = await import('@/app/api/share/[slug]/ask-token/route');
const { validShareAskToken } = await import('@/lib/services/anonymous-chat');
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

  it('refuses every post write but a report from a signed-out caller (2026-11-19: posting is for signed-in users)', async () => {
    const original = await answeredPost('q-signed-out');
    const request = (path: string, payload: unknown, method = 'POST') =>
      new NextRequest(`http://localhost:3000${path}`, { method, headers: { origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const id = { params: Promise.resolve({ id: original.postId }) };
    expect((await writes.publish(request('/api/posts', { question: 'A visitor post?', quotePostId: original.postId }))).status).toBe(401);
    expect((await writes.summary(request(`/api/posts/${original.postId}/summary`, {}), id)).status).toBe(401);
    expect((await writes.followUp(request(`/api/posts/${original.postId}/follow-up`, { answerId: original.answerId }), id)).status).toBe(401);
    expect((await writes.save(request(`/api/posts/${original.postId}/save`, { on: true }), id)).status).toBe(401);
    expect((await writes.trash(request(`/api/posts/${original.postId}`, { trashed: true }, 'PATCH'), id)).status).toBe(401);
    expect((await writes.helpful(request(`/api/posts/answers/${original.answerId}/helpful`, { on: true }), { params: Promise.resolve({ answerId: original.answerId }) })).status).toBe(401);
    expect(await db().select().from(schema.post).where(eq(schema.post.question, 'A visitor post?'))).toHaveLength(0);
  });
});

describeWithDb('quotes after review (#161, 2026-11-19)', () => {
  /** A post quoting `original`, answered by `reeId`. */
  async function quoting(prefix: string, original: { postId: string }, reeId: string) {
    const quoter = await user(prefix, 0);
    const posted = await publish(quoter, `Quoting it, ${prefix}?`, { quotePostId: original.postId });
    await posts.processPost(posted.id, stub([reeId]));
    return { quoter, postId: posted.id };
  }
  const shownAnswers = async (id: string) => (await posts.getPost(id))!.answers.length;
  const audits = (target: string) => db().select().from(schema.adminAudit).where(eq(schema.adminAudit.target, target));

  it('flags the posts quoting one an administrator takes down; their answers stay until reviewed, then hide on request', async () => {
    const original = await answeredPost('qr-admin');
    const quote = await quoting('qr-admin-quoter', original, original.reeId);
    const administrator = await consoleAdministrator();
    expect((await posts.adminPosts({ view: 'quotes' })).map((row) => row.id)).not.toContain(quote.postId);

    expect(await posts.adminSetPost(administrator.id, original.postId, false)).toBe(true);
    const queued = (await posts.adminPosts({ view: 'quotes' })).find((row) => row.id === quote.postId);
    expect(queued).toMatchObject({ quoteReview: true, status: 'published' });
    expect(await posts.quoteReviewCount()).toBeGreaterThanOrEqual(1);
    /* The default: still public until an administrator decides. */
    expect(await shownAnswers(quote.postId)).toBe(1);
    expect((await posts.getPost(quote.postId))!.quote).toEqual({ kind: 'post', available: false });

    expect(await posts.adminReviewQuote(administrator.id, quote.postId, 'hide_answers')).toBe(true);
    expect(await shownAnswers(quote.postId)).toBe(0);
    expect((await postRow(quote.postId)).quoteReviewAt).toBeNull();
    expect((await audits(quote.postId)).map((row) => row.action)).toEqual(['post.quote.hide_answers']);
    /* Reviewed once: a second review is stale. */
    expect(await posts.adminReviewQuote(administrator.id, quote.postId, 'keep')).toBe(false);
  });

  it('flags them when reports take the original down too, and keeps their answers when the administrator lets them stand', async () => {
    const original = await answeredPost('qr-reports');
    const quote = await quoting('qr-reports-quoter', original, original.reeId);
    for (let index = 0; index < 3; index += 1) expect(await posts.reportPost(original.postId, `reporter-${crypto.randomUUID()}`)).toBe(true);
    expect((await postRow(original.postId))).toMatchObject({ status: 'hidden', hiddenBy: 'reports' });
    expect((await postRow(quote.postId)).quoteReviewAt).not.toBeNull();

    const administrator = await consoleAdministrator();
    expect(await posts.adminReviewQuote(administrator.id, quote.postId, 'keep')).toBe(true);
    expect(await shownAnswers(quote.postId)).toBe(1);
    expect((await postRow(quote.postId)).quoteReviewAt).toBeNull();
    expect((await audits(quote.postId)).map((row) => row.action)).toEqual(['post.quote.keep']);
  });

  it('folds quotes of one post within the hour into one notice, and tells an author about one quoter at most once a day', async () => {
    const original = await answeredPost('qr-notice');
    const notices = () => db().select().from(schema.notice).where(and(eq(schema.notice.userId, original.author), eq(schema.notice.kind, 'post_quoted')));
    const first = await quoting('qr-notice-a', original, original.reeId);
    const second = await quoting('qr-notice-b', original, original.reeId);
    let rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refId: second.postId, params: { original: original.postId, count: 2 } });

    /* The same quoter again, on the same day: nothing more. */
    const again = await publish(first.quoter, 'Quoting it once more?', { quotePostId: original.postId });
    await posts.processPost(again.id, stub([]));
    rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.params).toMatchObject({ count: 2 });

    /* Once read, the next quoter gets a notice of its own. */
    await db().update(schema.notice).set({ readAt: new Date() }).where(eq(schema.notice.id, rows[0]!.id));
    await quoting('qr-notice-c', original, original.reeId);
    expect(await notices()).toHaveLength(2);
  });

  it('treats the same text quoting something else as another post, within the minute too', async () => {
    const a = await answeredPost('qr-dedup-a');
    const b = await answeredPost('qr-dedup-b');
    const quoter = await user('qr-dedup', FEE * 5);
    const text = 'What does this mean for me?';
    const first = await publish(quoter, text, { quotePostId: a.postId });
    const other = await publish(quoter, text, { quotePostId: b.postId });
    expect(other.id).not.toBe(first.id);
    expect(other.duplicate).toBeUndefined();
    const onAnswer = await publish(quoter, text, { quotePostId: a.postId, quoteAnswerId: a.answerId });
    expect(onAnswer.id).not.toBe(first.id);
    const plain = await publish(quoter, text);
    expect(plain.id).not.toBe(first.id);
    /* The very same quote again is the same submit. */
    expect(await publish(quoter, text, { quotePostId: b.postId })).toMatchObject({ id: other.id, duplicate: true });
  });

  it('lists the quoting posts on any tab of GET /api/posts?quotes=', async () => {
    const original = await answeredPost('qr-feed');
    const quote = await quoting('qr-feed-quoter', original, original.reeId);
    const { GET } = await import('@/app/api/posts/route');
    for (const tab of ['for_you', 'unanswered', 'latest', 'nonsense']) {
      const response = await GET(new NextRequest(`http://localhost:3000/api/posts?tab=${tab}&quotes=${original.postId}`));
      expect(response.status).toBe(200);
      expect(((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([quote.postId]);
    }
  });

  it('renews a share page\'s question token only for a Ree a visitor may ask there', async () => {
    const call = (slug: string, origin = 'http://localhost:3000') =>
      askTokenRoute(new NextRequest(`http://localhost:3000/api/share/${slug}/ask-token`, { method: 'POST', headers: { origin, host: 'localhost:3000' } }), { params: Promise.resolve({ slug }) });
    const free = await publicRee();
    const [row] = await db().select({ slug: schema.ree.slug }).from(schema.ree).where(eq(schema.ree.id, free.reeId));
    const response = await call(row!.slug);
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    expect(await validShareAskToken(token, free.reeId)).toBe(true);
    expect((await call(row!.slug, 'https://evil.example')).status).toBe(403);

    const paid = await publicRee(20);
    const [paidRow] = await db().select({ slug: schema.ree.slug }).from(schema.ree).where(eq(schema.ree.id, paid.reeId));
    expect((await call(paidRow!.slug)).status).toBe(404);
    const hidden = await publicRee();
    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, hidden.reeId));
    const [hiddenRow] = await db().select({ slug: schema.ree.slug }).from(schema.ree).where(eq(schema.ree.id, hidden.reeId));
    expect((await call(hiddenRow!.slug)).status).toBe(404);
    expect((await call('no-such-ree')).status).toBe(404);
  });
});

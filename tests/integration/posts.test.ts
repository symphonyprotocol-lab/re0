/**
 * Public posts (v5, lib/services/posts.ts): the day's free posts and the fee
 * after them -- held at publishing, settled once a Ree answers, given back
 * (with the free post) when review refuses the question or nobody answers;
 * a Ree's choice to answer posts (free by default, paid only when its owner
 * turns it on); answers from a Ree's own knowledge; the cron finishing a
 * post a request left behind; the author's trash; 继续问; the round-table
 * summary; and #158's public Q&A copied in as posts, any number of times.
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
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { POST_FEE, POST_FREE_PER_DAY, POST_SUMMARY_FEE } = await import('@/lib/domain/post');
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

describeWithDb('public posts', () => {
  it('posts the day\'s free ones free, then holds the fee and settles it once a Ree answers', async () => {
    const { reeId } = await publicRee();
    const author = await user('post-author', 200);
    for (let index = 0; index < POST_FREE_PER_DAY; index += 1) {
      const free = await publish(author, `${QUESTION} #${index}`);
      expect(free.charge).toBe('free');
      expect((await postRow(free.id)).freeDay).not.toBeNull();
    }
    expect(await balanceOf(db(), author)).toBe(200);
    expect((await posts.postAllowance(author)).freeLeft).toBe(0);

    const paid = await publish(author);
    expect(paid.charge).toBe('paid');
    expect(await balanceOf(db(), author)).toBe(200 - POST_FEE);
    await posts.processPost(paid.id, stub([reeId]));

    const row = await postRow(paid.id);
    expect(row).toMatchObject({ status: 'published', answerState: 'done', answerCount: 1, candidates: 3, skipped: 2 });
    expect(await balanceOf(db(), author)).toBe(200 - POST_FEE);
    const ledger = await entries(author, paid.id);
    expect(ledger.map((entry) => entry.reason).sort()).toEqual(['post_hold', 'post_settle']);
    expect(ledger.find((entry) => entry.reason === 'post_settle')?.note).toContain(`charged ${POST_FEE} of ${POST_FEE}`);
    /* The author hears about it; the Ree's owner earns nothing. */
    const notices = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.refId, paid.id)));
    expect(notices.map((notice) => notice.kind)).toEqual(['post_answered']);
    const view = await posts.getPost(paid.id);
    expect(view?.answers).toHaveLength(1);
    expect(view?.answers[0]).toMatchObject({ reeId, state: 'answered' });
  });

  it('gives the fee and the free post back when nobody answers', async () => {
    const author = await user('post-unanswered', 100);
    /* Its own text: the same text again within a minute would be the same post (S4). */
    const free = await publish(author, `${QUESTION} first try`);
    await posts.processPost(free.id, stub([]));
    expect(await postRow(free.id)).toMatchObject({ answerState: 'done', answerCount: 0, freeDay: null });
    expect((await posts.postAllowance(author)).freeLeft).toBe(POST_FREE_PER_DAY);

    for (let index = 0; index < POST_FREE_PER_DAY; index += 1) await publish(author, `${QUESTION} free ${index}`);
    const paid = await publish(author);
    expect(await balanceOf(db(), author)).toBe(100 - POST_FEE);
    /* Rees were found but none could answer. */
    const { reeId } = await publicRee();
    await posts.processPost(paid.id, stub([reeId], false));
    expect(await balanceOf(db(), author)).toBe(100);
    expect((await entries(author, paid.id)).map((entry) => entry.reason).sort()).toEqual(['post_hold', 'post_refund']);
    expect((await posts.listFeed('unanswered')).items.map((item) => item.id)).toContain(paid.id);
    expect(await db().select().from(schema.notice).where(eq(schema.notice.refId, paid.id))).toHaveLength(0);
  });

  it('refunds a post review refuses, keeps a failed review for the cron, and refuses a post it cannot pay for', async () => {
    const author = await user('post-refused', POST_FEE);
    for (let index = 0; index < POST_FREE_PER_DAY; index += 1) await publish(author, `${QUESTION} used ${index}`);
    const paid = await publish(author, `${QUESTION} UNPUBLISHABLE`);
    expect(await balanceOf(db(), author)).toBe(0);
    await posts.processPost(paid.id, { judge: async () => ({ publish: false }) });
    expect(await postRow(paid.id)).toMatchObject({ status: 'rejected', answerState: 'done', freeDay: null });
    expect(await balanceOf(db(), author)).toBe(POST_FEE);
    expect(await posts.getPost(paid.id)).toBeNull();
    expect((await posts.getPost(paid.id, author))?.status).toBe('rejected');

    /* The model is down: still pending, and the hourly sweep finishes it once it is up. */
    const pending = await publish(author, `${QUESTION} retried`);
    const failing = async () => {
      throw new Error('down');
    };
    await posts.processPost(pending.id, { judge: failing });
    expect(await postRow(pending.id)).toMatchObject({ status: 'pending', moderationAttempts: 1 });
    await db().update(schema.post).set({ createdAt: new Date(Date.now() - 5 * 60_000) }).where(eq(schema.post.id, pending.id));
    const { reeId } = await publicRee();
    await posts.processStalePosts(stub([reeId]));
    expect(await postRow(pending.id)).toMatchObject({ status: 'published', answerState: 'done', answerCount: 1 });

    const broke = await user('post-broke', 0);
    for (let index = 0; index < POST_FREE_PER_DAY; index += 1) await publish(broke, `${QUESTION} broke ${index}`);
    const refused = await posts.publishPost(broke, { question: QUESTION, lang: 'en' });
    expect(refused).toEqual({ ok: false, error: 'insufficient_credits', balance: 0, needed: POST_FEE });
    expect(await db().select().from(schema.post).where(eq(schema.post.userId, broke))).toHaveLength(POST_FREE_PER_DAY);
  });

  it('rejects a post whose last review never finished and gives its fee back', async () => {
    const author = await user('post-stuck', POST_FEE);
    for (let index = 0; index < POST_FREE_PER_DAY; index += 1) await publish(author, `${QUESTION} stuck ${index}`);
    const paid = await publish(author, `${QUESTION} stuck`);
    expect(await balanceOf(db(), author)).toBe(0);
    await db().update(schema.post).set({ moderationAttempts: 3, createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.post.id, paid.id));
    await posts.processStalePosts(stub([]));
    expect(await postRow(paid.id)).toMatchObject({ status: 'rejected', freeDay: null });
    expect(await balanceOf(db(), author)).toBe(POST_FEE);
  });

  it('counts a visitor\'s reports on an answer once per network', async () => {
    const { reeId } = await publicRee();
    const author = await user('post-reported', 0);
    const posted = await publish(author);
    await posts.processPost(posted.id, stub([reeId]));
    const [answer] = (await posts.getPost(posted.id))!.answers;
    const base = 'http://localhost:3000';
    const send = (ip: string | null, cookie?: string) => {
      const headers: Record<string, string> = { origin: base, host: 'localhost:3000' };
      if (ip) headers['x-real-ip'] = ip;
      if (cookie) headers.cookie = `re0_anon=${cookie}`;
      return reportPost(new NextRequest(`${base}/api/posts/answers/${answer!.id}/report`, { method: 'POST', headers }), { params: Promise.resolve({ answerId: answer!.id }) });
    };
    for (const cookie of [undefined, undefined, crypto.randomUUID()]) expect((await send('198.51.100.9', cookie)).status).toBe(200);
    expect(await db().select().from(schema.postAnswerReport).where(eq(schema.postAnswerReport.answerId, answer!.id))).toHaveLength(1);
    expect((await send(null)).status).toBe(400);
    await send('198.51.100.10');
    await send('198.51.100.11');
    expect((await posts.getPost(posted.id))!.answers).toHaveLength(0);
  });

  it('asks free Rees by default and paid ones only when their owner opts in', async () => {
    const free = await publicRee(0);
    const paid = await publicRee(15);
    const match = (mentionReeId: string) => posts.searchMatcher({ question: QUESTION, mentionReeId, authorId: null });
    const ids = async (mentionReeId: string) => (await match(mentionReeId)).answerers.map((entry) => entry.reeId);
    expect(await ids(free.reeId)).toContain(free.reeId);
    expect(await ids(paid.reeId)).not.toContain(paid.reeId);

    expect(await posts.setAnswersPosts(free.ownerId, paid.reeId, true)).toBeNull();
    expect(await posts.setAnswersPosts(paid.ownerId, paid.reeId, true)).toBe(true);
    expect(await ids(paid.reeId)).toContain(paid.reeId);
    expect(await posts.setAnswersPosts(free.ownerId, free.reeId, false)).toBe(false);
    expect(await ids(free.reeId)).not.toContain(free.reeId);
  });

  it('answers from the Ree\'s own knowledge, with its citations, on the platform', async () => {
    const { reeId } = await publicRee();
    const author = await user('post-real', 0);
    const posted = await publish(author, QUESTION, { mentionReeId: reeId, anonymous: true });
    await posts.processPost(posted.id, { judge: approve });
    const view = await posts.getPost(posted.id);
    expect(view?.author).toEqual({ kind: 'hidden', mine: false });
    const named = view?.answers.find((entry) => entry.reeId === reeId);
    expect(named?.text).toContain('14 days');
    expect(named?.citations.length).toBeGreaterThan(0);
    /* Other Rees in the shared test database may answer too; this one was named. */
    const [answer] = await db().select().from(schema.postAnswer).where(and(eq(schema.postAnswer.postId, posted.id), eq(schema.postAnswer.reeId, reeId)));
    expect(answer).toMatchObject({ mentioned: true, state: 'answered' });
    /* The Ree page lists it under 回答的帖子. */
    expect((await listPublicQa(reeId))?.items.map((item) => item.postId)).toContain(posted.id);
    expect(await balanceOf(db(), author)).toBe(0);
  });

  it('finishes a run that died, and keeps a trashed post from everyone but its author', async () => {
    const { reeId } = await publicRee();
    const author = await user('post-stale', 100);
    for (let index = 0; index < POST_FREE_PER_DAY; index += 1) await publish(author, `${QUESTION} spent ${index}`);
    const paid = await publish(author);
    await db().update(schema.post).set({ status: 'published', publishedAt: new Date(Date.now() - 20 * 60_000), answerState: 'answering' }).where(eq(schema.post.id, paid.id));
    await db().insert(schema.postAnswer).values({ postId: paid.id, reeId, state: 'answering' });
    await posts.processStalePosts();
    expect(await postRow(paid.id)).toMatchObject({ answerState: 'done', answerCount: 0 });
    expect(await balanceOf(db(), author)).toBe(100);

    const shown = await publish(author, `${QUESTION} shown`);
    await posts.processPost(shown.id, stub([reeId]));
    expect((await posts.listFeed('latest')).items.map((item) => item.id)).toContain(shown.id);
    expect(await posts.setPostTrashed(await user('post-stranger'), shown.id, true)).toBe(false);
    expect(await posts.setPostTrashed(author, shown.id, true)).toBe(true);
    expect((await posts.listFeed('latest')).items.map((item) => item.id)).not.toContain(shown.id);
    expect(await posts.getPost(shown.id)).toBeNull();
    expect((await posts.getPost(shown.id, author))?.deleted).toBe(true);
    expect((await posts.listMyPosts(author, 'trash')).items.map((item) => item.id)).toEqual([shown.id]);
    expect(await posts.setPostTrashed(author, shown.id, false)).toBe(true);
    expect(await posts.getPost(shown.id)).not.toBeNull();
  });

  it('lets the author follow up privately and summarize the answers for everyone', async () => {
    const first = await publicRee();
    const second = await publicRee();
    const author = await user('post-summary', 100);
    const posted = await publish(author);
    await posts.processPost(posted.id, stub([first.reeId, second.reeId]));
    const view = (await posts.getPost(posted.id, author))!;
    expect(view.answers).toHaveLength(2);

    const conversationId = await posts.followUpPost(author, posted.id, view.answers[0]!.id);
    const messages = await db().select().from(schema.message).where(eq(schema.message.conversationId, conversationId!));
    expect(messages.map((message) => message.role).sort()).toEqual(['ree', 'user']);
    expect((await posts.getPost(posted.id, author))?.followUps.map((entry) => entry.id)).toEqual([conversationId]);
    /* Only the author sees their follow-ups. */
    expect((await posts.getPost(posted.id))?.followUps).toEqual([]);

    expect(await posts.summarizePost(await user('post-other', 100), posted.id, 'en')).toBe('not_found');
    expect(await posts.summarizePost(author, posted.id, 'en')).toBe('done');
    expect(await balanceOf(db(), author)).toBe(100 - POST_SUMMARY_FEE);
    expect(await posts.summarizePost(author, posted.id, 'en')).toBe('already');
    expect((await posts.getPost(posted.id))?.summary?.state).toBe('done');
  });

  it('copies #158\'s public Q&A in as posts, any number of times, with their votes, reports and pins', async () => {
    const { reeId } = await publicRee();
    const voter = await user('post-voter');
    const [shown, hidden] = await db()
      .insert(schema.reePublicQa)
      .values([
        { reeId, source: 'anonymous', question: 'Legacy shown?', answer: 'Yes [1].', lang: 'en', status: 'published', publishedAt: new Date(), helpfulCount: 1, pinnedAt: new Date() },
        { reeId, source: 'share', question: 'Legacy hidden?', answer: 'No.', lang: 'en', status: 'hidden', hiddenBy: 'reports', reportCount: 3, publishedAt: new Date() },
      ])
      .returning({ id: schema.reePublicQa.id });
    await db().insert(schema.reePublicQa).values({ reeId, source: 'anonymous', question: 'Legacy rejected?', answer: 'Hm.', lang: 'en', status: 'rejected' });
    await db().insert(schema.reePublicQaVote).values({ qaId: shown!.id, userId: voter });
    await db().insert(schema.reePublicQaReport).values({ qaId: hidden!.id, reporterKey: 'anon:x' });

    expect(await syncPublicQa()).toBeGreaterThanOrEqual(2);
    await syncPublicQa();
    const copied = await db().select().from(schema.post).where(sql`${schema.post.legacyQaId} in (${shown!.id}, ${hidden!.id})`);
    expect(copied).toHaveLength(2);
    const answers = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.reeId, reeId));
    expect(answers).toHaveLength(2);
    expect(answers.find((row) => row.legacyQaId === hidden!.id)).toMatchObject({ hiddenBy: 'reports', reportCount: 3 });
    const kept = answers.find((row) => row.legacyQaId === shown!.id)!;
    expect(kept.pinnedAt).not.toBeNull();
    expect(await db().select().from(schema.postAnswerVote).where(eq(schema.postAnswerVote.answerId, kept.id))).toHaveLength(1);
    expect(await db().select().from(schema.postAnswerReport).where(eq(schema.postAnswerReport.answerId, answers.find((row) => row.legacyQaId === hidden!.id)!.id))).toHaveLength(1);

    const page = (await listPublicQa(reeId, { viewerId: voter }))!;
    expect(page.items.map((item) => item.question)).toEqual(['Legacy shown?']);
    expect(page.items[0]).toMatchObject({ pinned: true, voted: true, helpful: 1, asker: 'visitor' });
    /* A copied post with no answer left to show stays out of the feeds. */
    expect((await posts.listFeed('latest')).items.map((item) => item.question)).not.toContain('Legacy hidden?');
    expect((await posts.listFeed('unanswered')).items.map((item) => item.question)).not.toContain('Legacy hidden?');
  });
});

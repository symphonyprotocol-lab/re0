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

describeWithDb('public posts', () => {
  it('costs nothing to post, and charges each free Ree\'s answer the base fee once it answers (per-answer billing, 2026-11-19)', async () => {
    const first = await publicRee();
    const second = await publicRee();
    const author = await user('post-author', 200);
    const posted = await publish(author);
    expect(await balanceOf(db(), author)).toBe(200);
    expect(await posts.postAllowance(author)).toMatchObject({ balance: 200, baseFee: QUERY_BASE_FEE, maxAnswers: POST_MAX_ANSWERS, maxCost: POST_MAX_ANSWERS * QUERY_BASE_FEE, postedToday: 1 });
    await posts.processPost(posted.id, stub([first.reeId, second.reeId]));

    const row = await postRow(posted.id);
    expect(row).toMatchObject({ status: 'published', answerState: 'done', answerCount: 2, candidates: 4, skipped: 2 });
    expect(await balanceOf(db(), author)).toBe(200 - 2 * QUERY_BASE_FEE);
    /* Each answer is a question to that Ree on the ledger: held, then the base fee, to the platform. */
    const answers = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, posted.id));
    for (const entry of answers) {
      expect(entry).toMatchObject({ price: QUERY_BASE_FEE, feeHoldId: null });
      expect((await entries(author, entry.id)).map((item) => item.reason).sort()).toEqual(['query_base', 'query_hold']);
    }
    /* The author hears about it; the Rees' owners earn nothing. */
    const notices = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.refId, posted.id)));
    expect(notices.map((notice) => notice.kind)).toEqual(['post_answered']);
    expect(await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, first.ownerId), eq(schema.creditEntry.reason, 'query_fee_earned')))).toHaveLength(0);
    const view = await posts.getPost(posted.id, author);
    expect(view?.answers.map((entry) => ({ state: entry.state, paid: entry.paid }))).toEqual([{ state: 'answered', paid: false }, { state: 'answered', paid: false }]);
    expect(view?.spent).toBe(2 * QUERY_BASE_FEE);
    expect((await posts.getPost(posted.id))?.spent).toBeNull();
  });

  it('charges nothing for an answer not given, and nothing when nobody answers', async () => {
    const author = await user('post-unanswered', 100);
    const nobody = await publish(author, `${QUESTION} first try`);
    await posts.processPost(nobody.id, stub([]));
    expect(await postRow(nobody.id)).toMatchObject({ answerState: 'done', answerCount: 0 });
    /* No Ree answered: nothing for the Rees; the author's AI general answer (ai-answers.ts) takes the base fee instead. */
    expect(await balanceOf(db(), author)).toBe(100 - QUERY_BASE_FEE);

    /* Rees were found but none could answer: their holds come back. */
    const { reeId } = await publicRee();
    const posted = await publish(author);
    await posts.processPost(posted.id, stub([reeId], false));
    expect(await balanceOf(db(), author)).toBe(100 - 2 * QUERY_BASE_FEE);
    const [row] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, posted.id));
    expect((await entries(author, row!.id)).map((entry) => entry.reason).sort()).toEqual(['query_hold', 'query_refund']);
    expect((await posts.listFeed('unanswered')).items.map((item) => item.id)).toContain(posted.id);
    /* No answer notice; only the AI answer's. */
    expect((await db().select().from(schema.notice).where(eq(schema.notice.refId, posted.id))).map((entry) => entry.kind)).toEqual(['post_ai_answer']);
  });

  it('charges nothing for a post review refuses, keeps a failed review for the cron, and refuses a post below one base fee', async () => {
    const author = await user('post-refused', QUERY_BASE_FEE);
    const refusedPost = await publish(author, `${QUESTION} UNPUBLISHABLE`);
    await posts.processPost(refusedPost.id, { judge: async () => ({ publish: false }) });
    expect(await postRow(refusedPost.id)).toMatchObject({ status: 'rejected', answerState: 'done' });
    expect(await balanceOf(db(), author)).toBe(QUERY_BASE_FEE);
    expect(await posts.getPost(refusedPost.id)).toBeNull();
    expect((await posts.getPost(refusedPost.id, author))?.status).toBe('rejected');

    /* The model is down: still pending, and the sweep finishes it once it is up. */
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
    expect(await balanceOf(db(), author)).toBe(0);

    /* Below one base fee no answer could be paid: posting is refused, with a top-up. */
    const refused = await posts.publishPost(author, { question: `${QUESTION} broke`, lang: 'en' });
    expect(refused).toEqual({ ok: false, error: 'insufficient_credits', balance: 0, needed: QUERY_BASE_FEE });
    expect(await posts.postAllowance(author)).toMatchObject({ balance: 0, baseFee: QUERY_BASE_FEE });
  });

  it('rejects a post whose last review never finished, charging nothing', async () => {
    const author = await user('post-stuck', QUERY_BASE_FEE);
    const stuck = await publish(author, `${QUESTION} stuck`);
    await db().update(schema.post).set({ moderationAttempts: 3, createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(schema.post.id, stuck.id));
    await posts.processStalePosts(stub([]));
    expect(await postRow(stuck.id)).toMatchObject({ status: 'rejected' });
    expect(await balanceOf(db(), author)).toBe(QUERY_BASE_FEE);
  });

  it('counts a visitor\'s reports on an answer once per network', async () => {
    const { reeId } = await publicRee();
    const author = await user('post-reported', 1_000);
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
    const author = await user('post-real', 1_000);
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
    /* Each answer given cost the author the base fee (other test Rees may have answered too). */
    const spent = (await posts.getPost(posted.id, author))!.spent!;
    expect(spent).toBeGreaterThanOrEqual(QUERY_BASE_FEE);
    expect(spent % QUERY_BASE_FEE).toBe(0);
    expect(await balanceOf(db(), author)).toBe(1_000 - spent);
  });

  it('finishes a run that died, and keeps a trashed post from everyone but its author', async () => {
    const { reeId } = await publicRee();
    const author = await user('post-stale', 100);
    const paid = await publish(author);
    await db().update(schema.post).set({ status: 'published', publishedAt: new Date(Date.now() - 20 * 60_000), answerState: 'answering' }).where(eq(schema.post.id, paid.id));
    /* The run died holding an answer's base fee: the sweep marks it failed and gives the fee back. */
    const [row] = await db().insert(schema.postAnswer).values({ postId: paid.id, reeId, state: 'answering' }).returning({ id: schema.postAnswer.id });
    const baseHoldId = await db().transaction((tx) => placeHold(tx, { userId: author, kind: 'post', ledger: 'post_answer', amount: QUERY_BASE_FEE, refId: row!.id, reeId }));
    await db().update(schema.postAnswer).set({ baseHoldId, price: QUERY_BASE_FEE }).where(eq(schema.postAnswer.id, row!.id));
    expect(await balanceOf(db(), author)).toBe(100 - QUERY_BASE_FEE);
    await posts.processStalePosts();
    expect(await postRow(paid.id)).toMatchObject({ answerState: 'done', answerCount: 0 });
    /* The Ree's fee came back; settled with no Ree answer, the author got the AI answer its run never reached, at the base fee. */
    expect(await balanceOf(db(), author)).toBe(100 - QUERY_BASE_FEE);
    expect((await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.postId, paid.id)))[0]?.state).toBe('answered');

    const shown = await publish(author, `${QUESTION} shown`);
    await posts.processPost(shown.id, stub([reeId]));
    expect((await posts.listFeed('latest')).items.map((item) => item.id)).toContain(shown.id);
    expect(await posts.setPostTrashed(await user('post-stranger', 1_000), shown.id, true)).toBe(false);
    expect(await posts.setPostTrashed(author, shown.id, true)).toBe(true);
    expect((await posts.listFeed('latest')).items.map((item) => item.id)).not.toContain(shown.id);
    expect(await posts.getPost(shown.id)).toBeNull();
    expect((await posts.getPost(shown.id, author))?.deleted).toBe(true);
    expect((await posts.listMyPosts(author, 'trash')).items.map((item) => item.id)).toEqual([shown.id]);
    expect(await posts.setPostTrashed(author, shown.id, false)).toBe(true);
    expect(await posts.getPost(shown.id)).not.toBeNull();
  });

  it('lets the author summarize the answers for everyone', async () => {
    const first = await publicRee();
    const second = await publicRee();
    const author = await user('post-summary', 100);
    const posted = await publish(author);
    await posts.processPost(posted.id, stub([first.reeId, second.reeId]));
    const view = (await posts.getPost(posted.id, author))!;
    expect(view.answers).toHaveLength(2);

    expect(await posts.summarizePost(await user('post-other', 100), posted.id, 'en')).toBe('not_found');
    expect(await posts.summarizePost(author, posted.id, 'en')).toBe('done');
    /* The two answers cost their base fees; the summary its own fee. */
    expect(await balanceOf(db(), author)).toBe(100 - 2 * QUERY_BASE_FEE - POST_SUMMARY_FEE);
    expect(await posts.summarizePost(author, posted.id, 'en')).toBe('already');
    expect((await posts.getPost(posted.id))?.summary?.state).toBe('done');
  });

  it('copies #158\'s public Q&A in as posts, any number of times, with their votes, reports and pins', async () => {
    const { reeId } = await publicRee();
    const voter = await user('post-voter', 1_000);
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

/**
 * The rebuild → main release review (2026-11-21), its "should fix" items:
 *   S1  请 Ree 回答 on a free Ree holds the base fee in the request's own
 *       transaction, and the sweep gives it back when no run finished it.
 *   S2  the posts sweep checks its budget before every row.
 *   S3  a dead run is timed from its claim (`answering_at`), and a base fee
 *       is held only while its answer still runs.
 *   S4  chat holds the release left open are given back by the posts cron.
 *   S5  an AI answer anyone reads can be reported and taken down, and an
 *       administrator hides or restores it on its own.
 *   S7  the rail's 待回答 count is reused for a minute.
 * (S6, the cover's cache, is in post-cover.test.ts; B2 in posts-round3.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName, uniqueWord } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { AiAnswerer } from '@/lib/services/ai-answers';
import type { Matcher } from '@/lib/services/posts';
import type { Judge } from '@/lib/services/public-qa';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const posts = await import('@/lib/services/posts');
const ai = await import('@/lib/services/ai-answers');
const credits = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { QUERY_BASE_FEE: BASE } = await import('@/lib/constants');
const { AI_ANSWER_FEE, POST_PAID_ANSWER_STALE_MS, POST_ANSWERING_STALE_MS } = await import('@/lib/domain/post');
const { PUBLIC_QA_REPORT_THRESHOLD } = await import('@/lib/domain/public-qa');
const { consoleAdministrator } = await import('../fixtures/console-administrator');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  await fake?.close();
});

async function user(prefix: string, credit = 0) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
  if (credit > 0) await db().transaction((tx) => credits.addGrant(tx, { userId, source: 'pack', amount: credit, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

/** A public, free Ree with ready knowledge. */
async function makeRee() {
  const owner = await user('rr-owner', 1_000);
  await rees.saveDraft(owner, { ...newReeDraft(), name: uniqueName('Plant desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(owner);
  const id = await knowledge.addKnowledge(owner, ree, { kind: 'text', title: 'Watering', content: 'Water a monstera once the top five centimetres of soil are dry.' });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true, queryFee: 0 }).where(eq(schema.ree.id, ree.id));
  return { ownerId: owner, reeId: ree.id };
}

const approve: Judge = async () => ({ publish: true });
const noMatch: Matcher = async () => ({ answerers: [], candidates: 4, skipped: 4, vector: null });
const aiStub: AiAnswerer = async () => ({ text: 'Water less often and check the drainage.', model: 'free-stub' });

/** A public post nothing matched: done, unanswered, with an AI answer that passed review. */
async function unansweredPost(author: string) {
  const posted = await posts.publishPost(author, { question: `Why are my monstera leaves yellow? ${uniqueWord('ask')}`, lang: 'en' });
  if (!posted.ok) throw new Error(posted.error);
  await posts.processPost(posted.id, { judge: approve, match: noMatch, aiAnswer: aiStub });
  return posted.id;
}

const answerRow = async (id: string) => (await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.id, id)))[0]!;
const postRow = async (id: string) => (await db().select().from(schema.post).where(eq(schema.post.id, id)))[0]!;
const holdRow = async (id: string) => (await db().select().from(schema.creditHold).where(eq(schema.creditHold.id, id)))[0]!;

describeWithDb('release review fixes', () => {
  it('holds a free requested Ree\'s base fee with the request, and gives it back when no run finished it (S1)', async () => {
    const free = await makeRee();
    const second = await makeRee();
    const author = await user('rr-request', 200);
    const id = await unansweredPost(author);
    const start = await credits.balanceOf(db(), author);

    const made = await posts.requestReeAnswer(author, id, free.reeId);
    expect(made).toMatchObject({ ok: true, state: 'answering' });
    const asked = await answerRow((made as { id: string }).id);
    expect(asked.baseHoldId).not.toBeNull();
    expect(asked.decidedAt).toBeNull();
    expect(await credits.balanceOf(db(), author)).toBe(start - BASE);
    expect(await posts.requestReeAnswer(author, id, second.reeId)).toEqual({ ok: false, error: 'busy' });

    /* Its background answer never ran: before the stale time nothing moves, after it the hold comes back. */
    await posts.sweepPaidRequests(new Date());
    expect((await answerRow(asked.id)).state).toBe('answering');
    await posts.sweepPaidRequests(new Date(Date.now() + POST_PAID_ANSWER_STALE_MS + 60_000));
    expect((await answerRow(asked.id)).state).toBe('failed');
    expect((await holdRow(asked.baseHoldId!)).status).toBe('released');
    expect(await credits.balanceOf(db(), author)).toBe(start);
    /* No longer busy: another Ree may be asked. */
    expect(await posts.requestReeAnswer(author, id, second.reeId)).toMatchObject({ ok: true, state: 'answering' });
  });

  it('turns a free request the balance cannot cover into a card, in the same transaction (S1)', async () => {
    const free = await makeRee();
    const author = await user('rr-short', AI_ANSWER_FEE + BASE);
    const id = await unansweredPost(author);
    await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, author));
    const made = await posts.requestReeAnswer(author, id, free.reeId);
    expect(made).toMatchObject({ ok: true, state: 'awaiting' });
    const row = await answerRow((made as { id: string }).id);
    expect(row).toMatchObject({ state: 'awaiting', baseHoldId: null });
  });

  it('holds a base fee only while its answer still runs (S3)', async () => {
    const free = await makeRee();
    const author = await user('rr-settled', 200);
    const id = await unansweredPost(author);
    const start = await credits.balanceOf(db(), author);
    /* A sweep settled the run meanwhile: the answer is failed before the run gets to hold for it. */
    const [row] = await db().insert(schema.postAnswer).values({ postId: id, reeId: free.reeId, state: 'failed' }).returning();
    expect(await posts.holdBaseFee(author, row!.id, free.reeId, new Date())).toBe(false);
    expect((await answerRow(row!.id)).baseHoldId).toBeNull();
    expect(await credits.balanceOf(db(), author)).toBe(start);
    const holds = await db().select().from(schema.creditHold).where(eq(schema.creditHold.refId, row!.id));
    expect(holds).toEqual([]);
  });

  it('times a dead run from its claim, not from publishing (S3), and stops between rows when the budget is spent (S2)', async () => {
    const author = await user('rr-dead', 200);
    const id = await unansweredPost(author);
    const now = new Date();
    /* Published long ago, claimed just now (a backlog): a live run, not a dead one. */
    await db().update(schema.post).set({ answerState: 'answering', publishedAt: new Date(now.getTime() - 3 * POST_ANSWERING_STALE_MS), answeringAt: now }).where(eq(schema.post.id, id));
    const deps = { judge: approve, match: noMatch, aiAnswer: aiStub };
    await posts.processStalePosts(deps, { now, budgetMs: 60_000, concurrency: 1 });
    expect((await postRow(id)).answerState).toBe('answering');

    /* No budget left: nothing is started, the dead run waits for the next sweep. */
    const later = new Date(now.getTime() + POST_ANSWERING_STALE_MS + 60_000);
    expect(await posts.processStalePosts(deps, { now: later, budgetMs: 0, concurrency: 1 })).toBe(0);
    expect((await postRow(id)).answerState).toBe('answering');

    await posts.processStalePosts(deps, { now: later, budgetMs: 60_000, concurrency: 1 });
    expect((await postRow(id)).answerState).toBe('done');
  });

  it('reviews no AI answer once the sweep\'s budget is spent (S2)', async () => {
    const author = await user('rr-review', 200);
    const posted = await posts.publishPost(author, { question: `Why do my orchid roots rot? ${uniqueWord('ask')}`, lang: 'en' });
    if (!posted.ok) throw new Error(posted.error);
    /* The answer's review cannot run now: it waits, pending, for the sweep. */
    await posts.processPost(posted.id, { judge: async (_question, answer) => {
      if (answer) throw new Error('review down');
      return { publish: true };
    }, match: noMatch, aiAnswer: aiStub });
    const [row] = await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.postId, posted.id));
    expect(row!.review).toBe('pending');
    const later = new Date(Date.now() + 120_000);
    await ai.sweepAiAnswers(later, { judge: approve }, { budgetMs: 0 });
    expect((await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.id, row!.id)))[0]!.review).toBe('pending');
    await ai.sweepAiAnswers(later, { judge: approve }, { budgetMs: 60_000 });
    expect((await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.id, row!.id)))[0]!.review).toBe('passed');
  });

  it('gives back chat holds the release left open (S4)', async () => {
    const asker = await user('rr-chat', 100);
    const refId = crypto.randomUUID();
    const holdId = await db().transaction((tx) => credits.placeHold(tx, { userId: asker, kind: 'chat' as never, amount: BASE, refId, note: 'chat' }));
    expect(await credits.balanceOf(db(), asker)).toBe(100 - BASE);
    /* A fresh one may still belong to a live old request: left alone. */
    expect(await credits.releaseLegacyChatHolds(new Date())).toBe(0);
    expect((await holdRow(holdId)).status).toBe('held');
    expect(await credits.releaseLegacyChatHolds(new Date(Date.now() + 11 * 60_000))).toBeGreaterThanOrEqual(1);
    expect((await holdRow(holdId)).status).toBe('released');
    expect(await credits.balanceOf(db(), asker)).toBe(100);
    const entries = await db().select({ reason: schema.creditEntry.reason, delta: schema.creditEntry.delta }).from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, asker), eq(schema.creditEntry.refId, refId)));
    expect(entries).toContainEqual({ reason: 'query_refund', delta: BASE });
  });

  it('takes a reported AI answer down, and lets an administrator hide or restore it on its own (S5)', async () => {
    const author = await user('rr-ai-author', 200);
    const reader = await user('rr-ai-reader');
    const id = await unansweredPost(author);
    const [row] = await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.postId, id));
    expect(row!.review).toBe('passed');
    expect((await posts.getPost(id, reader))!.aiAnswer).toMatchObject({ id: row!.id, mine: false });

    /* Reported: counted once per reporter, listed among the reported posts. */
    expect(await ai.reportAiAnswer(row!.id, `user:${reader}`)).toBe(true);
    expect(await ai.reportAiAnswer(row!.id, `user:${reader}`)).toBe(true);
    expect((await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.id, row!.id)))[0]!.reportCount).toBe(1);
    const reported = (await posts.adminPosts({ view: 'reported', limit: 500 })).find((entry) => entry.id === id);
    expect(reported?.ai).toEqual([{ id: row!.id, postId: id, followup: false, hidden: false, hiddenBy: null, reports: 1 }]);

    /* At the threshold: refused, so only its asker reads it. */
    for (let n = 1; n < PUBLIC_QA_REPORT_THRESHOLD; n += 1) expect(await ai.reportAiAnswer(row!.id, `net:${n}`)).toBe(true);
    expect((await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.id, row!.id)))[0]).toMatchObject({ review: 'rejected', hiddenBy: 'reports' });
    expect((await posts.getPost(id, reader))!.aiAnswer).toBeNull();
    expect((await posts.getPost(id))!.aiAnswer).toBeNull();
    expect((await posts.getPost(id, author))!.aiAnswer).toMatchObject({ id: row!.id, mine: true, review: 'rejected' });
    /* Nobody else can read it, so nobody can report it again. */
    expect(await ai.reportAiAnswer(row!.id, 'net:late')).toBe(false);

    /* An administrator restores it (reports cleared), then hides it on their own; both in the log. */
    const administrator = await consoleAdministrator();
    expect(await ai.adminSetAiAnswer(administrator.id, row!.id, false)).toBe(false);
    expect(await ai.adminSetAiAnswer(administrator.id, row!.id, true)).toBe(true);
    expect((await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.id, row!.id)))[0]).toMatchObject({ review: 'passed', hiddenBy: null, reportCount: 0 });
    expect(await db().select().from(schema.postAiAnswerReport).where(eq(schema.postAiAnswerReport.aiAnswerId, row!.id))).toEqual([]);
    expect((await posts.getPost(id, reader))!.aiAnswer).toMatchObject({ id: row!.id });
    expect(await ai.adminSetAiAnswer(administrator.id, row!.id, true)).toBe(false);
    expect(await ai.adminSetAiAnswer(administrator.id, row!.id, false)).toBe(true);
    expect((await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.id, row!.id)))[0]).toMatchObject({ review: 'rejected', hiddenBy: 'admin' });
    expect((await posts.getPost(id, reader))!.aiAnswer).toBeNull();
    /* The post itself and its other counts stay. */
    expect((await postRow(id)).status).toBe('published');
    const logged = await db().select({ action: schema.adminAudit.action }).from(schema.adminAudit).where(eq(schema.adminAudit.target, row!.id));
    expect(logged.map((entry) => entry.action).sort()).toEqual(['post.ai.hide', 'post.ai.restore']);
  });

  it('reports nothing of a private post\'s AI answer (S5)', async () => {
    const author = await user('rr-ai-private', 200);
    const id = await unansweredPost(author);
    await db().update(schema.post).set({ visibility: 'private' }).where(eq(schema.post.id, id));
    const [row] = await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.postId, id));
    expect(await ai.reportAiAnswer(row!.id, 'net:x')).toBe(false);
  });

  it('counts the rail\'s 待回答 at most once a minute (S7)', async () => {
    const author = await user('rr-count', 200);
    const at = Date.now() + 10 * 3_600_000;
    const before = await posts.unansweredCount(at);
    await unansweredPost(author);
    expect(await posts.unansweredCount(at + 1_000)).toBe(before);
    expect(await posts.unansweredCount(at + posts.UNANSWERED_COUNT_TTL_MS + 1)).toBe(before + 1);
  });
});

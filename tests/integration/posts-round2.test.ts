/**
 * Public posts after review round 2 (2026-11-19): taking a post down by
 * reports or an administrator (B2), the round-table summary's review and
 * staleness (S1), answered lists following the Ree's current visibility
 * (S2), 继续问 for the author only and out of every Ree figure (S3), one post
 * per submit (S4), the sweep's batches and budget (S5), and a late answer
 * after settlement (O4).
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
const { QUERY_BASE_FEE } = await import('@/lib/constants');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { POST: reportPostRoute } = await import('@/app/api/posts/[id]/report/route');
const { reeCards } = await import('@/lib/services/explore');
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


const base = 'http://localhost:3000';
function reportAs(postId: string, ip: string) {
  return reportPostRoute(new NextRequest(`${base}/api/posts/${postId}/report`, { method: 'POST', headers: { origin: base, host: 'localhost:3000', 'x-real-ip': ip } }), { params: Promise.resolve({ id: postId }) });
}

describeWithDb('public posts, review round 2', () => {
  it('takes a post down after three distinct reporters, everywhere but for its author, until an administrator restores it (B2)', async () => {
    const { reeId } = await publicRee();
    const author = await user('r2-reported', 1_000);
    const posted = await publish(author);
    await posts.processPost(posted.id, stub([reeId]));
    expect((await posts.listFeed('latest')).items.map((item) => item.id)).toContain(posted.id);
    /* Two /64s of one /48 are one reporter; a signed-in reporter is another. */
    await reportAs(posted.id, '2001:db8:9:1::1');
    await reportAs(posted.id, '2001:db8:9:2::1');
    expect(await posts.reportPost(posted.id, `user:${await user('r2-reporter', 1_000)}`)).toBe(true);
    expect((await postRow(posted.id)).status).toBe('published');
    await reportAs(posted.id, '198.51.100.40');
    expect(await postRow(posted.id)).toMatchObject({ status: 'hidden', hiddenBy: 'reports', reportCount: 3 });

    expect((await posts.listFeed('latest')).items.map((item) => item.id)).not.toContain(posted.id);
    expect((await posts.listFeed('latest', { q: 'refunds issued' })).items.map((item) => item.id)).not.toContain(posted.id);
    expect(await posts.getPost(posted.id)).toBeNull();
    expect(await posts.postMeta(posted.id)).toBeNull();
    expect((await posts.indexablePosts()).map((row) => row.id)).not.toContain(posted.id);
    expect((await listPublicQa(reeId))?.items.map((item) => item.postId)).not.toContain(posted.id);
    expect((await posts.getPost(posted.id, author))).toMatchObject({ status: 'hidden', hiddenBy: 'reports' });
    expect(await posts.reportPost(posted.id, 'anon-ip:late')).toBe(false);

    const administrator = await consoleAdministrator();
    expect((await posts.adminPosts({ view: 'hidden' })).map((row) => row.id)).toContain(posted.id);
    expect(await posts.adminSetPost(administrator.id, posted.id, true)).toBe(true);
    expect(await postRow(posted.id)).toMatchObject({ status: 'published', hiddenBy: null, reportCount: 0 });
    expect(await posts.getPost(posted.id)).not.toBeNull();
    expect(await posts.adminSetPost(administrator.id, posted.id, false)).toBe(true);
    expect(await postRow(posted.id)).toMatchObject({ status: 'hidden', hiddenBy: 'admin' });
    expect(await posts.adminSetPost(administrator.id, posted.id, false)).toBe(false);
    const audits = await db().select({ action: schema.adminAudit.action }).from(schema.adminAudit).where(eq(schema.adminAudit.target, posted.id));
    expect(audits.map((row) => row.action).sort()).toEqual(['post.hide', 'post.restore']);
  });

  it('reviews the summary, withdraws it when an answer it used is hidden, and writes it again free (S1)', async () => {
    const first = await publicRee();
    const second = await publicRee();
    const third = await publicRee();
    const author = await user('r2-summary', 100);
    const posted = await publish(author);
    await posts.processPost(posted.id, stub([first.reeId, second.reeId, third.reeId]));
    /* The three answers cost their base fees; the summary is charged on top. */
    const start = await balanceOf(db(), author);
    expect(start).toBe(100 - 3 * QUERY_BASE_FEE);

    /* Refused by review: nothing shown, the fee back. */
    expect(await posts.summarizePost(author, posted.id, 'en', async () => ({ publish: false }))).toBe('rejected');
    expect(await balanceOf(db(), author)).toBe(start);
    expect((await posts.getPost(posted.id))?.summary).toBeNull();

    expect(await posts.summarizePost(author, posted.id, 'en', approve)).toBe('done');
    expect(await balanceOf(db(), author)).toBe(start - POST_SUMMARY_FEE);
    const used = (await postRow(posted.id)).summaryAnswers!;
    expect(used).toHaveLength(3);

    /* The owner of one answering Ree hides its answer: the summary is withdrawn for everyone. */
    const [hidden] = await db().select().from(schema.postAnswer).where(and(eq(schema.postAnswer.postId, posted.id), eq(schema.postAnswer.reeId, first.reeId)));
    expect(await posts.ownerActOnAnswer(first.ownerId, first.reeId, hidden!.id, 'hide')).toBe(true);
    expect((await posts.getPost(posted.id))?.summary).toBeNull();
    expect((await posts.getPost(posted.id, author))?.summaryStale).toBe(true);

    expect(await posts.summarizePost(author, posted.id, 'en', approve)).toBe('done');
    expect(await balanceOf(db(), author)).toBe(start - POST_SUMMARY_FEE);
    expect((await postRow(posted.id)).summaryAnswers).toHaveLength(2);
    expect((await posts.getPost(posted.id))?.summary?.state).toBe('done');
    expect(await posts.summarizePost(author, posted.id, 'en', approve)).toBe('already');
  });

  it('lists a post as answered only while an answering Ree is visible (S2)', async () => {
    const { reeId } = await publicRee();
    const author = await user('r2-visibility', 1_000);
    const posted = await publish(author);
    await posts.processPost(posted.id, stub([reeId]));
    expect((await posts.indexablePosts()).map((row) => row.id)).toContain(posted.id);

    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, reeId));
    expect((await posts.listFeed('for_you')).items.map((item) => item.id)).not.toContain(posted.id);
    expect((await posts.indexablePosts()).map((row) => row.id)).not.toContain(posted.id);
    expect((await posts.postMeta(posted.id))?.answered).toBe(0);
    expect((await posts.listFeed('unanswered')).items.map((item) => item.id)).toContain(posted.id);

    await db().update(schema.ree).set({ isPublic: true, isPublished: true }).where(eq(schema.ree.id, reeId));
    expect((await posts.indexablePosts()).map((row) => row.id)).toContain(posted.id);
  });

  it('publishes once per submit: the same token, or the same text within a minute (S4)', async () => {
    const author = await user('r2-twice', QUERY_BASE_FEE);
    const token = crypto.randomUUID();
    const first = await publish(author, `${QUESTION} once`, { clientToken: token });
    const again = await publish(author, `${QUESTION} once, edited`, { clientToken: token });
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    const same = await publish(author, `${QUESTION} once`);
    expect(same).toMatchObject({ id: first.id, duplicate: true });
    /* One post; posting holds nothing (answers are charged on their own). */
    expect(await db().select().from(schema.post).where(eq(schema.post.userId, author))).toHaveLength(1);
    expect(await balanceOf(db(), author)).toBe(QUERY_BASE_FEE);
  });

  it('keeps an answer that arrives after settlement as failed (O4)', async () => {
    const { reeId } = await publicRee();
    const author = await user('r2-late', QUERY_BASE_FEE);
    const posted = await publish(author);
    await posts.processPost(posted.id, {
      judge: approve,
      match: async () => ({ answerers: [{ reeId, similarity: 0.8, mentioned: false }], candidates: 1, skipped: 0, vector: null }),
      answerOne: async () => {
        /* The sweep settles the post while this answer is still being written. */
        await posts.finishPost(posted.id);
        return { state: 'answered', text: 'Too late.', citations: [], model: 'stub' };
      },
    });
    const [answer] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, posted.id));
    expect(answer?.state).toBe('failed');
    expect(await postRow(posted.id)).toMatchObject({ answerCount: 0, answerState: 'done' });
    /* Its base fee came back with it; the late answer charged nothing. Settled with no Ree answer, the AI general answer took the base fee instead. */
    expect(await db().select({ reason: schema.creditEntry.reason }).from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, author), eq(schema.creditEntry.reason, 'query_base')))).toEqual([]);
    expect((await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.postId, posted.id)))[0]?.state).toBe('answered');
    expect(await balanceOf(db(), author)).toBe(0);
  });

  it('sweeps posts left behind several at a time, within its budget (S5)', async () => {
    const { reeId } = await publicRee();
    const author = await user('r2-sweep', 1_000);
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) ids.push((await publish(author, `${QUESTION} sweep ${index}`)).id);
    await db().update(schema.post).set({ createdAt: new Date(Date.now() - 5 * 60_000) }).where(inArray(schema.post.id, ids));
    /* No budget: nothing new is started. */
    await posts.processStalePosts(stub([reeId]), { budgetMs: 0 });
    expect((await db().select().from(schema.post).where(inArray(schema.post.id, ids))).every((row) => row.status === 'pending')).toBe(true);
    await posts.processStalePosts(stub([reeId]), { concurrency: 2, budgetMs: 60_000 });
    const rows = await db().select().from(schema.post).where(inArray(schema.post.id, ids));
    expect(rows.every((row) => row.status === 'published' && row.answerState === 'done' && row.answerCount === 1)).toBe(true);
  });
});

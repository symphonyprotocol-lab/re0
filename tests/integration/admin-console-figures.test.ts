/**
 * The console's overview and public posts on the posts tables (2026-11-23):
 * questions, answers and sources count what the product does now -- posts
 * and follow-ups, never a Ree owner's 试问, copied Q&A or a 转为公开 copy;
 * the chart reads Rees' post answers, not the ledger's `query_base` (which
 * settles every 试问 too). The posts list shows a post when anything on it
 * was reported, leaves trashed posts out, and counts each view for its tabs.
 * The users and Rees pages count a Ree's answers as its public page does,
 * plus its answers to its owner's own posts, never a 试问; a Ree's Q&A tab
 * lists public answers only, a follow-up's under its own question, and an
 * administrator's hide leaves the post's first-round count right. Rate limits name what each limit covers and show the ceilings fixed in
 * code that no exemption lifts; traffic counts a private post's page as the
 * workspace, not as a public post.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { ProcessDeps } from '@/lib/services/posts';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const posts = await import('@/lib/services/posts');
const privatePosts = await import('@/lib/services/private-posts');
const { askReeTry } = await import('@/lib/services/ree-try');
const { addGrant } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { consoleAdministrator } = await import('../fixtures/console-administrator');
const { adminOverview } = await import('@/lib/services/admin-overview');
const { QUERY_BASE_FEE, EXPLORE_RATE_LIMIT } = await import('@/lib/constants');
const { POST_DAILY_LIMIT, FOLLOWUP_DAILY_LIMIT, FOLLOWUP_POST_DAILY_LIMIT } = await import('@/lib/domain/post');
const rateLimits = await import('@/lib/services/rate-limit-settings');
const traffic = await import('@/lib/services/traffic');
const i18nRateLimits = await import('@/i18n/pages/rate-limits');
const { consoleReeAnswers } = await import('@/lib/services/ree-counts');
const { answerCounts } = await import('@/lib/services/statistics');
const publicQa = await import('@/lib/services/public-qa');

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
  if (credits > 0) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

/** A public, published, free Ree with one ready source. */
async function publicRee() {
  const ownerId = await user('ov-owner', 1_000);
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Refund desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: 'Refund policy', content: 'Refunds are issued to the original payment method within 14 days of the request.' });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true }).where(eq(schema.ree.id, ree.id));
  return { ownerId, reeId: ree.id };
}

const approve = async () => ({ publish: true });
const answerOne = async () => ({ state: 'answered' as const, text: 'Within 14 days [1].', citations: [], model: 'stub' });
function stub(reeId: string): ProcessDeps {
  return { judge: approve, match: async () => ({ answerers: [{ reeId, similarity: 0.8, mentioned: false }], candidates: 1, skipped: 0, vector: null }), answerOne };
}

/** A public post answered by `reeId` through the real flow. */
async function answeredPost(author: string, reeId: string, question: string) {
  const result = await posts.publishPost(author, { question, lang: 'en' });
  if (!result.ok) throw new Error(result.error);
  await posts.processPost(result.id, stub(reeId));
  const [row] = await db().select({ answerCount: schema.post.answerCount }).from(schema.post).where(eq(schema.post.id, result.id));
  expect(row!.answerCount).toBe(1);
  return result.id;
}

/** A published follow-up under `postId` that `reeId` answered, written as the follow-up flow leaves it. */
async function answeredFollowup(postId: string, userId: string, reeId: string, question: string) {
  const now = new Date();
  const [row] = await db()
    .insert(schema.postFollowup)
    .values({ postId, userId, question, lang: 'en', status: 'published', publishedAt: now, answerState: 'done', answeredAt: now })
    .returning({ id: schema.postFollowup.id });
  await db().insert(schema.postAnswer).values({ postId, followupId: row!.id, reeId, state: 'answered', text: 'Yes.', answeredAt: now });
  return row!.id;
}

async function figures() {
  const data = await adminOverview(await consoleAdministrator());
  const [ledger] = await db().select({ n: sql<number>`count(*)::int` }).from(schema.creditEntry).where(eq(schema.creditEntry.reason, 'query_base'));
  return {
    questions30: data.questions30,
    questions: data.questions,
    answers: data.trend.reduce((sum, day) => sum + day.answers, 0),
    today: data.trend.at(-1)!.answers,
    rees: data.rees,
    sources: data.sources,
    queryBase: ledger!.n,
  };
}

describeWithDb('console overview on the posts tables', () => {
  it('counts posts, follow-ups and Rees\' answers to them; never a 试问, a copied Q&A or a 转为公开 copy', async () => {
    const { ownerId, reeId } = await publicRee();
    const author = await user('ov-author', 1_000);
    const before = await figures();

    /* A public post, answered: one question, one answer. */
    const posted = await answeredPost(author, reeId, `${uniqueName('ov')} When are refunds issued?`);

    /* Two 试问 of the owner's own Ree: settled as `query_base` like any answer, yet no question and no answer here. */
    for (const question of ['Refund window?', 'Refund method?']) {
      const tried = await askReeTry(ownerId, reeId, { question, lang: 'en' });
      if (!tried?.ok) throw new Error('try failed');
      await privatePosts.processPrivatePost(tried.id, { answerOne });
    }

    /* A private question, then its 转为公开 copy: one question and one answer, not two. */
    const asked = await privatePosts.publishPrivatePost(author, { question: 'Private: refunds to the card?', reeIds: [reeId], fees: { [reeId]: QUERY_BASE_FEE }, lang: 'en' });
    if (!asked.ok) throw new Error(asked.error);
    await privatePosts.processPrivatePost(asked.id, { answerOne });
    const copy = await privatePosts.convertToPublic(author, asked.id);
    expect(copy.ok).toBe(true);

    /* A copied Q&A (a share): its answer was never asked; a follow-up under it was. */
    const now = new Date();
    const [share] = await db()
      .insert(schema.post)
      .values({ source: 'share', visibility: 'public', question: 'Copied: refund window?', lang: 'en', status: 'published', publishedAt: now, answerState: 'done', answeredAt: now, answerCount: 1 })
      .returning({ id: schema.post.id });
    await db().insert(schema.postAnswer).values({ postId: share!.id, reeId, state: 'answered', text: 'Copied answer.', answeredAt: now });
    await answeredFollowup(share!.id, author, reeId, 'And for a gift card?');
    /* And one under the real post. */
    await answeredFollowup(posted, author, reeId, 'And for a bank transfer?');

    const after = await figures();
    expect(after.questions.posts - before.questions.posts).toBe(2);
    expect(after.questions.followups - before.questions.followups).toBe(2);
    expect(after.questions.tests - before.questions.tests).toBe(2);
    expect(after.questions30 - before.questions30).toBe(4);
    /* Post, private question, two follow-ups: the chart counts each once, today. */
    expect(after.answers - before.answers).toBe(4);
    expect(after.today - before.today).toBe(4);
    /* What the chart used to read counts the 试问 and misses the free follow-ups and copies alike. */
    expect(after.queryBase - before.queryBase).toBe(4);
  });

  it('splits every Ree into public, unpublished, private and taken down, and counts live Rees\' sources only', async () => {
    const { reeId } = await publicRee();
    const before = await figures();
    const { total, ...parts } = before.rees;
    expect(Object.values(parts).reduce((sum, n) => sum + n, 0)).toBe(total);

    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, reeId));
    const hidden = await figures();
    expect(hidden.rees.private - before.rees.private).toBe(1);
    expect(hidden.rees.public - before.rees.public).toBe(-1);

    /* Deleted: its source leaves the count with it. */
    await db().update(schema.ree).set({ deletedAt: new Date() }).where(eq(schema.ree.id, reeId));
    const gone = await figures();
    expect(gone.rees.total - before.rees.total).toBe(-1);
    expect(gone.sources.total - before.sources.total).toBe(-1);
    expect(gone.sources.ready - before.sources.ready).toBe(-1);
  });
});

describeWithDb('console public posts', () => {
  it('lists a post when its question, a Ree answer or a follow-up was reported, leaves trashed posts out, and counts each view', async () => {
    const { reeId } = await publicRee();
    const author = await user('ov-posts', 1_000);
    const tag = uniqueName('adminposts').replace(/[^a-z0-9]/gi, '');
    const quiet = await answeredPost(author, reeId, `${tag} quiet post about refunds`);
    const answerReported = await answeredPost(author, reeId, `${tag} answer reported about refunds`);
    const followupReported = await answeredPost(author, reeId, `${tag} follow-up reported about refunds`);
    const questionReported = await answeredPost(author, reeId, `${tag} question reported about refunds`);
    const trashed = await answeredPost(author, reeId, `${tag} trashed post about refunds`);

    const empty = await posts.adminPostCounts(tag);
    expect(empty).toEqual({ reported: 0, quotes: 0, hidden: 0, all: 5 });

    const [given] = await db().select({ id: schema.postAnswer.id }).from(schema.postAnswer).where(eq(schema.postAnswer.postId, answerReported));
    expect(await posts.reportAnswer(given!.id, 'reporter-1')).toBe(true);
    const followup = await answeredFollowup(followupReported, author, reeId, 'Is that business days?');
    await db().update(schema.postFollowup).set({ reportCount: 2 }).where(eq(schema.postFollowup.id, followup));
    expect(await posts.reportPost(questionReported, 'reporter-1')).toBe(true);
    expect(await posts.setPostTrashed(author, trashed, true)).toBe(true);

    const reported = await posts.adminPosts({ view: 'reported', q: tag });
    expect(reported.map((row) => row.id).sort()).toEqual([answerReported, followupReported, questionReported].sort());
    const byId = new Map(reported.map((row) => [row.id, row]));
    expect(byId.get(answerReported)).toMatchObject({ reports: 0, answerReports: 1, followupReports: 0 });
    expect(byId.get(followupReported)).toMatchObject({ reports: 0, answerReports: 0, followupReports: 2 });
    expect(byId.get(questionReported)).toMatchObject({ reports: 1, answerReports: 0, followupReports: 0 });
    /* The most reported first. */
    expect(reported[0]!.id).toBe(followupReported);

    const all = await posts.adminPosts({ view: 'all', q: tag });
    expect(all.map((row) => row.id)).toContain(quiet);
    expect(all.map((row) => row.id)).not.toContain(trashed);
    expect(await posts.adminPostCounts(tag)).toEqual({ reported: 3, quotes: 0, hidden: 0, all: 4 });

    /* Taken down: in its own view, still counted in All. */
    await db().update(schema.post).set({ status: 'hidden', hiddenBy: 'admin' }).where(and(eq(schema.post.id, quiet)));
    expect((await posts.adminPosts({ view: 'hidden', q: tag })).map((row) => row.id)).toEqual([quiet]);
    expect(await posts.adminPostCounts(tag)).toMatchObject({ hidden: 1, all: 4 });
  });
});

describeWithDb('console rate limits', () => {
  it('labels every limit and fixed ceiling in both languages, from the code values', async () => {
    const names = (await rateLimits.listRateLimits()).map((row) => row.name);
    for (const messages of [i18nRateLimits.zh, i18nRateLimits.en]) {
      expect(Object.keys(messages.names).sort()).toEqual([...names].sort());
      expect(Object.keys(messages.ceilings).sort()).toEqual([...rateLimits.CEILING_KEYS].sort());
    }
    await db().delete(schema.limitCeilingSetting);
    rateLimits.forgetRateLimitSettings();
    expect((await rateLimits.listCeilings()).map(({ key, value, defaultValue, per, overridden }) => ({ key, value, defaultValue, per, overridden }))).toEqual([
      { key: 'postsPerDay', value: POST_DAILY_LIMIT, defaultValue: POST_DAILY_LIMIT, per: 'day', overridden: false },
      { key: 'followupsPerDay', value: FOLLOWUP_DAILY_LIMIT, defaultValue: FOLLOWUP_DAILY_LIMIT, per: 'day', overridden: false },
      { key: 'followupsPerPostPerDay', value: FOLLOWUP_POST_DAILY_LIMIT, defaultValue: FOLLOWUP_POST_DAILY_LIMIT, per: 'day', overridden: false },
      { key: 'exploreQuestions', value: EXPLORE_RATE_LIMIT.perUser, defaultValue: EXPLORE_RATE_LIMIT.perUser, per: 'minute', overridden: false },
    ]);
  });

  it('an account exempt from `post` passes the limiter but still meets the posts-a-day ceiling the page lists', async () => {
    const author = await user('ov-exempt', 1_000);
    const administrator = await consoleAdministrator();
    await rateLimits.addRateLimitExemption(administrator.id, { userId: author, limits: ['post'], note: 'batch QA' });
    expect(await rateLimits.effectiveRateRules('post', author)).toBeNull();
    const now = new Date();
    await db()
      .insert(schema.post)
      .values(Array.from({ length: POST_DAILY_LIMIT }, (_, index) => ({ userId: author, source: 'post' as const, visibility: 'public' as const, question: `Ceiling ${index}`, lang: 'en' as const, status: 'published' as const, publishedAt: now, createdAt: now })));
    expect(await posts.publishPost(author, { question: 'One more past the ceiling?', lang: 'en' })).toEqual({ ok: false, error: 'daily_limit' });
    await rateLimits.removeRateLimitExemption(administrator.id, author);
  });
});

describeWithDb('console traffic', () => {
  it('counts a private post\'s page as the workspace and a public post\'s as a post', async () => {
    const { reeId } = await publicRee();
    const author = await user('ov-traffic', 1_000);
    const publicId = await answeredPost(author, reeId, `${uniqueName('ov')} Public question for traffic`);
    const asked = await privatePosts.publishPrivatePost(author, { question: 'Private question for traffic', reeIds: [reeId], fees: { [reeId]: QUERY_BASE_FEE }, lang: 'en' });
    if (!asked.ok) throw new Error(asked.error);
    const visitorId = crypto.randomUUID();
    const record = (path: string) => traffic.recordPageView({ path, referrer: '', utmSource: null, utmMedium: null, utmCampaign: null, visitorId, freshVisitor: false, userId: author, ip: null, ownHosts: ['re0.test'] });
    expect(await record(`/p/${publicId}`)).toBe('recorded');
    expect(await record(`/p/${asked.id}`)).toBe('recorded');
    expect(await record(`/p/${crypto.randomUUID()}`)).toBe('recorded');
    const rows = await db().select({ path: schema.siteView.path, kind: schema.siteView.pageKind }).from(schema.siteView).where(eq(schema.siteView.visitorId, visitorId)).orderBy(schema.siteView.createdAt);
    expect(rows.map((row) => row.kind)).toEqual(['post', 'workspace', 'post']);
  });
});

describeWithDb('console Ree answers (users and Rees pages)', () => {
  it('shows the public figure plus the owner\'s own post answers; a 试问 is neither, though the ledger counts it', async () => {
    const { ownerId, reeId } = await publicRee();
    const stranger = await user('ov-stranger', 1_000);
    const before = (await consoleReeAnswers([reeId])).get(reeId)!;
    const ledgerBefore = (await answerCounts([reeId], null)).get(reeId) ?? 0;
    expect(before).toEqual({ others: 0, own: 0 });

    await answeredPost(stranger, reeId, `${uniqueName('ov')} A stranger asks about refunds`);
    /* The official QA: the owner posts publicly, mentioning their own Ree. */
    await answeredPost(ownerId, reeId, `${uniqueName('ov')} The owner asks their own Ree`);
    const tried = await askReeTry(ownerId, reeId, { question: 'Owner test question?', lang: 'en' });
    if (!tried?.ok) throw new Error('try failed');
    await privatePosts.processPrivatePost(tried.id, { answerOne });

    expect((await consoleReeAnswers([reeId])).get(reeId)).toEqual({ others: 1, own: 1 });
    /* What the console read before: all three in one number, the 试问 included. */
    expect(((await answerCounts([reeId], null)).get(reeId) ?? 0) - ledgerBefore).toBe(3);
  });
});

describeWithDb('console Ree Q&A tab', () => {
  it('lists public answers only, a follow-up\'s under its question, flags a taken-down post, and keeps answer_count to the first round', async () => {
    const { ownerId, reeId } = await publicRee();
    const author = await user('ov-qa', 1_000);
    const publicId = await answeredPost(author, reeId, `${uniqueName('ov')} Public refunds question`);
    const followupId = await answeredFollowup(publicId, author, reeId, 'Follow-up: and for gift cards?');
    /* A private question and a 试问 to the same Ree: their authors' alone. */
    const asked = await privatePosts.publishPrivatePost(author, { question: 'Private refunds question', reeIds: [reeId], fees: { [reeId]: QUERY_BASE_FEE }, lang: 'en' });
    if (!asked.ok) throw new Error(asked.error);
    await privatePosts.processPrivatePost(asked.id, { answerOne });
    const tried = await askReeTry(ownerId, reeId, { question: 'Owner test question?', lang: 'en' });
    if (!tried?.ok) throw new Error('try failed');
    await privatePosts.processPrivatePost(tried.id, { answerOne });

    const rows = await publicQa.adminPublicQa(reeId);
    expect(rows.map((row) => row.postId).sort()).toEqual([publicId, publicId]);
    const followupRow = rows.find((row) => row.followup)!;
    expect(followupRow.question).toBe('Follow-up: and for gift cards?');
    expect(rows.find((row) => !row.followup)!.question).toContain('Public refunds question');

    /* A private post's answer cannot be hidden from the console either. */
    const [privateAnswer] = await db().select({ id: schema.postAnswer.id }).from(schema.postAnswer).where(eq(schema.postAnswer.postId, asked.id));
    const administrator = await consoleAdministrator();
    expect(await publicQa.adminSetPublicQa(administrator.id, reeId, privateAnswer!.id, false)).toBe(false);

    /* Hiding the follow-up's answer leaves the post's first-round count at 1. */
    const [answerRow] = await db().select({ id: schema.postAnswer.id }).from(schema.postAnswer).where(eq(schema.postAnswer.followupId, followupId));
    expect(await publicQa.adminSetPublicQa(administrator.id, reeId, answerRow!.id, false)).toBe(true);
    expect(await publicQa.adminSetPublicQa(administrator.id, reeId, answerRow!.id, true)).toBe(true);
    const [counted] = await db().select({ n: schema.post.answerCount }).from(schema.post).where(eq(schema.post.id, publicId));
    expect(counted!.n).toBe(1);

    /* The post taken down: its answers stay listed, flagged. */
    await db().update(schema.post).set({ status: 'hidden', hiddenBy: 'admin' }).where(eq(schema.post.id, publicId));
    expect((await publicQa.adminPublicQa(reeId)).every((row) => row.postHidden)).toBe(true);
  });
});

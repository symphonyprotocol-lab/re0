/**
 * AI 通用回答 (design draft 1, approved 2026-11-20): when no Ree answers a
 * round, its asker gets one general answer at the base fee: held, settled
 * once written, given back when it fails; skipped for a short balance and
 * then generated once by hand. On a public post everyone -- visitors
 * included -- reads it once it passed review (2026-11-21); before that, or
 * refused, only its asker (no refund); on a private post only its author.
 * It is never a Ree's answer: no answered count, rank, role metric,
 * sitemap or cover reads it, and the post stays 待回答.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName, uniqueWord } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { AiAnswerer, AiAnswerInput } from '@/lib/services/ai-answers';
import type { AnswerOne, Matcher } from '@/lib/services/posts';
import type { Judge } from '@/lib/services/public-qa';

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
const followups = await import('@/lib/services/post-followups');
const privatePosts = await import('@/lib/services/private-posts');
const ai = await import('@/lib/services/ai-answers');
const { answersByOthers } = await import('@/lib/services/explore');
const { computeRanks } = await import('@/lib/services/rank');
const { roleMetrics } = await import('@/lib/services/roles');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { QUERY_BASE_FEE: BASE } = await import('@/lib/constants');
const { AI_ANSWER_FEE, AI_ANSWER_STALE_MS } = await import('@/lib/domain/post');
const { PUBLIC_QA_MODERATION_ATTEMPTS } = await import('@/lib/domain/public-qa');
const { GET: getRoute } = await import('@/app/api/posts/[id]/route');
const { POST: retryRoute } = await import('@/app/api/posts/[id]/ai-answer/route');
const { POST: requestRoute } = await import('@/app/api/posts/[id]/ree-request/route');
const { POST: voteRoute } = await import('@/app/api/posts/ai-answers/[aiId]/vote/route');

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
  if (credits > 0) await topUp(userId, credits);
  return userId;
}

const topUp = (userId: string, credits: number) => db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
const drain = (userId: string) => db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));

/** A public Ree with ready knowledge (free unless `queryFee`). */
async function makeRee(queryFee = 0, ownerId?: string) {
  const owner = ownerId ?? (await user('ai-owner', 1_000));
  await rees.saveDraft(owner, { ...newReeDraft(), name: uniqueName('Plant desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(owner);
  const id = await knowledge.addKnowledge(owner, ree, { kind: 'text', title: 'Watering', content: 'Water a monstera once the top five centimetres of soil are dry.' });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true, queryFee, answersPosts: queryFee > 0 ? true : null }).where(eq(schema.ree.id, ree.id));
  return { ownerId: owner, reeId: ree.id };
}

const approve: Judge = async () => ({ publish: true });
/* Questions pass; an AI answer's review cannot run (it stays pending for the sweep). */
const holdAi: Judge = async (_question, answer) => {
  if (answer) throw new Error('review down');
  return { publish: true };
};
/* Questions pass; AI answers are refused. */
const refuseAi: Judge = async (_question, answer) => ({ publish: !answer });
/* The sweep's clock: past the minute a review waits before it is retried. */
const sweepTime = () => new Date(Date.now() + 120_000);
const noMatch: Matcher = async () => ({ answerers: [], candidates: 4, skipped: 4, vector: null });
const matchOnly = (reeIds: string[]): Matcher => async () => ({ answerers: reeIds.map((reeId) => ({ reeId, similarity: 0.8, mentioned: false })), candidates: reeIds.length, skipped: 0, vector: null });
const says = (text: (reeId: string) => string | null): AnswerOne => async ({ reeId }) => {
  const said = text(reeId);
  return said ? { state: 'answered', text: said, citations: [], model: 'stub' } : { state: 'no_answer', model: 'stub' };
};

/** The AI stub: records what it was asked, answers `text` (or fails). */
function aiStub(text: string | Error = 'Water less often [1] and check the drainage.', seen: AiAnswerInput[] = []): AiAnswerer {
  return async (input) => {
    seen.push(input);
    if (text instanceof Error) throw text;
    return { text, model: 'free-stub' };
  };
}

async function publish(author: string, question = `Why are my monstera leaves yellow? ${crypto.randomUUID()}`) {
  const posted = await posts.publishPost(author, { question, lang: 'en' });
  if (!posted.ok) throw new Error(posted.error);
  return posted.id;
}

const aiRows = (postId: string) => db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.postId, postId));
const ledger = async (userId: string) =>
  (await db().select({ reason: schema.creditEntry.reason, delta: schema.creditEntry.delta }).from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, userId), inArray(schema.creditEntry.reason, ['ai_answer_hold', 'ai_answer_settle', 'ai_answer_refund']))).orderBy(schema.creditEntry.createdAt)).map((row) => [row.reason, row.delta]);
const postRow = async (id: string) => (await db().select().from(schema.post).where(eq(schema.post.id, id)))[0]!;

async function signIn(userId: string | null) {
  if (!userId) return void (token = undefined);
  token = crypto.randomUUID();
  await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId, expiresAt: new Date(Date.now() + 60_000) });
}
const request = (url: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, body === undefined ? { headers: { host: 'localhost:3000' } } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000' } });

describeWithDb('AI 通用回答 when no Ree answers', () => {
  it('answers a public post nothing matched, charges its author the base fee, and shows it to everyone once it passed review', async () => {
    const author = await user('ai-author', 100);
    const other = await user('ai-reader', 100);
    const id = await publish(author);
    const seen: AiAnswerInput[] = [];
    await posts.processPost(id, { judge: holdAi, match: noMatch, aiAnswer: aiStub('Water less often [1] and call 13812345678 if unsure. '.repeat(4), seen) });

    /* The free tier's answer of the question alone; the fee held, then settled to the platform. */
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userId: author, lang: 'en', question: expect.stringContaining('monstera') });
    expect(seen[0]!.thread).toBeUndefined();
    const [row] = await aiRows(id);
    expect(row).toMatchObject({ state: 'answered', userId: author, followupId: null, price: AI_ANSWER_FEE, model: 'free-stub', review: 'pending', reviewAttempts: 1 });
    /* Citation markers out, contact details hidden as a post's are. */
    expect(row!.text).not.toMatch(/\[1\]|13812345678/);
    expect(await balanceOf(db(), author)).toBe(100 - AI_ANSWER_FEE);
    expect(await ledger(author)).toEqual([['ai_answer_hold', -AI_ANSWER_FEE], ['ai_answer_settle', 0]]);
    expect(await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.kind, 'post_ai_answer')))).toHaveLength(1);

    /* Until its review passes: the author's page and card have it, marked in review; nobody else has a trace of it. */
    const mine = (await posts.getPost(id, author))!;
    expect(mine.aiAnswer).toMatchObject({ id: row!.id, state: 'answered', cost: AI_ANSWER_FEE, retry: false, folded: false, vote: null, truncated: false, mine: true, review: 'pending', private: false });
    expect(mine.answered).toBe(0);
    expect((await posts.getPost(id, other))!.aiAnswer).toBeNull();
    expect((await posts.getPost(id))!.aiAnswer).toBeNull();
    const latestMine = (await posts.listFeed('latest', { viewerId: author, size: 50 })).items.find((entry) => entry.id === id)!;
    expect(latestMine.aiAnswer).toMatchObject({ state: 'answered', truncated: true });
    for (const viewer of [other, undefined]) {
      expect((await posts.listFeed('latest', { viewerId: viewer, size: 50 })).items.find((entry) => entry.id === id)?.aiAnswer ?? null).toBeNull();
    }
    await signIn(other);
    expect(await (await getRoute(request(`/api/posts/${id}`), { params: Promise.resolve({ id }) })).text()).not.toContain('Water less often');
    await signIn(null);
    expect(await (await getRoute(request(`/api/posts/${id}`), { params: Promise.resolve({ id }) })).text()).not.toContain('Water less often');

    /* The posts sweep retries the review that could not run (within its budget, checked before each review): passed, it is everyone's to read. */
    await posts.processStalePosts({ judge: approve, match: noMatch, aiAnswer: aiStub() }, { now: sweepTime(), budgetMs: 60_000 });
    expect((await aiRows(id))[0]).toMatchObject({ review: 'passed', reviewAttempts: 2 });
    for (const viewer of [other, undefined]) {
      expect((await posts.getPost(id, viewer))!.aiAnswer).toMatchObject({ id: row!.id, state: 'answered', mine: false, review: 'passed', cost: 0, vote: null, retry: false, private: false, text: expect.stringContaining('Water less often') });
      for (const tab of ['latest', 'unanswered'] as const) {
        const listed = (await posts.listFeed(tab, { viewerId: viewer, size: 50 })).items.find((entry) => entry.id === id)!;
        expect(listed.aiAnswer).toMatchObject({ state: 'answered', truncated: true, mine: false });
        expect(listed.answers).toEqual([]);
      }
    }
    await signIn(other);
    const asOther = (await (await getRoute(request(`/api/posts/${id}`), { params: Promise.resolve({ id }) })).json()) as { aiAnswer: { state: string; mine: boolean } };
    expect(asOther.aiAnswer).toMatchObject({ state: 'answered', mine: false });
    await signIn(null);
    expect(await (await getRoute(request(`/api/posts/${id}`), { params: Promise.resolve({ id }) })).text()).toContain('Water less often');
    await signIn(author);
    expect(((await (await getRoute(request(`/api/posts/${id}`), { params: Promise.resolve({ id }) })).json()) as { aiAnswer: { state: string } }).aiAnswer.state).toBe('answered');
    await signIn(null);

    /* It counts as no answer: still 待回答, not in the sitemap, no cover answer, no Ree question in the ledger. */
    expect((await postRow(id)).answerCount).toBe(0);
    expect((await posts.listFeed('unanswered', { viewerId: other, size: 50 })).items.map((entry) => entry.id)).toContain(id);
    expect((await posts.listFeed('for_you', { size: 50 })).items.map((entry) => entry.id)).not.toContain(id);
    expect((await posts.indexablePosts()).map((entry) => entry.id)).not.toContain(id);
    expect(await posts.postCover(id)).toMatchObject({ state: 'shown', answers: 0, first: null });
    expect(await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, author), eq(schema.creditEntry.reason, 'query_base')))).toEqual([]);

    /* Once per round: processing again (the sweep) makes nothing new. */
    await ai.answerWithAi(id, null, { aiAnswer: aiStub() });
    expect(await aiRows(id)).toHaveLength(1);

    /* 有帮助 / 没帮助: its asker only, though everyone reads it. */
    await signIn(other);
    expect((await voteRoute(request(`/api/posts/ai-answers/${row!.id}/vote`, { vote: 'helpful' }), { params: Promise.resolve({ aiId: row!.id }) })).status).toBe(404);
    await signIn(author);
    expect(await (await voteRoute(request(`/api/posts/ai-answers/${row!.id}/vote`, { vote: 'unhelpful' }), { params: Promise.resolve({ aiId: row!.id }) })).json()).toEqual({ vote: 'unhelpful' });
    expect((await posts.getPost(id, author))!.aiAnswer!.vote).toBe('unhelpful');
    expect((await posts.getPost(id, other))!.aiAnswer!.vote).toBeNull();
    await signIn(null);
  });

  it('keeps it its asker’s alone when review refuses it, or never manages to run, with the fee kept', async () => {
    const author = await user('ai-author', 100);
    const other = await user('ai-reader', 100);
    const refused = await publish(author);
    await posts.processPost(refused, { judge: refuseAi, match: noMatch, aiAnswer: aiStub('Overwatering.') });
    expect((await aiRows(refused))[0]).toMatchObject({ state: 'answered', review: 'rejected', price: AI_ANSWER_FEE });
    expect(await balanceOf(db(), author)).toBe(100 - AI_ANSWER_FEE);
    expect(await ledger(author)).toEqual([['ai_answer_hold', -AI_ANSWER_FEE], ['ai_answer_settle', 0]]);
    expect((await posts.getPost(refused, author))!.aiAnswer).toMatchObject({ state: 'answered', mine: true, review: 'rejected', cost: AI_ANSWER_FEE });
    expect((await posts.getPost(refused, other))!.aiAnswer).toBeNull();
    expect((await posts.getPost(refused))!.aiAnswer).toBeNull();
    expect((await posts.listFeed('latest', { viewerId: other, size: 50 })).items.find((entry) => entry.id === refused)?.aiAnswer ?? null).toBeNull();
    /* Nobody else may ask on under it; its author still may. */
    expect(await ai.aiFollowupsOpen(refused, other)).toBe(false);
    expect(await ai.aiFollowupsOpen(refused, undefined)).toBe(false);
    expect(await ai.aiFollowupsOpen(refused, author)).toBe(true);
    /* The sweep does not review it again. */
    await ai.sweepAiAnswers(sweepTime(), { judge: approve });
    expect((await aiRows(refused))[0]!.review).toBe('rejected');

    /* A review that never runs is tried PUBLIC_QA_MODERATION_ATTEMPTS times in all, then refused: never public unreviewed. */
    const broken = await publish(author);
    await posts.processPost(broken, { judge: holdAi, match: noMatch, aiAnswer: aiStub('Overwatering.') });
    expect((await aiRows(broken))[0]).toMatchObject({ review: 'pending', reviewAttempts: 1 });
    for (let attempt = 2; attempt <= PUBLIC_QA_MODERATION_ATTEMPTS; attempt += 1) {
      await ai.sweepAiAnswers(sweepTime(), { judge: holdAi });
      expect((await aiRows(broken))[0]!.reviewAttempts).toBe(attempt);
    }
    expect((await aiRows(broken))[0]!.review).toBe('rejected');
    expect((await posts.getPost(broken, other))!.aiAnswer).toBeNull();
    expect(await balanceOf(db(), author)).toBe(100 - 2 * AI_ANSWER_FEE);
  });

  it('answers when every matched Ree found nothing, never while a paid Ree waits for the author, and never for RE0, 试问 or MCP', async () => {
    const free = await makeRee();
    const paid = await makeRee(40);
    const author = await user('ai-author', 200);

    const nothing = await publish(author);
    await posts.processPost(nothing, { judge: approve, match: matchOnly([free.reeId]), answerOne: says(() => null), aiAnswer: aiStub() });
    expect((await aiRows(nothing))[0]).toMatchObject({ state: 'answered' });

    /* A paid Ree's request card is the way to a sourced answer: the author decides on it, no AI answer is made. */
    const waiting = await publish(author);
    await posts.processPost(waiting, { judge: approve, match: matchOnly([paid.reeId]), answerOne: says(() => null), aiAnswer: aiStub() });
    expect((await posts.getPost(waiting, author))!.paidRequests).toHaveLength(1);
    expect(await aiRows(waiting)).toEqual([]);

    /* A Ree answered: no AI answer. */
    const answered = await publish(author);
    await posts.processPost(answered, { judge: approve, match: matchOnly([free.reeId]), answerOne: says(() => 'Water when the top soil is dry.'), aiAnswer: aiStub() });
    expect(await aiRows(answered)).toEqual([]);

    /* RE0's example post: no author to answer. */
    const [seed] = await db().insert(schema.post).values({ userId: null, source: 'seed', question: `Example ${crypto.randomUUID()}`, lang: 'en', status: 'published', publishedAt: new Date(), answerState: 'done' }).returning({ id: schema.post.id });
    await ai.answerWithAi(seed!.id, null, { aiAnswer: aiStub() });
    expect(await aiRows(seed!.id)).toEqual([]);

    /* A Ree owner's 试问 and an MCP ask: private posts that name Rees, never an AI answer. */
    for (const source of ['test', 'api'] as const) {
      const made = await privatePosts.publishPrivatePost(free.ownerId, { question: `Try ${uniqueWord('ask')}`, reeIds: [free.reeId], fees: { [free.reeId]: BASE }, lang: 'en' }, { source });
      if (!made.ok) throw new Error(made.error);
      await privatePosts.processPrivatePost(made.id, { answerOne: says(() => null), aiAnswer: aiStub() });
      expect(await aiRows(made.id)).toEqual([]);
    }
  });

  it('gives the fee back when the model fails, and when a run dies the sweep does', async () => {
    const author = await user('ai-author', 100);
    const id = await publish(author);
    await posts.processPost(id, { judge: approve, match: noMatch, aiAnswer: aiStub(new Error('model down')) });
    expect((await aiRows(id))[0]).toMatchObject({ state: 'failed', price: 0 });
    expect(await balanceOf(db(), author)).toBe(100);
    expect(await ledger(author)).toEqual([['ai_answer_hold', -AI_ANSWER_FEE], ['ai_answer_refund', AI_ANSWER_FEE]]);
    /* A failed one leaves the page as it was, and cannot be generated again. */
    expect((await posts.getPost(id, author))!.aiAnswer).toBeNull();
    expect(await ai.retryAiAnswer(author, id, null)).toEqual({ ok: false, error: 'already' });

    /* An empty answer counts as a failure too. */
    const empty = await publish(author);
    await posts.processPost(empty, { judge: approve, match: noMatch, aiAnswer: aiStub(' [2] ') });
    expect((await aiRows(empty))[0]).toMatchObject({ state: 'failed' });
    expect(await balanceOf(db(), author)).toBe(100);

    /* Held but never written (the request died): the sweep fails it and gives the fee back. */
    const stuck = await publish(author);
    await drain(author);
    await posts.processPost(stuck, { judge: approve, match: noMatch, aiAnswer: aiStub() });
    await topUp(author, 100);
    const retried = await ai.retryAiAnswer(author, stuck, null);
    expect(retried.ok).toBe(true);
    expect(await balanceOf(db(), author)).toBe(100 - AI_ANSWER_FEE);
    expect(await ai.sweepAiAnswers(new Date())).toBe(0);
    expect(await ai.sweepAiAnswers(new Date(Date.now() + AI_ANSWER_STALE_MS + 60_000))).toBeGreaterThanOrEqual(1);
    expect((await aiRows(stuck))[0]).toMatchObject({ state: 'failed' });
    expect(await balanceOf(db(), author)).toBe(100);
  });

  it('skips a short balance with nothing charged, then generates once by hand after a top-up', async () => {
    const author = await user('ai-author', BASE);
    const id = await publish(author);
    /* The balance went elsewhere before the AI's turn. */
    await drain(author);
    await posts.processPost(id, { judge: approve, match: noMatch, aiAnswer: aiStub() });
    const [row] = await aiRows(id);
    expect(row).toMatchObject({ state: 'skipped_balance', holdId: null, price: 0 });
    expect(await ledger(author)).toEqual([]);
    expect((await posts.getPost(id, author))!.aiAnswer).toMatchObject({ state: 'skipped_balance', retry: true, cost: 0 });
    expect((await posts.getPost(id))!.aiAnswer).toBeNull();

    await signIn(author);
    const trigger = () => retryRoute(request(`/api/posts/${id}/ai-answer`, {}), { params: Promise.resolve({ id }) });
    /* Still short: refused with the balance, still skipped (it may be tried again). */
    const short = await trigger();
    expect(short.status).toBe(402);
    expect(await short.json()).toMatchObject({ error: 'insufficient_credits', balance: 0, needed: AI_ANSWER_FEE });
    expect((await aiRows(id))[0]!.state).toBe('skipped_balance');

    await topUp(author, 50);
    later.length = 0;
    expect((await trigger()).status).toBe(200);
    expect(later).toHaveLength(1);
    later.length = 0;
    await ai.runAiAnswer(row!.id, { aiAnswer: aiStub('Check the light first.') });
    expect((await aiRows(id))[0]).toMatchObject({ state: 'answered', price: AI_ANSWER_FEE, text: 'Check the light first.' });
    expect(await balanceOf(db(), author)).toBe(50 - AI_ANSWER_FEE);
    /* Once only. */
    const again = await trigger();
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'already' });
    /* Nobody else's to trigger. */
    const stranger = await user('ai-reader', 100);
    await signIn(stranger);
    expect((await trigger()).status).toBe(404);
    await signIn(null);
  });

  it('answers a public follow-up no Ree answered for whoever asked it, with the thread, and shows it to everyone once it passed review', async () => {
    const near = await makeRee();
    const author = await user('ai-author', 200);
    const id = await publish(author, `Monstera yellow leaves ${crypto.randomUUID()}`);
    await posts.processPost(id, { judge: approve, match: matchOnly([near.reeId]), answerOne: says(() => 'Water when the top soil is dry.'), aiAnswer: aiStub() });
    expect(await aiRows(id)).toEqual([]);

    const reader = await user('ai-reader', 100);
    const authorBefore = await balanceOf(db(), author);
    const asked = await followups.askFollowup(reader, id, { question: 'Does it affect a home purchase?', lang: 'en' });
    if (!asked.ok) throw new Error(asked.error);
    const seen: AiAnswerInput[] = [];
    /* Not close enough: no Ree is asked, and the AI answers the reader. */
    await followups.processFollowup(asked.id, { judge: approve, matchFollowup: async () => ({ similarity: new Map([[near.reeId, 0.1]]), vector: null }), answerOne: says(() => 'unused'), aiAnswer: aiStub('It depends on the city.', seen) });
    expect(seen[0]).toMatchObject({ userId: reader, question: 'Does it affect a home purchase?', thread: { postQuestion: expect.stringContaining('Monstera'), earlierAnswer: null, earlierRounds: [] } });
    const [row] = await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.followupId, asked.id));
    expect(row).toMatchObject({ state: 'answered', userId: reader, postId: id });
    expect(await balanceOf(db(), reader)).toBe(100 - AI_ANSWER_FEE);
    expect(await balanceOf(db(), author)).toBe(authorBefore);
    expect(await db().select().from(schema.notice).where(and(eq(schema.notice.userId, reader), eq(schema.notice.kind, 'post_ai_answer')))).toHaveLength(1);

    const roundOf = async (viewer?: string) => (await posts.getPost(id, viewer))!.followups.find((entry) => entry.id === asked.id)!;
    expect(row).toMatchObject({ review: 'passed' });
    expect((await roundOf(reader)).aiAnswer).toMatchObject({ state: 'answered', cost: AI_ANSWER_FEE, mine: true });
    expect((await roundOf(author)).aiAnswer).toMatchObject({ state: 'answered', cost: 0, mine: false, text: 'It depends on the city.' });
    expect((await roundOf()).aiAnswer).toMatchObject({ state: 'answered', mine: false });
    expect((await roundOf(author)).answers).toEqual([]);
    /* The post's own figures do not move. */
    expect((await postRow(id)).answerCount).toBe(1);
  });

  it('answers a private post whose chosen Rees found nothing, asks the AI alone (只问 AI), and its follow-ups', async () => {
    const ree = await makeRee();
    const author = await user('ai-author', 200);
    const made = await privatePosts.publishPrivatePost(author, { question: `Rent deduction without a receipt? ${uniqueWord('ask')}`, reeIds: [ree.reeId], fees: { [ree.reeId]: BASE }, lang: 'en' });
    if (!made.ok) throw new Error(made.error);
    await privatePosts.processPrivatePost(made.id, { answerOne: says(() => null), aiAnswer: aiStub('Usually yes; keep the lease.') });
    /* The Ree's hold came back; the AI's base fee was charged. */
    expect(await balanceOf(db(), author)).toBe(200 - AI_ANSWER_FEE);
    expect((await posts.getPost(made.id, author))!.aiAnswer).toMatchObject({ state: 'answered', cost: AI_ANSWER_FEE });
    /* The author is on the page: no notice for a private post. */
    expect(await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.kind, 'post_ai_answer')))).toEqual([]);
    /* Never reviewed, never anyone else's -- even marked passed, a private post's stays its author's. */
    const [privateAi] = await aiRows(made.id);
    expect(privateAi).toMatchObject({ review: null, reviewAttempts: 0 });
    expect((await posts.getPost(made.id, author))!.aiAnswer).toMatchObject({ private: true, review: null, mine: true });
    const stranger = await user('ai-reader', 0);
    await db().update(schema.postAiAnswer).set({ review: 'passed' }).where(eq(schema.postAiAnswer.id, privateAi!.id));
    expect((await ai.aiAnswersFor(stranger, { postIds: [made.id] }, { whole: true })).size).toBe(0);
    expect((await ai.aiAnswersFor(undefined, { postIds: [made.id] }, { whole: true })).size).toBe(0);
    await db().update(schema.postAiAnswer).set({ review: null }).where(eq(schema.postAiAnswer.id, privateAi!.id));

    /* 只问 AI: no Rees at all, only from the composer, and only with the fee in the balance. */
    const question = `Ask the AI only ${crypto.randomUUID()}`;
    expect(await privatePosts.publishPrivatePost(author, { question, reeIds: [], lang: 'en' })).toEqual({ ok: false, error: 'no_rees' });
    const poor = await user('ai-poor', AI_ANSWER_FEE - 1);
    expect(await privatePosts.publishPrivatePost(poor, { question, reeIds: [], aiOnly: true, lang: 'en' })).toEqual({ ok: false, error: 'insufficient_credits', balance: AI_ANSWER_FEE - 1, needed: AI_ANSWER_FEE });
    expect(await privatePosts.publishPrivatePost(author, { question, reeIds: [], aiOnly: true, lang: 'en' }, { source: 'test' })).toEqual({ ok: false, error: 'no_rees' });
    const only = await privatePosts.publishPrivatePost(author, { question, reeIds: [], aiOnly: true, lang: 'en' });
    if (!only.ok) throw new Error(only.error);
    expect(await postRow(only.id)).toMatchObject({ visibility: 'private', candidates: 0, answerState: 'answering' });
    await privatePosts.processPrivatePost(only.id, { aiAnswer: aiStub('A general answer.') });
    const view = (await posts.getPost(only.id, author))!;
    expect(view).toMatchObject({ answerState: 'done', candidates: 0, answers: [] });
    expect(view.aiAnswer).toMatchObject({ state: 'answered' });
    expect(await balanceOf(db(), author)).toBe(200 - 2 * AI_ANSWER_FEE);

    /* A follow-up on it goes to the AI alone (no Ree in the thread), with the earlier AI answer as context. */
    const seen: AiAnswerInput[] = [];
    const asked = await privatePosts.askPrivateFollowup(author, only.id, { question: 'And for a sublet?', lang: 'en' });
    if (!asked.ok) throw new Error(asked.error);
    await privatePosts.processPrivateFollowup(asked.id, { aiAnswer: aiStub('Same rules.', seen) });
    expect(seen[0]!.thread).toMatchObject({ earlierAnswer: 'A general answer.' });
    expect((await posts.getPost(only.id, author))!.followups[0]!.aiAnswer).toMatchObject({ state: 'answered', cost: AI_ANSWER_FEE });

    /* A follow-up to the post's Ree that finds nothing: the AI answers it too. */
    const named = await privatePosts.askPrivateFollowup(author, made.id, { question: 'What about utilities?', mentionReeIds: [ree.reeId], fees: { [ree.reeId]: BASE }, lang: 'en' });
    if (!named.ok) throw new Error(named.error);
    await privatePosts.processPrivateFollowup(named.id, { answerOne: says(() => null), aiAnswer: aiStub('Not deductible.') });
    expect((await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.followupId, named.id)))[0]).toMatchObject({ state: 'answered', userId: author });
    expect(await balanceOf(db(), author)).toBe(200 - 4 * AI_ANSWER_FEE);
  });

  it('asks a Ree to answer the post (请 Ree 回答): the Ree answers into the first round, the AI answer folds, and nothing counts it', async () => {
    const free = await makeRee();
    const paid = await makeRee(30);
    const second = await makeRee();
    const author = await user('ai-author', 200);
    const id = await publish(author);
    await posts.processPost(id, { judge: approve, match: noMatch, aiAnswer: aiStub() });
    expect(await balanceOf(db(), author)).toBe(200 - AI_ANSWER_FEE);

    /* Only the author, only public Rees taking posts. */
    const other = await user('ai-reader', 100);
    expect(await posts.requestReeAnswer(other, id, free.reeId)).toEqual({ ok: false, error: 'not_found' });
    const privateOne = await makeRee();
    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, privateOne.reeId));
    expect(await posts.requestReeAnswer(author, id, privateOne.reeId)).toEqual({ ok: false, error: 'unavailable' });

    /* A paid Ree becomes a request card to agree to; another waits for it. */
    const card = await posts.requestReeAnswer(author, id, paid.reeId);
    expect(card).toMatchObject({ ok: true, state: 'awaiting' });
    expect((await posts.getPost(id, author))!.paidRequests.map((entry) => entry.reeId)).toEqual([paid.reeId]);
    expect(await posts.requestReeAnswer(author, id, free.reeId)).toEqual({ ok: false, error: 'busy' });
    expect(await posts.declinePaidAnswer(author, (card as { id: string }).id)).toBe(true);

    /* A free Ree holds the base fee and answers. */
    await signIn(author);
    later.length = 0;
    const made = await requestRoute(request(`/api/posts/${id}/ree-request`, { reeId: free.reeId }), { params: Promise.resolve({ id }) });
    expect(made.status).toBe(201);
    const body = (await made.json()) as { id: string; state: string };
    expect(body.state).toBe('answering');
    expect(later).toHaveLength(1);
    later.length = 0;
    expect(await balanceOf(db(), author)).toBe(200 - AI_ANSWER_FEE - BASE);
    await posts.answerPaid(body.id, { answerOne: says(() => 'Yellow leaves usually mean too much water.') });
    await signIn(null);

    /* Answered: out of 待回答, the AI answer folded under it, its fee kept. */
    const mine = (await posts.getPost(id, author))!;
    expect(mine.answers.map((entry) => entry.reeId)).toEqual([free.reeId]);
    expect(mine.aiAnswer).toMatchObject({ state: 'answered', folded: true, cost: AI_ANSWER_FEE });
    expect(await balanceOf(db(), author)).toBe(200 - AI_ANSWER_FEE - BASE);
    expect((await postRow(id)).answerCount).toBe(1);
    expect((await posts.listFeed('unanswered', { size: 50 })).items.map((entry) => entry.id)).not.toContain(id);
    expect((await posts.indexablePosts()).map((entry) => entry.id)).toContain(id);
    expect(await posts.requestReeAnswer(author, id, second.reeId)).toEqual({ ok: false, error: 'answered' });
    expect(await ai.retryAiAnswer(author, id, null)).toEqual({ ok: false, error: 'already' });

    /* Only the Ree's answer counts: its answered posts, its answers by others, its owner's figures. */
    expect((await posts.answeredPostCounts([free.reeId])).get(free.reeId)).toBe(1);
    expect((await posts.reeAnsweredPosts(free.reeId, { viewerId: author }))!.items.map((entry) => [entry.id, entry.aiAnswer?.folded])).toEqual([[id, true]]);
    /* Anyone else reads it folded the same way: it passed review. */
    expect((await posts.reeAnsweredPosts(free.reeId, { viewerId: other }))!.items.map((entry) => [entry.aiAnswer?.folded, entry.aiAnswer?.mine])).toEqual([[true, false]]);
    await computeRanks();
    const [counted] = await db().select({ answers: answersByOthers }).from(schema.ree).where(eq(schema.ree.id, free.reeId));
    expect(counted!.answers).toBe(1);
    expect((await roleMetrics(db(), free.ownerId)).externalQuestions).toBe(1);
    expect((await roleMetrics(db(), author)).externalQuestions).toBe(0);
  });

  it('backfills (0072): old public AI answers and 继续问 AI follow-ups go back to review, private posts stay as they were', async () => {
    const author = await user('ai-author', 200);
    const other = await user('ai-reader');
    const id = await publish(author);
    await posts.processPost(id, { judge: approve, match: noMatch, aiAnswer: aiStub('Old answer.') });
    const asked = await followups.askFollowup(author, id, { question: `Old follow-up ${uniqueWord('ask')}?`, lang: 'en' });
    if (!asked.ok) throw new Error(asked.error);
    await followups.processFollowup(asked.id, { judge: approve, aiAnswer: aiStub('Old follow-up answer.') });
    const only = await privatePosts.publishPrivatePost(author, { question: `Private ${uniqueWord('ask')}`, reeIds: [], aiOnly: true, lang: 'en' });
    if (!only.ok) throw new Error(only.error);
    await privatePosts.processPrivatePost(only.id, { aiAnswer: aiStub('Private answer.') });
    /* As they stood before 0072: never reviewed, the 继续问 AI published at once and not counted. */
    await db().update(schema.postAiAnswer).set({ review: null, reviewAttempts: 0 }).where(eq(schema.postAiAnswer.postId, id));
    await db().update(schema.post).set({ followupCount: 0 }).where(eq(schema.post.id, id));

    /* The migration's own UPDATEs, in a transaction rolled back after looking (they touch every row). */
    const updates = readFileSync('db/migrations/0072_public_ai_answers.sql', 'utf8').split('--> statement-breakpoint').filter((chunk) => /^UPDATE/m.test(chunk));
    expect(updates).toHaveLength(3);
    const rollback = new Error('rollback');
    let seen: { answers: (string | null)[]; privateReview: string | null; followup: { status: string; moderationAttempts: number; answerState: string }; count: number } | null = null;
    await expect(
      db().transaction(async (tx) => {
        for (const statement of updates) await tx.execute(sql.raw(statement));
        const rows = await tx.select().from(schema.postAiAnswer).where(inArray(schema.postAiAnswer.postId, [id, only.id]));
        const [round] = await tx.select().from(schema.postFollowup).where(eq(schema.postFollowup.id, asked.id));
        const [target] = await tx.select().from(schema.post).where(eq(schema.post.id, id));
        seen = { answers: rows.filter((row) => row.postId === id).map((row) => row.review), privateReview: rows.find((row) => row.postId === only.id)!.review ?? null, followup: round!, count: target!.followupCount };
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(seen).toMatchObject({ answers: ['pending', 'pending'], privateReview: null, followup: { status: 'pending', moderationAttempts: 0, answerState: 'done' }, count: 0 });

    /* What the sweep then does with them (the same rows, set as the migration sets them): reviewed, published, counted -- never answered again. */
    await db().update(schema.postAiAnswer).set({ review: 'pending' }).where(eq(schema.postAiAnswer.postId, id));
    await db().update(schema.postFollowup).set({ status: 'pending', moderationAttempts: 0 }).where(eq(schema.postFollowup.id, asked.id));
    expect((await posts.getPost(id, other))!).toMatchObject({ aiAnswer: null, followups: [] });
    await ai.sweepAiAnswers(sweepTime(), { judge: approve });
    await followups.processFollowup(asked.id, { judge: approve, aiAnswer: aiStub('unused') });
    const theirs = (await posts.getPost(id, other))!;
    expect(theirs.aiAnswer).toMatchObject({ text: 'Old answer.', mine: false });
    expect(theirs.followups.map((entry) => [entry.status, entry.aiAnswer?.text])).toEqual([['published', 'Old follow-up answer.']]);
    expect((await postRow(id)).followupCount).toBe(1);
    expect(await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.postId, id))).toHaveLength(2);
    expect(await balanceOf(db(), author)).toBe(200 - 3 * AI_ANSWER_FEE);
  });
});

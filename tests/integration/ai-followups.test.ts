/**
 * 继续问 AI: on a public post no Ree answered, its author asks on under
 * their AI answer. The AI answers each follow-up at the base fee (given
 * back when it fails, skipped for a short balance and then generated once
 * by hand), with the post's question and the earlier AI rounds -- never a
 * Ree's text. Only the author ever sees these follow-ups: for everyone else
 * the post stays 待回答 with none, and nobody else may ask. Once a Ree is
 * brought in (请 Ree 回答) the AI thread folds, kept, and follow-ups are
 * public again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
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
const ai = await import('@/lib/services/ai-answers');
const { aiAnswerPrompt } = await import('@/lib/domain/ai-answer');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { QUERY_BASE_FEE: BASE } = await import('@/lib/constants');
const { AI_ANSWER_FEE } = await import('@/lib/domain/post');
const { GET: getRoute } = await import('@/app/api/posts/[id]/route');
const { POST: askRoute } = await import('@/app/api/posts/[id]/followups/route');

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

async function makeRee() {
  const owner = await user('aif-owner', 1_000);
  await rees.saveDraft(owner, { ...newReeDraft(), name: uniqueName('Plant desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(owner);
  const id = await knowledge.addKnowledge(owner, ree, { kind: 'text', title: 'Watering', content: 'Water a monstera once the top five centimetres of soil are dry.' });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true, queryFee: 0, answersPosts: null }).where(eq(schema.ree.id, ree.id));
  return { ownerId: owner, reeId: ree.id };
}

const approve: Judge = async () => ({ publish: true });
/* A 继续问 AI is never reviewed: a review would fail the test. */
const noReview: Judge = async () => {
  throw new Error('reviewed');
};
const noMatch: Matcher = async () => ({ answerers: [], candidates: 4, skipped: 4, vector: null });
const says = (text: string): AnswerOne => async () => ({ state: 'answered', text, citations: [], model: 'stub' });

function aiStub(text: string | Error, seen: AiAnswerInput[] = []): AiAnswerer {
  return async (input) => {
    seen.push(input);
    if (text instanceof Error) throw text;
    return { text, model: 'free-stub' };
  };
}

/** A public post nothing matched, its author's AI answer written. */
async function aiOnlyPost(author: string, first = 'Water less often.') {
  const posted = await posts.publishPost(author, { question: `Why are my monstera leaves yellow? ${crypto.randomUUID()}`, detail: 'It sits by a north window.', lang: 'en' });
  if (!posted.ok) throw new Error(posted.error);
  await posts.processPost(posted.id, { judge: approve, match: noMatch, aiAnswer: aiStub(first) });
  return posted.id;
}

async function ask(userId: string, postId: string, question: string) {
  const asked = await followups.askFollowup(userId, postId, { question, lang: 'en' });
  if (!asked.ok) throw new Error(asked.error);
  return asked.id;
}

const aiRowOf = async (followupId: string) => (await db().select().from(schema.postAiAnswer).where(eq(schema.postAiAnswer.followupId, followupId)))[0];
const followupRow = async (id: string) => (await db().select().from(schema.postFollowup).where(eq(schema.postFollowup.id, id)))[0]!;
const postRow = async (id: string) => (await db().select().from(schema.post).where(eq(schema.post.id, id)))[0]!;
const ledger = async (userId: string) =>
  (await db().select({ reason: schema.creditEntry.reason, delta: schema.creditEntry.delta }).from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, userId), inArray(schema.creditEntry.reason, ['ai_answer_hold', 'ai_answer_settle', 'ai_answer_refund']))).orderBy(schema.creditEntry.createdAt)).map((row) => [row.reason, row.delta]);

async function signIn(userId: string | null) {
  if (!userId) return void (token = undefined);
  token = crypto.randomUUID();
  await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId, expiresAt: new Date(Date.now() + 60_000) });
}
const request = (url: string, body?: unknown) =>
  new NextRequest(`http://localhost:3000${url}`, body === undefined ? { headers: { host: 'localhost:3000' } } : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000' } });
const pageJson = async (id: string) => JSON.stringify(await (await getRoute(request(`/api/posts/${id}`), { params: Promise.resolve({ id }) })).json());

describeWithDb('继续问 AI on a public post no Ree answered', () => {
  it('lets the author ask on, answered by the AI at the base fee with the thread so far, seen by nobody else', async () => {
    const author = await user('aif-author', 200);
    const other = await user('aif-reader', 100);
    const id = await aiOnlyPost(author, 'Water less often.');
    expect(await balanceOf(db(), author)).toBe(200 - AI_ANSWER_FEE);

    /* Only the author gets the box. Anyone else: no first-round Ree, no box, refused by the service and the route. */
    expect((await posts.getPost(id, author))!).toMatchObject({ followupAiOnly: true, followupCandidates: [], followupBlocked: null });
    expect((await posts.getPost(id, other))!.followupAiOnly).toBe(false);
    expect((await posts.getPost(id))!.followupAiOnly).toBe(false);
    expect(await followups.askFollowup(other, id, { question: 'Me too?', lang: 'en' })).toEqual({ ok: false, error: 'no_candidates' });
    await signIn(other);
    const refused = await askRoute(request(`/api/posts/${id}/followups`, { question: 'Me too?' }), { params: Promise.resolve({ id }) });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: 'no_candidates' });
    await signIn(null);
    expect((await askRoute(request(`/api/posts/${id}/followups`, { question: 'Me too?' }), { params: Promise.resolve({ id }) })).status).toBe(401);
    /* No Ree to @. */
    expect(await followups.askFollowup(author, id, { question: 'Which pot?', mentionReeIds: [crypto.randomUUID()], lang: 'en' })).toEqual({ ok: false, error: 'mention_unavailable' });

    /* Through the route: published at once (no review), answered after the response. */
    await signIn(author);
    later.length = 0;
    const made = await askRoute(request(`/api/posts/${id}/followups`, { question: 'How often should I water it?', clientToken: crypto.randomUUID() }), { params: Promise.resolve({ id }) });
    expect(made.status).toBe(201);
    expect(later).toHaveLength(1);
    later.length = 0;
    await signIn(null);
    const first = ((await made.json()) as { id: string }).id;
    expect(await followupRow(first)).toMatchObject({ aiOnly: true, status: 'published', answerState: 'waiting', mentionReeIds: [] });
    const seen: AiAnswerInput[] = [];
    await followups.processFollowup(first, { judge: noReview, aiAnswer: aiStub('Once a week [1].', seen) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userId: author, question: 'How often should I water it?', thread: { postQuestion: expect.stringContaining('north window'), earlierAnswer: 'Water less often.', earlierRounds: [] } });
    expect(await aiRowOf(first)).toMatchObject({ state: 'answered', userId: author, price: AI_ANSWER_FEE, text: 'Once a week.' });
    expect(await followupRow(first)).toMatchObject({ answerState: 'done', candidates: 0 });
    expect(await balanceOf(db(), author)).toBe(200 - 2 * AI_ANSWER_FEE);

    /* The next one carries the earlier AI rounds: the question and the AI's answer to it. */
    const second = await ask(author, id, 'And in winter?');
    const seen2: AiAnswerInput[] = [];
    await followups.processFollowup(second, { judge: noReview, aiAnswer: aiStub('Less in winter.', seen2) });
    expect(seen2[0]!.thread).toMatchObject({ earlierAnswer: 'Water less often.', earlierRounds: [{ question: 'How often should I water it?', answer: 'Once a week.' }] });
    const prompt = aiAnswerPrompt(seen2[0]!.question, seen2[0]!.detail, seen2[0]!.thread);
    expect(prompt).toContain('Why are my monstera leaves yellow?');
    expect(prompt).toContain('- How often should I water it?\n  Your general answer: Once a week.');
    expect(await balanceOf(db(), author)).toBe(200 - 3 * AI_ANSWER_FEE);
    expect(await ledger(author)).toEqual([['ai_answer_hold', -AI_ANSWER_FEE], ['ai_answer_settle', 0], ['ai_answer_hold', -AI_ANSWER_FEE], ['ai_answer_settle', 0], ['ai_answer_hold', -AI_ANSWER_FEE], ['ai_answer_settle', 0]]);

    /* The author reads the thread with its AI answers. */
    const mine = (await posts.getPost(id, author))!;
    expect(mine.followups.map((entry) => [entry.question, entry.aiOnly, entry.aiAnswer?.state, entry.aiAnswer?.folded])).toEqual([
      ['How often should I water it?', true, 'answered', false],
      ['And in winter?', true, 'answered', false],
    ]);

    /* Nobody else: no follow-ups, no count, still 待回答. */
    expect((await postRow(id)).followupCount).toBe(0);
    for (const viewer of [other, undefined]) {
      const theirs = (await posts.getPost(id, viewer))!;
      expect(theirs.followups).toEqual([]);
      expect(theirs.followupCount).toBe(0);
      expect(theirs.aiAnswer).toBeNull();
      const card = (await posts.listFeed('latest', { viewerId: viewer, size: 50 })).items.find((entry) => entry.id === id)!;
      expect(card.followupCount).toBe(0);
      expect(card.followups).toEqual([]);
      expect((await posts.listFeed('unanswered', { viewerId: viewer, size: 50 })).items.map((entry) => entry.id)).toContain(id);
    }
    await signIn(other);
    const asOther = await pageJson(id);
    expect(asOther).not.toContain('How often should I water it?');
    expect(asOther).not.toContain('Once a week');
    await signIn(null);
    const asVisitor = await pageJson(id);
    expect(asVisitor).not.toContain('And in winter?');
    expect(asVisitor).not.toContain('Less in winter');
    /* Nobody else can report what they cannot see, and the author hears of nothing as a poster. */
    expect(await followups.reportFollowup(first, `user:${other}`)).toBe(false);
    expect(await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.kind, 'post_followup')))).toEqual([]);

    /* Deleting one leaves the post's count alone. */
    expect(await followups.deleteFollowup(author, second)).toBe(true);
    expect((await postRow(id)).followupCount).toBe(0);
  });

  it('gives the fee back when the model fails, and skips a short balance until one generation by hand', async () => {
    const author = await user('aif-author', 100);
    const id = await aiOnlyPost(author);
    expect(await balanceOf(db(), author)).toBe(100 - AI_ANSWER_FEE);

    const failing = await ask(author, id, 'Is it the light?');
    await followups.processFollowup(failing, { judge: noReview, aiAnswer: aiStub(new Error('model down')) });
    expect(await aiRowOf(failing)).toMatchObject({ state: 'failed', price: 0 });
    expect(await balanceOf(db(), author)).toBe(100 - AI_ANSWER_FEE);
    expect((await ledger(author)).slice(-2)).toEqual([['ai_answer_hold', -AI_ANSWER_FEE], ['ai_answer_refund', AI_ANSWER_FEE]]);

    /* Asked with the fee in hand, spent elsewhere before the AI's turn: skipped, nothing charged. */
    const short = await ask(author, id, 'Is it the pot?');
    await drain(author);
    await followups.processFollowup(short, { judge: noReview, aiAnswer: aiStub('unused') });
    expect(await aiRowOf(short)).toMatchObject({ state: 'skipped_balance', holdId: null, price: 0 });
    expect((await posts.getPost(id, author))!.followups.find((entry) => entry.id === short)!.aiAnswer).toMatchObject({ state: 'skipped_balance', retry: true, cost: 0 });
    expect(await ai.retryAiAnswer(author, id, short)).toEqual({ ok: false, error: 'insufficient', balance: 0, needed: AI_ANSWER_FEE });

    await topUp(author, 50);
    const retried = await ai.retryAiAnswer(author, id, short);
    if (!retried.ok) throw new Error(retried.error);
    await ai.runAiAnswer(retried.id, { aiAnswer: aiStub('Check the drainage holes.') });
    expect(await aiRowOf(short)).toMatchObject({ state: 'answered', price: AI_ANSWER_FEE, text: 'Check the drainage holes.' });
    expect(await balanceOf(db(), author)).toBe(50 - AI_ANSWER_FEE);
    /* Once only. */
    expect(await ai.retryAiAnswer(author, id, short)).toEqual({ ok: false, error: 'already' });
  });

  it('folds the AI thread once a Ree is brought in (请 Ree 回答), never feeds the AI a Ree’s text, and makes follow-ups public again', async () => {
    const free = await makeRee();
    const author = await user('aif-author', 300);
    const other = await user('aif-reader', 100);
    const id = await aiOnlyPost(author, 'Water less often.');
    const first = await ask(author, id, 'How often should I water it?');
    await followups.processFollowup(first, { judge: noReview, aiAnswer: aiStub('Once a week.') });
    /* Asked before the Ree came, answered after. */
    const pending = await ask(author, id, 'And in winter?');

    const requested = await posts.requestReeAnswer(author, id, free.reeId);
    if (!requested.ok) throw new Error(requested.error);
    expect(requested.state).toBe('answering');
    await posts.answerPaid(requested.id, { answerOne: says('A Ree secret: bottom-water it.') });
    /* A Ree in the first round closes 继续问 AI. */
    expect(await ai.aiFollowupsOpen(id, author)).toBe(false);

    /* The pending one still goes to the AI alone, with the AI rounds and no Ree text. */
    const seen: AiAnswerInput[] = [];
    await followups.processFollowup(pending, { judge: noReview, matchFollowup: async () => ({ similarity: new Map([[free.reeId, 0.9]]), vector: null }), answerOne: says('unused'), aiAnswer: aiStub('Less in winter.', seen) });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain('Ree secret');
    expect(seen[0]!.thread).toMatchObject({ earlierAnswer: 'Water less often.', earlierRounds: [{ question: 'How often should I water it?', answer: 'Once a week.' }] });
    expect(await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.followupId, pending))).toEqual([]);

    /* The author: the Ree's answer, the AI answer and the AI thread folded under it, kept and not refunded. */
    const mine = (await posts.getPost(id, author))!;
    expect(mine.answers.map((entry) => entry.reeId)).toEqual([free.reeId]);
    expect(mine.aiAnswer).toMatchObject({ state: 'answered', folded: true });
    expect(mine.followups.map((entry) => [entry.aiOnly, entry.aiAnswer?.state, entry.aiAnswer?.folded])).toEqual([
      [true, 'answered', true],
      [true, 'answered', true],
    ]);
    expect(mine.followupAiOnly).toBe(false);
    expect(mine.followupCandidates.map((entry) => entry.reeId)).toEqual([free.reeId]);
    expect(await balanceOf(db(), author)).toBe(300 - 3 * AI_ANSWER_FEE - BASE);
    expect((await posts.getPost(id, other))!.followups).toEqual([]);

    /* From now on follow-ups are public: reviewed, counted, seen and asked by anyone, answered by the first round's Ree. */
    const open = await ask(author, id, 'Should I repot it?');
    expect(await followupRow(open)).toMatchObject({ aiOnly: false, status: 'pending' });
    await followups.processFollowup(open, { judge: approve, matchFollowup: async () => ({ similarity: new Map([[free.reeId, 0.9]]), vector: null }), answerOne: says('Repot in spring.'), aiAnswer: aiStub('unused') });
    expect(await followupRow(open)).toMatchObject({ status: 'published', answerState: 'done' });
    expect((await postRow(id)).followupCount).toBe(1);
    const theirs = (await posts.getPost(id, other))!;
    expect(theirs.followups.map((entry) => entry.question)).toEqual(['Should I repot it?']);
    expect(theirs.followups[0]!.answers.map((entry) => entry.text)).toEqual(['Repot in spring.']);
    const asked = await followups.askFollowup(other, id, { question: 'Which soil?', lang: 'en' });
    expect(asked.ok).toBe(true);
  });
});

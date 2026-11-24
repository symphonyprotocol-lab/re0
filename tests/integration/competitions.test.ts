/**
 * Ree 比赛 (docs/design/competitions.md) against a real database, with the
 * model endpoints on the local fake: the whole state machine (draft →
 * pending → open → answering → judging → review → published, and the
 * refused and cancelled ways out), the money (every competition hold ends
 * settled or released, and each balance moves by exactly what was
 * charged), and the secret: a reference answer or rubric never reaches
 * anyone but its host -- no page, route, answer sheet or answer prompt --
 * until the results of a competition that reveals it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { CompetitionAnswerInput, CompetitionAnswerer } from '@/lib/services/competition-judge';
import type { Judge } from '@/lib/services/public-qa';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let token: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 're0_session' && token ? { value: token } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: () => undefined }));

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const competitions = await import('@/lib/services/competitions');
const run = await import('@/lib/services/competition-run');
const { retrieve } = await import('@/lib/services/retrieval');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { COMPETITION_ANSWER_FEE: FEE, COMPETITION_JUDGE_FEE: JUDGE_FEE } = await import('@/lib/domain/competition');
const { GET: getRoute } = await import('@/app/api/competitions/[id]/route');
const { GET: sheetRoute } = await import('@/app/api/competitions/[id]/entries/[entryId]/route');
const { GET: listRoute } = await import('@/app/api/competitions/route');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  await fake?.close();
});

const day = 86_400_000;

async function user(prefix: string, credits = 0, ageDays = 30) {
  const subject = uniqueName(prefix);
  const { userId, sessionToken: session } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
  await db().update(schema.user).set({ createdAt: new Date(Date.now() - ageDays * day) }).where(eq(schema.user.id, userId));
  if (credits > 0) await topUp(userId, credits);
  return { userId, session };
}

const topUp = (userId: string, credits: number) => db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
const drain = (userId: string) => db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
const balance = (userId: string) => balanceOf(db(), userId);

/** A public Ree with ready knowledge. */
async function makeRee(ownerId: string, content = 'Refunds are issued to the original payment method within 14 days of the request.') {
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Refund desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: 'Refunds', content });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true, systemPrompt: 'Answer briefly.' }).where(eq(schema.ree.id, ree.id));
  return ree.id;
}

const tag = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const approve: Judge = async () => ({ publish: true });
const refuse: Judge = async () => ({ publish: false, reason: 'test' });

/** A stub entrant answer that records what each Ree was shown. */
function answering(seen: CompetitionAnswerInput[] = [], text = 'Refunds go back to the card within 14 days [1].'): CompetitionAnswerer {
  return async (input) => {
    seen.push(input);
    return { state: 'answered', text, citations: [], model: 'stub-answer' };
  };
}

interface Setup {
  host: { userId: string; session: string };
  /** The host's balance once their Ree's knowledge was paid for, before the deposit. */
  base: number;
  id: string;
  slug: string;
  secret: string;
  rubric: string;
}

/** A host with a public Ree, and a submitted competition of two questions whose references hold `secret`. */
async function hosted(options: { payer?: 'entrant' | 'host'; questionMode?: 'open' | 'closed'; revealReference?: boolean; maxEntries?: number; hostCredits?: number; review?: Judge } = {}): Promise<Setup> {
  const host = await user('cmp-host', options.hostCredits ?? 5_000);
  await makeRee(host.userId);
  const base = await balance(host.userId);
  const secret = `SECRET-${crypto.randomUUID()}`;
  const rubric = `RUBRIC-${crypto.randomUUID()}`;
  const slug = tag('cup');
  const made = await competitions.createDraft(host.userId, { title: 'Refund Cup', channel: `#${slug}`, lang: 'en', payer: options.payer ?? 'entrant', questionMode: options.questionMode ?? 'open', revealReference: options.revealReference ?? false, maxEntries: options.maxEntries ?? 10, deadlineAt: new Date(Date.now() + 3 * day).toISOString(), reviewHours: 1 });
  if (!made.ok) throw new Error(made.error);
  const set = await competitions.setQuestions(host.userId, made.id, [
    { question: 'When are refunds issued?', referenceAnswer: `Within 14 days. ${secret}`, rubric },
    { question: 'Where does a refund go?', detail: 'Name the payment method.', referenceAnswer: `To the original payment method. ${secret}`, rubric, weight: 2 },
  ]);
  expect(set).toEqual({ ok: true, count: 2 });
  expect(await competitions.submitCompetition(host.userId, made.id)).toEqual({ ok: true });
  expect(await competitions.reviewCompetition(made.id, options.review ?? approve)).toBe(options.review === refuse ? 'rejected' : 'open');
  return { host, base, id: made.id, slug: made.slug, secret, rubric };
}

const row = async (id: string) => (await db().select().from(schema.competition).where(eq(schema.competition.id, id)))[0]!;
const holdsOf = (id: string) =>
  db()
    .select()
    .from(schema.creditHold)
    .where(and(eq(schema.creditHold.kind, 'competition'), inArray(schema.creditHold.refId, [id, ...[]])));
async function allHolds(competitionId: string) {
  const entries = await db().select({ id: schema.competitionEntry.id }).from(schema.competitionEntry).where(eq(schema.competitionEntry.competitionId, competitionId));
  return db().select().from(schema.creditHold).where(and(eq(schema.creditHold.kind, 'competition'), inArray(schema.creditHold.refId, [competitionId, ...entries.map((item) => item.id)])));
}
/** Past the deadline, as the cron would find it. */
const expire = (id: string) => db().update(schema.competition).set({ deadlineAt: new Date(Date.now() - 1_000) }).where(eq(schema.competition.id, id));
/** Cron runs until the competition reaches `status` (or gives up). */
async function runUntil(id: string, status: string, deps: Parameters<typeof run.runCompetitions>[0], tries = 6) {
  for (let i = 0; i < tries; i += 1) {
    if ((await row(id)).status === status) return;
    await run.runCompetitions(deps, { budgetMs: 60_000, concurrency: 2 });
  }
  expect((await row(id)).status).toBe(status);
}

const request = (url: string) => new NextRequest(new URL(url, 'http://localhost'));
const asUser = (session: string | undefined) => {
  token = session;
};

describeWithDb('competitions', () => {
  it('runs the whole way: entries, the deadline, answers, judging, review, an override, the results -- and the books balance', async () => {
    const { host, base, id, slug, secret, rubric } = await hosted();
    const deposit = 10 * 2 * JUDGE_FEE;
    /* Submitting held the deposit (judge fees for every place; the entrants pay their answers). */
    expect(await balance(host.userId)).toBe(base - deposit);
    const opened = await row(id);
    expect(opened.status).toBe('open');
    expect(opened.answerFee).toBe(FEE);
    /* Open book: both questions are posts in the competition's channel, by the host, answered as far as the posts' pipeline goes. */
    const questions = await db().select().from(schema.competitionQuestion).where(eq(schema.competitionQuestion.competitionId, id));
    const postIds = questions.map((item) => item.postId!);
    const questionPosts = await db().select().from(schema.post).where(inArray(schema.post.id, postIds));
    expect(questionPosts.map((item) => [item.source, item.status, item.answerState, item.userId])).toEqual([['competition', 'published', 'done', host.userId], ['competition', 'published', 'done', host.userId]]);
    const filed = await db().select().from(schema.postChannel).where(inArray(schema.postChannel.postId, postIds));
    expect(new Set(filed.map((item) => item.channelId))).toEqual(new Set([opened.channelId]));

    const a = await user('cmp-a', 1_000);
    const b = await user('cmp-b', 1_000);
    const reeA = await makeRee(a.userId);
    const reeB = await makeRee(b.userId);
    const [startA, startB] = [await balance(a.userId), await balance(b.userId)];
    const hostRee = (await db().select({ id: schema.ree.id }).from(schema.ree).where(eq(schema.ree.ownerId, host.userId)))[0]!.id;
    expect(await competitions.enterCompetition(host.userId, id, hostRee)).toEqual({ ok: false, error: 'own_competition' });
    expect(await competitions.enterCompetition(a.userId, id, reeB)).toEqual({ ok: false, error: 'not_your_ree' });
    const entryA = await competitions.enterCompetition(a.userId, id, reeA);
    expect(entryA.ok).toBe(true);
    expect(await competitions.enterCompetition(a.userId, id, reeA)).toEqual({ ok: false, error: 'already' });
    /* Withdrawn and back: nothing charged either way. */
    expect(await competitions.withdrawEntry(a.userId, (entryA as { entryId: string }).entryId)).toBe(true);
    expect((await competitions.enterCompetition(a.userId, id, reeA)).ok).toBe(true);
    const entryB = await competitions.enterCompetition(b.userId, id, reeB);
    expect(entryB.ok).toBe(true);
    expect(await balance(a.userId)).toBe(startA);
    expect((await row(id)).entryCount).toBe(2);

    /* The deadline: entries lock, each holds its two answers, the deposit swaps for the judge's hold. */
    await expire(id);
    const seen: CompetitionAnswerInput[] = [];
    await run.lockCompetition(id, { answerModel: async () => 'fake-gen-1', judgeModel: async () => 'fake-gen-1' });
    const locked = await row(id);
    expect(locked.status).toBe('answering');
    expect(locked.depositHoldId).toBeNull();
    expect(await balance(a.userId)).toBe(startA - 2 * FEE);
    expect(await balance(host.userId)).toBe(base - 2 * 2 * JUDGE_FEE);
    expect(await competitions.enterCompetition(a.userId, id, reeA)).toEqual({ ok: false, error: 'closed' });
    const entries = await db().select().from(schema.competitionEntry).where(eq(schema.competitionEntry.competitionId, id));
    expect(entries.map((item) => item.status).sort()).toEqual(['locked', 'locked']);
    expect(entries.every((item) => item.systemPrompt === 'Answer briefly.' && item.lockedAt)).toBe(true);

    /* Answers, reviews and judging (the fake model's judge), on to review. */
    await runUntil(id, 'review', { answerOne: answering(seen), review: approve });
    expect(seen).toHaveLength(4);
    expect(seen.every((input) => !input.subject.includes(secret) && !input.subject.includes(rubric))).toBe(true);
    expect(seen.some((input) => input.subject.includes('Name the payment method.'))).toBe(true);
    const answers = await db().select().from(schema.competitionAnswer).where(eq(schema.competitionAnswer.competitionId, id));
    expect(answers.map((item) => [item.state, item.review, item.judgeState, item.aiScore])).toEqual(Array(4).fill(['answered', 'passed', 'done', 7.5]));
    expect(answers.every((item) => item.aiScores.length === 2)).toBe(true);
    /* The judge saw the reference; it never wrote it into a rationale (not revealed). */
    expect(fake.requests.some((item) => item.prompt?.includes(secret) && item.system?.includes('You grade one answer'))).toBe(true);
    expect(answers.every((item) => !item.rationale?.includes(secret))).toBe(true);
    const notices = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, host.userId), eq(schema.notice.kind, 'competition_review_ready')));
    expect(notices).toHaveLength(1);

    /* Nobody but the host reads anything before the results; the entrant reads their own answers, unscored. */
    expect(await competitions.hostReview(a.userId, id)).toBeNull();
    const review = await competitions.hostReview(host.userId, id);
    expect(review?.answers).toHaveLength(4);
    expect(await competitions.entrySheet(slug, (entryB as { entryId: string }).entryId, a.userId)).toBeNull();
    const own = await competitions.entrySheet(slug, (entryA as { entryId: string }).entryId, a.userId);
    expect(own?.scored).toBe(false);
    expect(own?.answers.every((item) => item.aiScore === null && item.text)).toBe(true);

    /* The host overrides one score, with a reason, logged. */
    const target = review!.answers.find((item) => item.entryId === (entryB as { entryId: string }).entryId && item.ordinal === 2)!;
    expect(await competitions.setHostScore(host.userId, target.id, { score: 10, note: '' })).toEqual({ ok: false, error: 'invalid_note' });
    expect(await competitions.setHostScore(a.userId, target.id, { score: 10, note: 'mine' })).toEqual({ ok: false, error: 'not_found' });
    expect(await competitions.setHostScore(host.userId, target.id, { score: 10, note: 'Names the card exactly.' })).toEqual({ ok: true, score: 10 });
    const log = await db().select().from(schema.competitionScoreLog).where(eq(schema.competitionScoreLog.answerId, target.id));
    expect(log.map((item) => [item.actor, item.fromScore, item.toScore])).toEqual([['host', 7.5, 10]]);

    /* The results: settled for what was answered and judged, answers copied onto the question posts, everyone told. */
    expect(await competitions.publishCompetition(id, new Date(), { hostId: a.userId })).toBe(false);
    expect(await competitions.publishCompetition(id, new Date(), { hostId: host.userId })).toBe(true);
    expect((await row(id)).status).toBe('published');
    expect(await competitions.setHostScore(host.userId, target.id, { score: 1, note: 'late' })).toEqual({ ok: false, error: 'locked' });
    const holds = await allHolds(id);
    expect(holds.length).toBe(4);
    expect(holds.every((item) => item.status !== 'held')).toBe(true);
    expect(await balance(a.userId)).toBe(startA - 2 * FEE);
    expect(await balance(b.userId)).toBe(startB - 2 * FEE);
    expect(await balance(host.userId)).toBe(base - 4 * JUDGE_FEE);
    const page = await competitions.getCompetition(slug);
    expect(page?.leaderboard?.map((item) => [item.reeId, item.rank, item.total])).toEqual([
      [reeB, 1, 91.7],
      [reeA, 2, 75],
    ]);
    const copied = await db().select().from(schema.postAnswer).where(inArray(schema.postAnswer.postId, postIds));
    expect(copied).toHaveLength(4);
    expect(copied.every((item) => item.price === null && item.baseHoldId === null)).toBe(true);
    const counted = await db().select({ answers: schema.post.answerCount }).from(schema.post).where(inArray(schema.post.id, postIds));
    expect(counted.map((item) => item.answers)).toEqual([2, 2]);
    const told = await db().select().from(schema.notice).where(and(inArray(schema.notice.userId, [a.userId, b.userId]), eq(schema.notice.kind, 'competition_results')));
    expect(told).toHaveLength(2);

    /* Not revealed: the reference and rubric stay out of every public read, after the results too. */
    asUser(undefined);
    const publicJson = JSON.stringify(await (await getRoute(request(`/api/competitions/${id}`), { params: Promise.resolve({ id }) })).json());
    expect(publicJson).not.toContain(secret);
    expect(publicJson).not.toContain(rubric);
    const sheetJson = JSON.stringify(await (await sheetRoute(request(`/api/competitions/${id}/entries/${(entryA as { entryId: string }).entryId}`), { params: Promise.resolve({ id, entryId: (entryA as { entryId: string }).entryId }) })).json());
    expect(sheetJson).toContain('Refunds go back');
    expect(sheetJson).not.toContain(secret);
    expect(JSON.stringify(await (await listRoute(request('/api/competitions?tab=published'))).json())).not.toContain(secret);
    /* The host reads them in their own management view. */
    asUser(host.session);
    const hostJson = JSON.stringify(await (await getRoute(request(`/api/competitions/${id}`), { params: Promise.resolve({ id }) })).json());
    expect(hostJson).toContain(secret);
    expect(hostJson).toContain(rubric);
    asUser(a.session);
    expect(JSON.stringify(await (await getRoute(request(`/api/competitions/${id}`), { params: Promise.resolve({ id }) })).json())).not.toContain(secret);
    asUser(undefined);
  });

  it('answers from the knowledge as it stood at the deadline, under the system prompt then, and never shows the reference to the model', async () => {
    const { id, slug, secret, rubric } = await hosted({ revealReference: true });
    const entrant = await user('cmp-freeze', 1_000);
    const reeId = await makeRee(entrant.userId);
    expect((await competitions.enterCompetition(entrant.userId, id, reeId)).ok).toBe(true);
    await expire(id);
    await run.lockCompetition(id, {});
    const [locked] = await db().select().from(schema.competitionEntry).where(eq(schema.competitionEntry.competitionId, id));
    const [frozen] = await db().select({ id: schema.knowledge.id }).from(schema.knowledge).where(eq(schema.knowledge.reeId, reeId));
    /* After the deadline: a new source, and a new persona -- neither may count. */
    const lateId = await knowledge.addKnowledge(entrant.userId, { id: reeId }, { kind: 'text', title: 'Late', content: 'LATE-FACT: refunds are issued within 99 days of the request.' });
    await knowledge.processKnowledge(lateId, { profile: false });
    await db().update(schema.ree).set({ systemPrompt: 'Answer in pirate speak.' }).where(eq(schema.ree.id, reeId));
    const asOf = locked!.lockedAt!;
    expect((await retrieve(reeId, 'When are refunds issued?', undefined, { asOf: new Date(asOf.getTime() - 60_000) })).passages).toHaveLength(0);
    const found = (await retrieve(reeId, 'When are refunds issued?', undefined, { asOf })).passages.map((item) => item.knowledgeId);
    expect(found).toContain(frozen!.id);
    expect(found).not.toContain(lateId);
    expect((await retrieve(reeId, 'When are refunds issued?')).passages.map((item) => item.knowledgeId)).toContain(lateId);
    const before = fake.requests.length;
    await runUntil(id, 'review', { review: approve });
    const answerPrompts = fake.requests.slice(before).filter((item) => item.prompt !== undefined && !item.system?.includes('You grade one answer') && !item.system?.includes('You turn a user'));
    expect(answerPrompts.length).toBeGreaterThan(0);
    expect(answerPrompts.every((item) => !item.prompt!.includes(secret) && !item.prompt!.includes(rubric))).toBe(true);
    expect(answerPrompts.some((item) => item.prompt!.includes('Answer briefly.'))).toBe(true);
    expect(answerPrompts.some((item) => item.prompt!.includes('pirate') || item.prompt!.includes('LATE-FACT'))).toBe(false);
    const answers = await db().select().from(schema.competitionAnswer).where(eq(schema.competitionAnswer.competitionId, id));
    expect(answers.some((item) => item.state === 'answered')).toBe(true);
    expect(answers.filter((item) => item.state === 'answered').every((item) => item.model === 'fake-gen-1' && item.text)).toBe(true);
    /* Revealed after the results: the reference, never the rubric. */
    await run.runCompetitions({ now: () => new Date(Date.now() + 2 * 3_600_000) }, { budgetMs: 1_000, concurrency: 1 });
    expect((await row(id)).status).toBe('published');
    const page = JSON.stringify(await competitions.getCompetition(slug));
    expect(page).toContain(secret);
    expect(page).not.toContain(rubric);
  });

  it('keeps a closed-book competition’s questions back until the deadline', async () => {
    const { host, id, slug, secret } = await hosted({ questionMode: 'closed' });
    expect((await competitions.getCompetition(slug))?.questionList).toBeNull();
    expect((await competitions.getCompetition(slug, host.userId))?.questionList).toHaveLength(2);
    const questions = await db().select().from(schema.competitionQuestion).where(eq(schema.competitionQuestion.competitionId, id));
    expect(questions.every((item) => item.postId === null)).toBe(true);
    expect(JSON.stringify(await competitions.getCompetition(slug, host.userId))).not.toContain(secret);
    await expire(id);
    await run.lockCompetition(id, {});
    expect((await competitions.getCompetition(slug))?.questionList?.map((item) => item.question)).toEqual(['When are refunds issued?', 'Where does a refund go?']);
    const opened = await db().select().from(schema.competitionQuestion).where(eq(schema.competitionQuestion.competitionId, id));
    expect(opened.every((item) => item.postId)).toBe(true);
  });

  it('gives the deposit back when the review refuses it', async () => {
    const { host, base, id } = await hosted({ review: refuse });
    expect((await row(id)).status).toBe('rejected');
    expect(await balance(host.userId)).toBe(base);
    expect((await holdsOf(id)).map((item) => item.status)).toEqual(['released']);
    const [told] = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, host.userId), eq(schema.notice.kind, 'competition_published')));
    expect(told?.params.ok).toBe(0);
  });

  it('refuses a deposit the host cannot cover, and lets a host cancel before anyone enters', async () => {
    const host = await user('cmp-poor', 60);
    await makeRee(host.userId);
    const start = await balance(host.userId);
    const made = await competitions.createDraft(host.userId, { title: 'Too big', channel: tag('big'), lang: 'en', maxEntries: 30, deadlineAt: new Date(Date.now() + 2 * day).toISOString() });
    if (!made.ok) throw new Error(made.error);
    await competitions.setQuestions(host.userId, made.id, [{ question: 'Q?', referenceAnswer: 'A.' }]);
    expect(await competitions.submitCompetition(host.userId, made.id)).toEqual({ ok: false, error: 'insufficient', balance: start, needed: 30 * JUDGE_FEE });
    const places = Math.floor(start / JUDGE_FEE);
    await db().update(schema.competition).set({ maxEntries: places }).where(eq(schema.competition.id, made.id));
    expect(await competitions.submitCompetition(host.userId, made.id)).toEqual({ ok: true });
    expect(await balance(host.userId)).toBe(start - places * JUDGE_FEE);
    expect(await competitions.cancelCompetition(host.userId, made.id)).toEqual({ ok: true });
    expect(await balance(host.userId)).toBe(start);
    /* Its name is free again for a new draft. */
    const again = await competitions.createDraft(host.userId, { title: 'Smaller', channel: made.slug, lang: 'en' });
    expect(again).toMatchObject({ ok: true, slug: made.slug });
  });

  it('Q1: keeps new accounts and accounts without a public Ree from hosting', async () => {
    const fresh = await user('cmp-new', 1_000, 1);
    await makeRee(fresh.userId);
    expect(await competitions.createDraft(fresh.userId, { title: 'x', channel: tag('n'), lang: 'en' })).toEqual({ ok: false, error: 'host_too_new' });
    const bare = await user('cmp-bare', 1_000);
    expect(await competitions.createDraft(bare.userId, { title: 'x', channel: tag('n'), lang: 'en' })).toEqual({ ok: false, error: 'host_needs_ree' });
    const normal = await user('cmp-normal', 1_000);
    await makeRee(normal.userId);
    expect(await competitions.createDraft(normal.userId, { title: 'x', channel: tag('n'), lang: 'en', maxEntries: 31 })).toMatchObject({ ok: false, field: 'maxEntries' });
    /* A name people already tag posts with is not the host's. */
    const used = tag('used');
    await db().insert(schema.channel).values({ name: used, createdBy: bare.userId });
    expect(await competitions.createDraft(normal.userId, { title: 'x', channel: used, lang: 'en' })).toEqual({ ok: false, error: 'channel_taken', field: 'channel' });
  });

  it('skips an entrant short of the fee at the deadline, holding nothing', async () => {
    const { id } = await hosted();
    const poor = await user('cmp-short', 2 * FEE + 10);
    const reeId = await makeRee(poor.userId);
    expect((await competitions.enterCompetition(poor.userId, id, reeId)).ok).toBe(true);
    await drain(poor.userId);
    /* The 24-hour reminder, once. */
    await db().update(schema.competition).set({ deadlineAt: new Date(Date.now() + 3_600_000) }).where(eq(schema.competition.id, id));
    expect(await run.remindBalances()).toBeGreaterThanOrEqual(1);
    expect(await run.remindBalances()).toBe(0);
    await expire(id);
    await run.lockCompetition(id, {});
    const [skipped] = await db().select().from(schema.competitionEntry).where(eq(schema.competitionEntry.competitionId, id));
    expect(skipped?.status).toBe('skipped_balance');
    expect(skipped?.holdId).toBeNull();
    const kinds = (await db().select({ params: schema.notice.params }).from(schema.notice).where(and(eq(schema.notice.userId, poor.userId), eq(schema.notice.kind, 'competition_balance_short')))).map((item) => item.params.skipped ?? 0);
    expect(kinds.sort()).toEqual([0, 1]);
    /* Nobody locked: no judge hold, and it runs straight through to empty results. */
    expect((await row(id)).judgeHoldId).toBeNull();
    await runUntil(id, 'review', { review: approve });
    expect(await competitions.publishCompetition(id)).toBe(true);
    expect((await allHolds(id)).every((item) => item.status !== 'held')).toBe(true);
  });

  it('charges nothing for answers that failed or found nothing, and scores them 0', async () => {
    const { host, base, id } = await hosted({ payer: 'host' });
    const entrant = await user('cmp-fail', 10);
    const reeId = await makeRee(entrant.userId);
    const entrantStart = await balance(entrant.userId);
    /* The host pays: the entrant needs no balance. */
    expect((await competitions.enterCompetition(entrant.userId, id, reeId)).ok).toBe(true);
    await expire(id);
    let calls = 0;
    const flaky: CompetitionAnswerer = async ({ subject }) => {
      calls += 1;
      if (subject.startsWith('When')) return { state: 'failed', model: 'stub' };
      return { state: 'no_answer', model: 'stub' };
    };
    await run.lockCompetition(id, {});
    expect(await balance(host.userId)).toBe(base - 2 * FEE - 2 * JUDGE_FEE);
    for (let i = 0; i < 3; i += 1) {
      await run.runCompetitions({ answerOne: flaky, review: approve, now: () => new Date(Date.now() + i * 3_600_000) }, { budgetMs: 30_000, concurrency: 1 });
    }
    const answers = await db().select().from(schema.competitionAnswer).where(eq(schema.competitionAnswer.competitionId, id));
    expect(answers.map((item) => [item.state, item.attempts]).sort()).toEqual([['failed', 3], ['no_answer', 1]]);
    expect(calls).toBe(4);
    expect((await row(id)).status).toBe('review');
    expect(await competitions.publishCompetition(id)).toBe(true);
    expect(await balance(host.userId)).toBe(base);
    expect(await balance(entrant.userId)).toBe(entrantStart);
    const [placed] = await db().select().from(schema.competitionEntry).where(eq(schema.competitionEntry.competitionId, id));
    expect([placed?.rank, placed?.totalScore]).toEqual([1, 0]);
  });

  it('scores an answer refused by review 0, keeps its fee, and never publishes it', async () => {
    const { id, slug } = await hosted();
    const entrant = await user('cmp-refused', 1_000);
    const other = await user('cmp-reader', 0);
    const reeId = await makeRee(entrant.userId);
    const entrantStart = await balance(entrant.userId);
    const entered = await competitions.enterCompetition(entrant.userId, id, reeId);
    await expire(id);
    await run.lockCompetition(id, {});
    await runUntil(id, 'review', { answerOne: answering([], 'Something unpublishable.'), review: refuse });
    const answers = await db().select().from(schema.competitionAnswer).where(eq(schema.competitionAnswer.competitionId, id));
    expect(answers.map((item) => [item.review, item.judgeState])).toEqual([['rejected', null], ['rejected', null]]);
    expect(await competitions.publishCompetition(id)).toBe(true);
    /* Answered (charged), not judged (no judge fee). */
    expect(await balance(entrant.userId)).toBe(entrantStart - 2 * FEE);
    expect((await db().select().from(schema.postAnswer).where(inArray(schema.postAnswer.reeId, [reeId]))).length).toBe(0);
    const entryId = (entered as { entryId: string }).entryId;
    expect((await competitions.entrySheet(slug, entryId, other.userId))?.answers.every((item) => item.hidden && item.text === '')).toBe(true);
    expect((await competitions.entrySheet(slug, entryId, entrant.userId))?.answers.every((item) => !item.hidden && item.text)).toBe(true);
  });

  it('gives every hold back when the console cancels mid-run', async () => {
    const { host, base, id } = await hosted({ payer: 'host' });
    const entrant = await user('cmp-cancel', 10);
    const reeId = await makeRee(entrant.userId);
    expect((await competitions.enterCompetition(entrant.userId, id, reeId)).ok).toBe(true);
    await expire(id);
    await run.lockCompetition(id, {});
    expect(await competitions.cancelCompetition(host.userId, id)).toEqual({ ok: false, error: 'locked' });
    expect(await competitions.adminCancelCompetition(crypto.randomUUID(), id, 'test')).toBe(true);
    expect((await row(id)).status).toBe('cancelled');
    expect(await balance(host.userId)).toBe(base);
    expect((await allHolds(id)).every((item) => item.status === 'released')).toBe(true);
    const questions = await db().select({ postId: schema.competitionQuestion.postId }).from(schema.competitionQuestion).where(eq(schema.competitionQuestion.competitionId, id));
    const hidden = await db().select({ status: schema.post.status }).from(schema.post).where(inArray(schema.post.id, questions.map((item) => item.postId!)));
    expect(hidden.every((item) => item.status === 'hidden')).toBe(true);
  });
});

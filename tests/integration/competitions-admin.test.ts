/**
 * The console's actions on a Ree competition (docs/design/competitions.md
 * 7.5, Q7), through the routes `/admin/competitions/[id]` calls: the
 * detail read, 取消参赛资格 and 改分. Each needs an administrator session
 * and a reason; each is logged; after the results, ranks are recomputed
 * and the entrants whose rank moved are told; before them, a
 * disqualified entry's hold goes back.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { CompetitionAnswerer, CompetitionJudge } from '@/lib/services/competition-judge';
import type { Judge } from '@/lib/services/public-qa';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const session = vi.hoisted(() => ({ token: null as string | null }));
vi.mock('next/headers', async () => {
  const { ADMIN_SESSION_COOKIE } = await import('@/lib/http/cookies');
  return {
    cookies: async () => ({ get: (name: string) => (name === ADMIN_SESSION_COOKIE && session.token ? { value: session.token } : undefined) }),
    headers: async () => new Headers(),
  };
});

const { createSession } = await import('@/lib/services/auth');
const { openAdminSession } = await import('@/lib/services/admin');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const competitions = await import('@/lib/services/competitions');
const run = await import('@/lib/services/competition-run');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { COMPETITION_ANSWER_FEE: FEE } = await import('@/lib/domain/competition');
const detailRoute = await import('@/app/api/admin/competitions/[id]/route');
const disqualifyRoute = await import('@/app/api/admin/competitions/entries/[entryId]/route');
const scoreRoute = await import('@/app/api/admin/competitions/answers/[answerId]/score/route');

let fake: FakeOpenAi;
let administratorId: string;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
  if (!TEST_DATABASE_URL) return;
  const [admin] = await db().insert(schema.administrator).values({ name: 'Competitions', email: `${uniqueName('cmp-admin')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x' }).returning({ id: schema.administrator.id });
  administratorId = admin!.id;
});
afterAll(async () => {
  await fake?.close();
});

const day = 86_400_000;
const base = 'http://localhost:3000';

async function user(prefix: string, credits: number) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
  await db().update(schema.user).set({ createdAt: new Date(Date.now() - 30 * day) }).where(eq(schema.user.id, userId));
  await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

async function makeRee(ownerId: string, name: string) {
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName(name), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: 'Refunds', content: 'Refunds are issued to the original payment method within 14 days.' });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true }).where(eq(schema.ree.id, ree.id));
  return ree.id;
}

const approve: Judge = async () => ({ publish: true });
/* Each Ree answers with its own marker; the judge scores the marker, so the ranking is known. */
const answering: CompetitionAnswerer = async ({ reeId }) => ({ state: 'answered', text: `Answer ${marks.get(reeId) ?? 'LOW'}`, citations: [], model: 'stub' });
const judging: CompetitionJudge = async ({ material, swapped }) => {
  const high = material.answer.includes('HIGH');
  const mid = material.answer.includes('MID');
  const n = high ? 9 : mid ? 6 : 3;
  return { accuracy: n, completeness: n, citation: n, injection: false, rationale: 'stub', model: 'stub', swapped };
};
const marks = new Map<string, string>();

/** A competition of one question with three entries: HIGH, MID and LOW. `until` how far it goes. */
async function staged(until: 'review' | 'published') {
  const host = await user('cmpa-host', 5_000);
  await makeRee(host, 'Host desk');
  const made = await competitions.createDraft(host, { title: 'Console Cup', channel: `ccup${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, lang: 'en', deadlineAt: new Date(Date.now() + 3 * day).toISOString(), reviewHours: 24 });
  if (!made.ok) throw new Error(made.error);
  await competitions.setQuestions(host, made.id, [{ question: 'When are refunds issued?', referenceAnswer: 'Within 14 days.' }]);
  expect(await competitions.submitCompetition(host, made.id)).toEqual({ ok: true });
  expect(await competitions.reviewCompetition(made.id, approve)).toBe('open');
  const entrants = [];
  for (const mark of ['HIGH', 'MID', 'LOW']) {
    const userId = await user(`cmpa-${mark.toLowerCase()}`, 1_000);
    const reeId = await makeRee(userId, mark);
    marks.set(reeId, mark);
    const entered = await competitions.enterCompetition(userId, made.id, reeId);
    if (!entered.ok) throw new Error(entered.error);
    entrants.push({ userId, reeId, entryId: entered.entryId, mark });
  }
  await db().update(schema.competition).set({ deadlineAt: new Date(Date.now() - 1_000) }).where(eq(schema.competition.id, made.id));
  await run.lockCompetition(made.id, { answerModel: async () => 'stub', judgeModel: async () => 'stub' });
  for (let i = 0; i < 6; i += 1) {
    const [row] = await db().select({ status: schema.competition.status }).from(schema.competition).where(eq(schema.competition.id, made.id));
    if (row?.status === 'review') break;
    await run.runCompetitions({ answerOne: answering, judge: judging, review: approve }, { budgetMs: 60_000, concurrency: 2 });
  }
  if (until === 'published') expect(await competitions.publishCompetition(made.id)).toBe(true);
  return { host, id: made.id, entrants };
}

function request(path: string, method: string, payload?: unknown, origin = base) {
  return new NextRequest(`${base}${path}`, { method, headers: { origin, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
}
const signIn = async () => {
  session.token = (await openAdminSession(administratorId)).token;
};
const entryRow = async (id: string) => (await db().select().from(schema.competitionEntry).where(eq(schema.competitionEntry.id, id)))[0]!;
const results = (userId: string, competitionId: string) =>
  db().select({ params: schema.notice.params }).from(schema.notice).where(and(eq(schema.notice.userId, userId), eq(schema.notice.kind, 'competition_results'), eq(schema.notice.refId, competitionId)));

describeWithDb('the console on competitions', () => {
  it('needs an administrator session, a same-origin request and a well-formed id', async () => {
    const { id, entrants } = await staged('review');
    session.token = null;
    expect((await detailRoute.GET(request(`/api/admin/competitions/${id}`, 'GET'), { params: Promise.resolve({ id }) })).status).toBe(401);
    expect((await disqualifyRoute.POST(request(`/api/admin/competitions/entries/${entrants[0]!.entryId}`, 'POST', { reason: 'x' }), { params: Promise.resolve({ entryId: entrants[0]!.entryId }) })).status).toBe(401);
    await signIn();
    expect((await disqualifyRoute.POST(request(`/api/admin/competitions/entries/${entrants[0]!.entryId}`, 'POST', { reason: 'x' }, 'https://evil.example'), { params: Promise.resolve({ entryId: entrants[0]!.entryId }) })).status).toBe(403);
    expect((await scoreRoute.POST(request('/api/admin/competitions/answers/nope/score', 'POST', { score: 1, note: 'x' }), { params: Promise.resolve({ answerId: 'nope' }) })).status).toBe(404);
    const detail = await detailRoute.GET(request(`/api/admin/competitions/${id}`, 'GET'), { params: Promise.resolve({ id }) });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as Awaited<ReturnType<typeof competitions.adminCompetitionDetail>>;
    expect(body!.entries).toHaveLength(3);
    expect(body!.answers.map((item) => item.aiScore).sort()).toEqual([3, 6, 9]);
    expect([body!.canScore, body!.canDisqualify]).toEqual([true, true]);
    /* The detail never carries a reference answer: the console reads it on the host's own pages. */
    expect(JSON.stringify(body)).not.toContain('Within 14 days.');
  });

  it('Q7: changes a published score with a reason, logs it, recomputes ranks and tells whoever moved', async () => {
    const { id, entrants } = await staged('published');
    await signIn();
    const detail = (await competitions.adminCompetitionDetail(id))!;
    expect(detail.entries.map((item) => [marks.get(item.reeId), item.rank])).toEqual([['HIGH', 1], ['MID', 2], ['LOW', 3]]);
    const low = detail.answers.find((item) => item.excerpt.includes('LOW'))!;
    const path = `/api/admin/competitions/answers/${low.id}/score`;
    const params = { params: Promise.resolve({ answerId: low.id }) };
    expect(await (await scoreRoute.POST(request(path, 'POST', { score: 10, note: ' ' }), params)).json()).toEqual({ error: 'invalid_note' });
    expect(await (await scoreRoute.POST(request(path, 'POST', { score: 11, note: 'Too high' }), { params: Promise.resolve({ answerId: low.id }) })).json()).toEqual({ error: 'invalid_score' });
    const changed = await scoreRoute.POST(request(path, 'POST', { score: 10, note: 'The reference was wrong; this answer is right.' }), { params: Promise.resolve({ answerId: low.id }) });
    expect(changed.status).toBe(200);
    const after = (await competitions.adminCompetitionDetail(id))!;
    expect(after.entries.map((item) => [marks.get(item.reeId), item.rank])).toEqual([['LOW', 1], ['HIGH', 2], ['MID', 3]]);
    expect(after.scoreLog.map((item) => [item.actor, item.from, item.to, item.note])).toEqual([['admin', 3, 10, 'The reference was wrong; this answer is right.']]);
    expect(after.scoreLog[0]!.actorName).toBe('Competitions');
    expect(after.audit.map((item) => item.action)).toEqual(['competition.score']);
    /* Everyone moved: each hears the correction once, beside the results notice. */
    for (const entrant of entrants) {
      const corrected = (await results(entrant.userId, id)).filter((item) => item.params.corrected === 1);
      expect(corrected).toHaveLength(1);
    }
    /* The answer sheet shows the change and its reason. */
    const [found] = await db().select({ slug: schema.competition.slug }).from(schema.competition).where(eq(schema.competition.id, id));
    const sheet = await competitions.entrySheet(found!.slug, entrants[2]!.entryId);
    expect(sheet?.answers[0]?.log.map((item) => [item.actor, item.to])).toEqual([['admin', 10]]);
    expect(sheet?.entry.rank).toBe(1);
  });

  it('disqualifies after the results with a reason: off the leaderboard, answers hidden, ranks recomputed, credits kept', async () => {
    const { id, entrants } = await staged('published');
    await signIn();
    const top = entrants[0]!;
    const balance = await balanceOf(db(), top.userId);
    const path = `/api/admin/competitions/entries/${top.entryId}`;
    expect(await (await disqualifyRoute.POST(request(path, 'POST', { reason: '' }), { params: Promise.resolve({ entryId: top.entryId }) })).json()).toEqual({ error: 'invalid_reason' });
    expect((await entryRow(top.entryId)).status).toBe('locked');
    const done = await disqualifyRoute.POST(request(path, 'POST', { reason: 'Copied another entrant’s sources.' }), { params: Promise.resolve({ entryId: top.entryId }) });
    expect(done.status).toBe(200);
    const row = await entryRow(top.entryId);
    expect([row.status, row.rank, row.disqualifiedReason]).toEqual(['disqualified', null, 'Copied another entrant’s sources.']);
    expect((await disqualifyRoute.POST(request(path, 'POST', { reason: 'again' }), { params: Promise.resolve({ entryId: top.entryId }) })).status).toBe(409);
    const detail = (await competitions.adminCompetitionDetail(id))!;
    expect(detail.entries.filter((item) => item.status === 'locked').map((item) => [marks.get(item.reeId), item.rank])).toEqual([['MID', 1], ['LOW', 2]]);
    expect(detail.audit.map((item) => item.action)).toEqual(['competition.disqualify']);
    expect(await balanceOf(db(), top.userId)).toBe(balance);
    const copied = await db().select({ hiddenBy: schema.postAnswer.hiddenBy }).from(schema.postAnswer).where(eq(schema.postAnswer.reeId, top.reeId));
    expect(copied.map((item) => item.hiddenBy)).toEqual(['admin']);
    const board = (await competitions.leaderboardOf(id)).map((item) => [marks.get(item.reeId), item.rank, item.disqualified]);
    expect(board).toEqual([['MID', 1, false], ['LOW', 2, false], ['HIGH', null, true]]);
    expect((await results(top.userId, id)).some((item) => item.params.corrected === 1 && item.params.rank === null)).toBe(true);
    expect((await results(entrants[1]!.userId, id)).some((item) => item.params.corrected === 1 && item.params.rank === 1)).toBe(true);
  });

  it('disqualifies before the results: the hold goes back and nothing is charged', async () => {
    const { id, entrants } = await staged('review');
    await signIn();
    const target = entrants[2]!;
    const before = await balanceOf(db(), target.userId);
    const { holdId } = await entryRow(target.entryId);
    const done = await disqualifyRoute.POST(request(`/api/admin/competitions/entries/${target.entryId}`, 'POST', { reason: 'Ree taken down for spam.' }), { params: Promise.resolve({ entryId: target.entryId }) });
    expect(done.status).toBe(200);
    expect(await balanceOf(db(), target.userId)).toBe(before + FEE);
    expect((await db().select({ status: schema.creditHold.status }).from(schema.creditHold).where(eq(schema.creditHold.id, holdId!)))[0]?.status).toBe('released');
    /* Its answer cannot be rescored, and publishing leaves it out. */
    const answer = (await competitions.adminCompetitionDetail(id))!.answers.find((item) => item.entryId === target.entryId)!;
    expect(await (await scoreRoute.POST(request(`/api/admin/competitions/answers/${answer.id}/score`, 'POST', { score: 9, note: 'no' }), { params: Promise.resolve({ answerId: answer.id }) })).json()).toEqual({ error: 'locked' });
    expect(await competitions.publishCompetition(id)).toBe(true);
    const holds = await db().select({ status: schema.creditHold.status }).from(schema.creditHold).where(inArray(schema.creditHold.refId, [id, ...entrants.map((item) => item.entryId)]));
    expect(holds.every((item) => item.status !== 'held')).toBe(true);
    expect(await balanceOf(db(), target.userId)).toBe(before + FEE);
    expect((await competitions.leaderboardOf(id)).find((item) => item.entryId === target.entryId)?.disqualified).toBe(true);
  });
});

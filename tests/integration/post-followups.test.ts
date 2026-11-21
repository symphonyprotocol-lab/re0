/**
 * 追问 (design draft 1, approved 2026-11-20): a signed-in reader asks on
 * under a public post; only Rees that answered its first round answer --
 * the @-mentioned ones, or else the relevant ones -- and whoever asks pays
 * (a paid Ree waits for the asker alone). A follow-up is reviewed, can be
 * reported, hidden and deleted, and never changes the post's own figures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { AnswerOne } from '@/lib/services/posts';
import type { FollowupDeps } from '@/lib/services/post-followups';

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
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { QUERY_BASE_FEE: BASE } = await import('@/lib/constants');
const { POST_REPORT_THRESHOLD } = await import('@/lib/domain/post');
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
  if (credits > 0) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

async function publicRee(queryFee = 0) {
  const ownerId = await user('fu-owner', 1_000);
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Refund desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: 'Refund policy', content: 'Refunds are issued to the original payment method within 14 days of the request.' });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true, queryFee, answersPosts: queryFee > 0 ? true : null }).where(eq(schema.ree.id, ree.id));
  return { ownerId, reeId: ree.id };
}

const approve = async () => ({ publish: true });

/** A post by `author` answered in its first round by these Rees. */
async function answeredPost(author: string, reeIds: string[]) {
  const posted = await posts.publishPost(author, { question: `When are refunds issued? ${crypto.randomUUID()}`, lang: 'en' });
  if (!posted.ok) throw new Error(posted.error);
  await posts.processPost(posted.id, {
    judge: approve,
    match: async () => ({ answerers: reeIds.map((reeId, index) => ({ reeId, similarity: 0.9 - index / 100, mentioned: false })), candidates: reeIds.length, skipped: 0, vector: null }),
    answerOne: async ({ reeId }) => ({ state: 'answered', text: `First round from ${reeId}.`, citations: [], model: 'stub' }),
  });
  return posted.id;
}

/** Follow-up deps: review passes, each Ree's relevance as given, answers recorded with what each Ree was given. */
function deps(similarity: Record<string, number>, seen: Parameters<AnswerOne>[0][] = [], judge = approve): FollowupDeps {
  return {
    judge,
    matchFollowup: async () => ({ similarity: new Map(Object.entries(similarity)), vector: null }),
    answerOne: async (input) => {
      seen.push(input);
      return { state: 'answered', text: `Follow-up from ${input.reeId}.`, citations: [], model: 'stub' };
    },
  };
}

async function ask(userId: string, postId: string, question: string, mentionReeIds: string[] = []) {
  const asked = await followups.askFollowup(userId, postId, { question, mentionReeIds, lang: 'en' });
  if (!asked.ok) throw new Error(asked.error);
  return asked.id;
}

const answersOf = (followupId: string) => db().select().from(schema.postAnswer).where(eq(schema.postAnswer.followupId, followupId));
const postRow = async (id: string) => (await db().select().from(schema.post).where(eq(schema.post.id, id)))[0]!;

describeWithDb('follow-ups in a post (追问)', () => {
  it('asks the relevant first-round Rees, charges whoever asked, and leaves the post itself as it was', async () => {
    const near = await publicRee();
    const far = await publicRee();
    const stranger = await publicRee();
    const author = await user('fu-author', 1_000);
    const postId = await answeredPost(author, [near.reeId, far.reeId]);
    const authorBalance = await balanceOf(db(), author);
    const before = await postRow(postId);

    const reader = await user('fu-reader', 1_000);
    /* Only a first-round Ree can be @-mentioned. */
    expect(await followups.askFollowup(reader, postId, { question: 'And for a gift card?', mentionReeIds: [stranger.reeId], lang: 'en' })).toEqual({ ok: false, error: 'mention_unavailable' });
    const id = await ask(reader, postId, 'And for a gift card?');
    const seen: Parameters<AnswerOne>[0][] = [];
    await followups.processFollowup(id, deps({ [near.reeId]: 0.8, [far.reeId]: 0.2, [stranger.reeId]: 0.99 }, seen));

    const rows = await answersOf(id);
    expect(rows.map((row) => row.reeId)).toEqual([near.reeId]);
    expect(rows[0]).toMatchObject({ state: 'answered', postId, mentioned: false });
    /* The asker pays one base fee; the post's author pays nothing more. */
    expect(await balanceOf(db(), reader)).toBe(1_000 - BASE);
    expect(await balanceOf(db(), author)).toBe(authorBalance);
    /* The Ree saw the post's question and its own first answer, not the other Ree's. */
    expect(seen).toHaveLength(1);
    expect(seen[0]!.subject).toContain('And for a gift card?');
    expect(seen[0]!.turns?.map((turn) => turn.content).join('\n')).toContain(`First round from ${near.reeId}.`);
    expect(seen[0]!.turns?.map((turn) => turn.content).join('\n')).not.toContain(far.reeId);

    const after = await postRow(postId);
    expect(after.answerCount).toBe(before.answerCount);
    expect(after.followupCount).toBe(1);
    const view = (await posts.getPost(postId))!;
    expect(view.answers.map((entry) => entry.reeId).sort()).toEqual([near.reeId, far.reeId].sort());
    expect(view.answered).toBe(2);
    expect(view.followups).toMatchObject([{ id, question: 'And for a gift card?', candidates: 2, skipped: 1, answerState: 'done', author: { poster: false, mine: false } }]);
    expect(view.followups[0]!.answers.map((entry) => entry.reeId)).toEqual([near.reeId]);
    expect(view.followups[0]!.spent).toBeNull();
    expect((await posts.getPost(postId, reader))!.followups[0]!.spent).toBe(BASE);
    /* The Ree page still lists the first round only. */
    expect((await posts.answeredPostCounts([near.reeId])).get(near.reeId)).toBe(1);

    /* The post's author hears of the follow-up; the asker of the answer. */
    const told = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.kind, 'post_followup')));
    expect(told).toMatchObject([{ refId: postId, params: { count: 1 } }]);
    const answered = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, reader), eq(schema.notice.kind, 'followup_answered')));
    expect(answered).toMatchObject([{ refId: postId, params: { answers: 1 } }]);

    /* A second follow-up carries the first one's question, and this Ree's answer to it. */
    const second = await ask(author, postId, 'What about store credit?');
    const later: Parameters<AnswerOne>[0][] = [];
    await followups.processFollowup(second, deps({ [near.reeId]: 0.8, [far.reeId]: 0.2 }, later));
    const context = later[0]!.turns!.map((turn) => turn.content).join('\n');
    expect(context).toContain('And for a gift card?');
    expect(context).toContain(`Follow-up from ${near.reeId}.`);
    expect((await posts.getPost(postId))!.followups[1]).toMatchObject({ author: { poster: true } });
    /* No notice to the author for their own follow-up. */
    expect(await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.kind, 'post_followup')))).toHaveLength(1);
  });

  it('asks only the @-mentioned Rees, whatever their relevance; none close enough means no answer and no charge', async () => {
    const one = await publicRee();
    const two = await publicRee();
    const author = await user('fu-author2', 1_000);
    const postId = await answeredPost(author, [one.reeId, two.reeId]);
    const reader = await user('fu-reader2', 1_000);
    const mentioned = await ask(reader, postId, 'Ask the second one', [two.reeId]);
    await followups.processFollowup(mentioned, deps({ [one.reeId]: 0.9, [two.reeId]: 0.1 }));
    expect((await answersOf(mentioned)).map((row) => [row.reeId, row.mentioned])).toEqual([[two.reeId, true]]);

    const nobody = await ask(reader, postId, 'Unrelated question');
    await followups.processFollowup(nobody, deps({ [one.reeId]: 0.1, [two.reeId]: 0.1 }));
    expect(await answersOf(nobody)).toHaveLength(0);
    /* No Ree charged for it; the reader's AI general answer took the base fee (ai-answers.ts). */
    expect(await balanceOf(db(), reader)).toBe(1_000 - 2 * BASE);
    const [row] = await db().select().from(schema.postFollowup).where(eq(schema.postFollowup.id, nobody));
    expect(row).toMatchObject({ answerState: 'done', candidates: 2, skipped: 2 });
  });

  it('lets only the asker agree to a paid Ree, at base fee plus query fee, which goes to its owner', async () => {
    const free = await publicRee();
    const paid = await publicRee(30);
    const author = await user('fu-author3', 1_000);
    const postId = await answeredPost(author, [free.reeId]);
    /* The paid Ree answered the first round on the author's agreement. */
    const [request] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, postId));
    await db().insert(schema.postAnswer).values({ postId, reeId: paid.reeId, state: 'answered', text: 'Paid first answer.', answeredAt: new Date() });
    expect(request).toBeTruthy();

    const reader = await user('fu-reader3', 1_000);
    const id = await ask(reader, postId, 'Paid one, please', [paid.reeId]);
    await followups.processFollowup(id, deps({}));
    const [waiting] = await answersOf(id);
    expect(waiting).toMatchObject({ state: 'awaiting', reeId: paid.reeId });
    expect(await balanceOf(db(), reader)).toBe(1_000);

    /* Only the asker sees the request; the post's author can neither see nor agree to it. */
    expect((await posts.getPost(postId, reader))!.followups[0]!.paidRequests).toMatchObject([{ id: waiting!.id, price: BASE + 30, state: 'awaiting' }]);
    expect((await posts.getPost(postId, author))!.followups[0]!.paidRequests).toEqual([]);
    expect((await posts.getPost(postId))!.followups[0]!.paidRequests).toEqual([]);
    expect(await posts.agreePaidAnswer(author, waiting!.id, BASE + 30)).toEqual({ ok: false, error: 'not_found' });
    expect(await posts.agreePaidAnswer(reader, waiting!.id, BASE)).toEqual({ ok: false, error: 'price_changed', price: BASE + 30 });

    const ownerBefore = await balanceOf(db(), paid.ownerId);
    expect(await posts.agreePaidAnswer(reader, waiting!.id, BASE + 30)).toEqual({ ok: true });
    const seen: Parameters<AnswerOne>[0][] = [];
    await posts.answerPaid(waiting!.id, { answerOne: async (input) => (seen.push(input), { state: 'answered', text: 'Paid follow-up.', citations: [], model: 'stub' }) });
    expect(seen[0]!.subject).toContain('Paid one, please');
    expect(await balanceOf(db(), reader)).toBe(1_000 - BASE - 30);
    expect(await balanceOf(db(), paid.ownerId)).toBe(ownerBefore + 30);
    expect((await posts.getPost(postId))!.followups[0]!.answers).toMatchObject([{ reeId: paid.reeId, paid: true }]);
    /* The post's own spend is the first round's only. */
    expect((await posts.getPost(postId, author))!.spent).toBe(BASE);
  });

  it('reviews, hides on reports and deletes a follow-up; its answers go with it', async () => {
    const one = await publicRee();
    const author = await user('fu-author4', 1_000);
    const postId = await answeredPost(author, [one.reeId]);
    const reader = await user('fu-reader4', 1_000);

    const refused = await ask(reader, postId, 'Something the review refuses');
    await followups.processFollowup(refused, deps({ [one.reeId]: 0.9 }, [], async () => ({ publish: false })));
    expect((await posts.getPost(postId))!.followups).toEqual([]);
    expect((await posts.getPost(postId, reader))!.followups).toMatchObject([{ id: refused, status: 'rejected' }]);
    expect(await balanceOf(db(), reader)).toBe(1_000);
    expect((await postRow(postId)).followupCount).toBe(0);

    const shown = await ask(reader, postId, 'A fair follow-up');
    await followups.processFollowup(shown, deps({ [one.reeId]: 0.9 }));
    const [given] = await answersOf(shown);
    for (let index = 0; index < POST_REPORT_THRESHOLD; index += 1) expect(await followups.reportFollowup(shown, `reporter-${crypto.randomUUID()}`)).toBe(true);
    expect((await postRow(postId)).followupCount).toBe(0);
    const others = (await posts.getPost(postId))!.followups;
    expect(others).toMatchObject([{ id: shown, status: 'hidden', question: '', answers: [] }]);
    expect((await posts.getPost(postId, reader))!.followups.find((entry) => entry.id === shown)).toMatchObject({ status: 'hidden', question: 'A fair follow-up', hiddenBy: 'reports' });
    /* Its answer takes no votes while hidden. */
    expect(await posts.setAnswerHelpful(author, given!.id, true)).toBeNull();

    const third = await ask(reader, postId, 'One to delete');
    await followups.processFollowup(third, deps({ [one.reeId]: 0.9 }));
    expect((await postRow(postId)).followupCount).toBe(1);
    expect(await followups.deleteFollowup(author, third)).toBe(false);
    expect(await followups.deleteFollowup(reader, third)).toBe(true);
    expect((await postRow(postId)).followupCount).toBe(0);
    expect((await posts.getPost(postId, reader))!.followups.map((entry) => entry.id)).not.toContain(third);
  });

  it('refuses without a base fee of balance, asks once per token, and needs a signed-in reader', async () => {
    const one = await publicRee();
    const author = await user('fu-author5', 1_000);
    const postId = await answeredPost(author, [one.reeId]);
    const poor = await user('fu-poor', 0);
    expect(await followups.askFollowup(poor, postId, { question: 'Can I?', lang: 'en' })).toEqual({ ok: false, error: 'insufficient_credits', balance: 0, needed: BASE });
    const reader = await user('fu-reader5', 1_000);
    const clientToken = crypto.randomUUID();
    const first = await followups.askFollowup(reader, postId, { question: 'Once', lang: 'en', clientToken });
    const again = await followups.askFollowup(reader, postId, { question: 'Once', lang: 'en', clientToken });
    expect(first.ok && again.ok && again.duplicate && again.id === first.id).toBe(true);

    const request = (body: unknown) => new NextRequest(`http://localhost:3000/api/posts/${postId}/followups`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000' } });
    token = undefined;
    expect((await askRoute(request({ question: 'Visitor' }), { params: Promise.resolve({ id: postId }) })).status).toBe(401);
    token = crypto.randomUUID();
    await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId: reader, expiresAt: new Date(Date.now() + 60_000) });
    const response = await askRoute(request({ question: 'Through the route', clientToken: crypto.randomUUID() }), { params: Promise.resolve({ id: postId }) });
    expect(response.status).toBe(201);
    expect(later.length).toBeGreaterThan(0);
    token = undefined;
  });
});

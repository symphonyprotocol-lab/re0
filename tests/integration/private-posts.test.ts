/**
 * Private posts (私密提问, design 稿 2): the author's own question to Rees
 * they chose, charged like a private question, seen by nobody else; its
 * follow-ups, owner actions, 转为公开 and 没帮助. And the legacy counters
 * frozen from the conversation tables before they go.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { dropConversationTables, pointModelsAt, restoreConversationTables, runBackfill, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import type { AnswerOne } from '@/lib/services/posts';

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
const { listPublicQa, publicQaPicks } = await import('@/lib/services/public-qa');
const { answersByOthers, reeCards } = await import('@/lib/services/explore');
const { votesByOthers } = await import('@/lib/services/ree-feedback');
const { computeRanks } = await import('@/lib/services/rank');
const { roleMetrics } = await import('@/lib/services/roles');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { QUERY_BASE_FEE: BASE } = await import('@/lib/constants');
const { POST: createRoute } = await import('@/app/api/posts/private/route');
const { PATCH: patchRoute } = await import('@/app/api/posts/[id]/route');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  await dropConversationTables();
  await fake?.close();
});

async function user(prefix: string, credits = 0) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, userId));
  if (credits > 0) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

/** A Ree with ready knowledge: public by default, or private; owned by a new user unless `ownerId` is given. */
async function makeRee(options: { queryFee?: number; isPublic?: boolean; ownerId?: string } = {}) {
  const ownerId = options.ownerId ?? (await user('pp-owner', 1_000));
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Refund desk'), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: 'Refund policy', content: 'Refunds are issued to the original payment method within 14 days of the request.' });
  await knowledge.processKnowledge(id, { profile: false });
  const isPublic = options.isPublic ?? true;
  await db().update(schema.ree).set({ isPublic, isPublished: isPublic, queryFee: options.queryFee ?? 0 }).where(eq(schema.ree.id, ree.id));
  return { ownerId, reeId: ree.id };
}

const answers = (text: (reeId: string) => string | null): AnswerOne => async ({ reeId }) => {
  const said = text(reeId);
  return said ? { state: 'answered', text: said, citations: [], model: 'stub' } : { state: 'no_answer', model: 'stub' };
};
const answerAll = answers((reeId) => `Private answer from ${reeId}.`);

async function ask(author: string, reeIds: string[], fees: Record<string, number> = {}, question = `When are refunds issued? ${crypto.randomUUID()}`) {
  const made = await privatePosts.publishPrivatePost(author, { question, reeIds, fees: Object.fromEntries(reeIds.map((id) => [id, fees[id] ?? BASE])), lang: 'en' });
  if (!made.ok) throw new Error(made.error);
  return made.id;
}

const answerRows = (postId: string) => db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, postId));
const postRow = async (id: string) => (await db().select().from(schema.post).where(eq(schema.post.id, id)))[0]!;

describeWithDb('private posts (私密提问)', () => {
  it('holds every chosen Ree at the shown price in one go, answers, and settles each answer', async () => {
    const free = await makeRee();
    const paid = await makeRee({ queryFee: 30 });
    const author = await user('pp-author', 1_000);
    const own = await makeRee({ ownerId: author, isPublic: false, queryFee: 10 });
    const stranger = await makeRee({ isPublic: false });
    /* Processing the own Ree's knowledge cost its owner a little. */
    const start = await balanceOf(db(), author);
    const reeIds = [free.reeId, paid.reeId, own.reeId];
    const question = `Refund timing ${crypto.randomUUID()}`;

    /* Someone else's private Ree cannot be asked; a price above the one shown refuses with today's prices. */
    expect(await privatePosts.publishPrivatePost(author, { question, reeIds: [free.reeId, stranger.reeId], fees: {}, lang: 'en' })).toEqual({ ok: false, error: 'ree_unavailable' });
    expect(await privatePosts.publishPrivatePost(author, { question, reeIds, fees: { [free.reeId]: BASE, [paid.reeId]: BASE, [own.reeId]: BASE }, lang: 'en' })).toEqual({
      ok: false,
      error: 'price_changed',
      prices: [{ reeId: free.reeId, price: BASE }, { reeId: paid.reeId, price: BASE + 30 }, { reeId: own.reeId, price: BASE }],
    });
    expect(await balanceOf(db(), author)).toBe(start);

    const clientToken = crypto.randomUUID();
    const fees = { [free.reeId]: BASE, [paid.reeId]: BASE + 30, [own.reeId]: BASE };
    const made = await privatePosts.publishPrivatePost(author, { question, reeIds, fees, lang: 'en', clientToken });
    expect(made.ok).toBe(true);
    const id = (made as { id: string }).id;
    /* Held before any answer: three base fees (own Ree included) and the paid Ree's query fee; never its own Ree's. */
    expect(await balanceOf(db(), author)).toBe(start - 3 * BASE - 30);
    expect(await privatePosts.publishPrivatePost(author, { question, reeIds, fees, lang: 'en', clientToken })).toEqual({ ok: true, id, duplicate: true });
    expect(await postRow(id)).toMatchObject({ visibility: 'private', status: 'published', source: 'post', answerState: 'answering' });

    const paidOwnerBefore = await balanceOf(db(), paid.ownerId);
    await privatePosts.processPrivatePost(id, { answerOne: answers((reeId) => (reeId === own.reeId ? null : `Private answer from ${reeId}.`)) });
    /* The own Ree found nothing: its base fee came back. */
    expect(await balanceOf(db(), author)).toBe(start - 2 * BASE - 30);
    expect(await balanceOf(db(), paid.ownerId)).toBe(paidOwnerBefore + 30);
    expect(await postRow(id)).toMatchObject({ answerState: 'done', answerCount: 2 });

    const view = (await posts.getPost(id, author))!;
    expect(view).toMatchObject({ visibility: 'private', title: null, pinned: false, archived: false, publishedCopyId: null, paidRequests: [], spent: 2 * BASE + 30 });
    expect(view.answers.map((entry) => [entry.reeId, entry.cost])).toEqual([[free.reeId, BASE], [paid.reeId, BASE + 30]]);
    /* No notice: the author is on the page. */
    expect(await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.kind, 'post_answered')))).toEqual([]);

    /* Not enough for every hold: nothing is saved, nothing held. */
    const poor = await user('pp-poor', BASE + 5);
    const before = await db().select({ n: sql<number>`count(*)::int` }).from(schema.post).where(eq(schema.post.userId, poor));
    expect(await privatePosts.publishPrivatePost(poor, { question, reeIds: [free.reeId, paid.reeId], fees, lang: 'en' })).toEqual({ ok: false, error: 'insufficient_credits', balance: BASE + 5, needed: 2 * BASE + 30 });
    expect(await db().select({ n: sql<number>`count(*)::int` }).from(schema.post).where(eq(schema.post.userId, poor))).toEqual(before);
    expect(await balanceOf(db(), poor)).toBe(BASE + 5);
  });

  it('suggests close public Rees with their prices', async () => {
    const near = await makeRee({ queryFee: 10 });
    const far = await makeRee();
    const hidden = await makeRee({ isPublic: false });
    const viewer = await user('pp-suggest');
    const found = await privatePosts.suggestPrivateRees(viewer, 'Refunds?', async () => [
      { reeId: hidden.reeId, similarity: 0.95 },
      { reeId: near.reeId, similarity: 0.9 },
      { reeId: far.reeId, similarity: 0.1 },
    ]);
    expect(found).toEqual([expect.objectContaining({ reeId: near.reeId, price: BASE + 10, paid: true, similarity: 0.9 })]);
  });

  it('picks Rees for 选 Ree / 加 Ree: public ones and the viewer\'s own, never someone else\'s private one', async () => {
    const viewer = await user('pp-pick', 1_000);
    const paid = await makeRee({ queryFee: 15 });
    const own = await makeRee({ isPublic: false, ownerId: viewer });
    const hidden = await makeRee({ isPublic: false });
    const [paidName] = await db().select({ name: schema.ree.name }).from(schema.ree).where(eq(schema.ree.id, paid.reeId));
    const found = await privatePosts.privateReeOptions(viewer, { q: paidName!.name });
    expect(found).toEqual([expect.objectContaining({ reeId: paid.reeId, price: BASE + 15, paid: true, similarity: null })]);
    const named = await privatePosts.privateReeOptions(viewer, { ids: [hidden.reeId, own.reeId, paid.reeId, 'nope'] });
    expect(named.map((entry) => [entry.reeId, entry.price])).toEqual([[own.reeId, BASE], [paid.reeId, BASE + 15]]);
    expect(await privatePosts.privateReeOptions(viewer, { ids: [] })).toEqual([]);
  });

  it('is invisible to everyone but its author', async () => {
    const free = await makeRee();
    const author = await user('pp-author2', 1_000);
    const other = await user('pp-other', 1_000);
    const question = `Secret refund question ${crypto.randomUUID()}`;
    const id = await ask(author, [free.reeId], {}, question);
    await privatePosts.processPrivatePost(id, { answerOne: answerAll });
    const [given] = await answerRows(id);

    expect(await posts.getPost(id)).toBeNull();
    expect(await posts.getPost(id, other)).toBeNull();
    expect((await posts.getPost(id, author))!.answers.map((entry) => entry.id)).toEqual([given!.id]);
    for (const tab of ['latest', 'for_you', 'unanswered'] as const) {
      expect((await posts.listFeed(tab, { viewerId: author, q: question })).items).toEqual([]);
    }
    expect(await posts.postMeta(id)).toBeNull();
    expect((await posts.indexablePosts()).map((row) => row.id)).not.toContain(id);
    expect((await posts.reeAnsweredPosts(free.reeId))!.total).toBe(0);
    expect((await posts.answeredPostCounts([free.reeId])).get(free.reeId)).toBeUndefined();
    expect((await listPublicQa(free.reeId))!.total).toBe(0);
    expect((await publicQaPicks(free.reeId, 3)).total).toBe(0);
    expect((await reeCards([free.reeId]))[0]!.publicQa).toBe(0);
    expect(await posts.publishPost(other, { question: 'Quoting it', quotePostId: id, lang: 'en' })).toEqual({ ok: false, error: 'quote_unavailable' });
    expect(await posts.setPostSaved(other, id, true)).toBe(false);
    expect(await posts.setPostSaved(author, id, true)).toBe(false);
    expect(await posts.reportPost(id, 'someone')).toBe(false);
    expect(await posts.reportAnswer(given!.id, 'someone')).toBe(false);
    expect(await posts.setPostHelpful(other, id, true)).toBeNull();
    expect(await posts.setAnswerHelpful(other, given!.id, true)).toBeNull();
    expect(await posts.ownerActOnAnswer(free.ownerId, free.reeId, given!.id, 'hide')).toBe(false);
    expect(await posts.ownerActOnAnswer(free.ownerId, free.reeId, given!.id, 'pin')).toBe(false);
    expect(await followups.askFollowup(other, id, { question: 'Me too?', lang: 'en' })).toEqual({ ok: false, error: 'not_found' });
    expect(await privatePosts.askPrivateFollowup(other, id, { question: 'Me too?', lang: 'en' })).toEqual({ ok: false, error: 'not_found' });
    expect(await privatePosts.setAnswerUnhelpful(other, given!.id, true)).toBeNull();
    expect((await posts.adminPosts({ view: 'all', q: question })).map((row) => row.id)).not.toContain(id);

    /* Its author may still vote on its answers, and finds it in 我的帖子 → 私密. */
    expect(await posts.setAnswerHelpful(author, given!.id, true)).toMatchObject({ helpful: 1, voted: true });
    expect((await posts.listMyPosts(author, 'private')).items.map((item) => item.id)).toEqual([id]);
    expect((await posts.listMyPosts(author, 'all')).items.map((item) => item.id)).toEqual([id]);
    expect((await posts.listMyPosts(author, 'public')).items).toEqual([]);
    expect(await posts.myPostCounts(author)).toEqual({ all: 1, public: 0, private: 1, trash: 0 });
    expect(await posts.setPostTrashed(author, id, true)).toBe(true);
    expect(await posts.setAnswerHelpful(author, given!.id, false)).toBeNull();
    expect((await posts.listMyPosts(author, 'trash')).items.map((item) => item.id)).toEqual([id]);
  });

  it('follows up for the author only: named and added Rees answer, charged at send, the closest one when none is close', async () => {
    const one = await makeRee();
    const two = await makeRee();
    const paid = await makeRee({ queryFee: 30 });
    const author = await user('pp-author3', 1_000);
    const id = await ask(author, [one.reeId]);
    await privatePosts.processPrivatePost(id, { answerOne: answerAll });
    expect(await balanceOf(db(), author)).toBe(1_000 - BASE);

    /* 加 Ree: added at a price above the one shown → refused; at the right price it is held before the answer. */
    const asked = { question: 'And for a gift card?', addReeIds: [paid.reeId], mentionReeIds: [one.reeId], lang: 'en' as const };
    expect(await privatePosts.askPrivateFollowup(author, id, { ...asked, fees: { [one.reeId]: BASE, [paid.reeId]: BASE } })).toMatchObject({ ok: false, error: 'price_changed' });
    const added = await privatePosts.askPrivateFollowup(author, id, { ...asked, fees: { [one.reeId]: BASE, [paid.reeId]: BASE + 30 } });
    expect(added.ok).toBe(true);
    const first = (added as { id: string }).id;
    expect(await balanceOf(db(), author)).toBe(1_000 - 3 * BASE - 30);
    const seen: Parameters<AnswerOne>[0][] = [];
    await privatePosts.processPrivateFollowup(first, { answerOne: async (input) => (seen.push(input), { state: 'answered', text: `Follow-up from ${input.reeId}.`, citations: [], model: 'stub' }) });
    expect((await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.followupId, first))).map((row) => [row.reeId, row.state]).sort()).toEqual([[one.reeId, 'answered'], [paid.reeId, 'answered']].sort());
    expect(await balanceOf(db(), author)).toBe(1_000 - 3 * BASE - 30);
    /* The thread Ree saw its own first answer as context. */
    expect(seen.find((input) => input.reeId === one.reeId)!.turns!.map((turn) => turn.content).join('\n')).toContain(`Private answer from ${one.reeId}.`);

    /* No name: nobody close enough → the closest one answers anyway. */
    const quiet = await privatePosts.askPrivateFollowup(author, id, { question: 'Anything else?', fees: { [one.reeId]: BASE, [paid.reeId]: BASE + 30 }, lang: 'en' }, { matchFollowup: async () => ({ similarity: new Map([[one.reeId, 0.1], [paid.reeId, 0.3]]), vector: null }) });
    expect(quiet.ok).toBe(true);
    const quietRows = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.followupId, (quiet as { id: string }).id));
    expect(quietRows.map((row) => row.reeId)).toEqual([paid.reeId]);

    /* At most five Rees in the thread. */
    const more = await Promise.all([makeRee(), makeRee(), makeRee(), makeRee()]);
    expect(await privatePosts.askPrivateFollowup(author, id, { question: 'Everyone?', addReeIds: more.map((entry) => entry.reeId), fees: {}, lang: 'en' })).toEqual({ ok: false, error: 'too_many_rees' });
    expect(await privatePosts.askPrivateFollowup(author, id, { question: 'Stranger?', mentionReeIds: [two.reeId], fees: {}, lang: 'en' })).toEqual({ ok: false, error: 'mention_unavailable' });

    const view = (await posts.getPost(id, author))!;
    expect(view.followups.map((entry) => entry.status)).toEqual(['published', 'published']);
    expect(view.followups[0]!.paidRequests).toEqual([]);
    expect(view.followupCandidates.map((entry) => entry.reeId).sort()).toEqual([one.reeId, paid.reeId].sort());
    expect(view.followups[0]!.answers.every((entry) => entry.cost !== null)).toBe(true);
    expect(await db().select().from(schema.notice).where(and(eq(schema.notice.userId, author), eq(schema.notice.kind, 'followup_answered')))).toEqual([]);
  });

  it('pins, archives and renames, for its author only', async () => {
    const one = await makeRee();
    const author = await user('pp-author4', 1_000);
    const older = await ask(author, [one.reeId]);
    const newer = await ask(author, [one.reeId]);
    expect(await privatePosts.updatePrivatePost(author, older, { pinned: true, title: '  My refunds  ' })).toEqual({ ok: true, pinned: true, archived: false, title: 'My refunds' });
    expect(await privatePosts.updatePrivatePost(author, older, { title: 'x'.repeat(121) })).toEqual({ ok: false, error: 'title_too_long' });
    expect(await privatePosts.updatePrivatePost(await user('pp-other4'), older, { pinned: false })).toEqual({ ok: false, error: 'not_found' });
    expect((await posts.listMyPosts(author, 'private')).items.map((item) => item.id)).toEqual([older, newer]);
    expect((await posts.listMyPosts(author, 'private', 1, 15, { q: 'My refunds' })).items.map((item) => item.id)).toEqual([older]);

    expect((await privatePosts.updatePrivatePost(author, newer, { archived: true })).ok).toBe(true);
    expect((await posts.listMyPosts(author, 'private')).items.map((item) => item.id)).toEqual([older]);
    expect((await posts.listMyPosts(author, 'private', 1, 15, { archived: true })).items.map((item) => item.id)).toEqual([newer]);

    /* Through the route, signed in. */
    token = crypto.randomUUID();
    await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId: author, expiresAt: new Date(Date.now() + 60_000) });
    const patch = (body: unknown) => patchRoute(new NextRequest(`http://localhost:3000/api/posts/${older}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000' } }), { params: Promise.resolve({ id: older }) });
    const renamed = await patch({ title: '', pinned: false });
    expect(await renamed.json()).toEqual({ pinned: false, archived: false, title: null });
    expect(await (await patch({ trashed: true })).json()).toEqual({ trashed: true });
    token = undefined;
  });

  it('is made public as a reviewed copy with its answers, once; its follow-ups stay private', async () => {
    const one = await makeRee();
    const two = await makeRee();
    const author = await user('pp-author5', 1_000);
    const id = await ask(author, [one.reeId, two.reeId]);
    await privatePosts.processPrivatePost(id, { answerOne: answerAll });
    const asked = await privatePosts.askPrivateFollowup(author, id, { question: 'More?', mentionReeIds: [one.reeId], fees: { [one.reeId]: BASE }, lang: 'en' });
    await privatePosts.processPrivateFollowup((asked as { id: string }).id, { answerOne: answerAll });
    const balance = await balanceOf(db(), author);

    const copied = await privatePosts.convertToPublic(author, id, { anonymous: true });
    expect(copied.ok).toBe(true);
    const copyId = (copied as { id: string }).id;
    expect(await privatePosts.convertToPublic(author, id)).toEqual({ ok: false, error: 'already', id: copyId });
    expect(await privatePosts.convertToPublic(await user('pp-other5'), id)).toEqual({ ok: false, error: 'not_found' });
    expect(await postRow(copyId)).toMatchObject({ visibility: 'public', status: 'pending', anonymous: true, answerState: 'done', answerCount: 2 });
    expect((await answerRows(copyId)).map((row) => [row.state, row.similarity, row.baseHoldId, row.followupId])).toEqual([['answered', null, null, null], ['answered', null, null, null]]);
    expect(await balanceOf(db(), author)).toBe(balance);

    const reviewed: string[] = [];
    await posts.processPost(copyId, { judge: async (question, given) => (reviewed.push(question, given), { publish: true }) });
    expect(reviewed[1]).toContain(`Private answer from ${one.reeId}.`);
    expect(reviewed[1]).toContain(`Private answer from ${two.reeId}.`);
    const shown = (await posts.getPost(copyId, await user('pp-reader5')))!;
    expect(shown).toMatchObject({ visibility: 'public', status: 'published', answered: 2, followups: [], author: { kind: 'hidden' } });
    expect(shown.answers.every((entry) => entry.cost === null)).toBe(true);
    expect((await posts.getPost(id, author))!.publishedCopyId).toBe(copyId);
    expect((await posts.reeAnsweredPosts(one.reeId))!.items.map((item) => item.id)).toEqual([copyId]);

    /* Refused by the review: it stays refused, the private post as it was. */
    const second = await ask(author, [one.reeId]);
    await privatePosts.processPrivatePost(second, { answerOne: answerAll });
    const refused = await privatePosts.convertToPublic(author, second);
    await posts.processPost((refused as { id: string }).id, { judge: async () => ({ publish: false }) });
    expect(await postRow((refused as { id: string }).id)).toMatchObject({ status: 'rejected' });
    expect((await posts.getPost(second, author))!).toMatchObject({ visibility: 'private', status: 'published' });
    expect(await posts.getPost((refused as { id: string }).id)).toBeNull();
  });

  it('takes 没帮助 from its author, which takes back 有帮助', async () => {
    const one = await makeRee();
    const author = await user('pp-author6', 1_000);
    const id = await ask(author, [one.reeId]);
    await privatePosts.processPrivatePost(id, { answerOne: answerAll });
    const [given] = await answerRows(id);
    await posts.setAnswerHelpful(author, given!.id, true);
    expect(await privatePosts.setAnswerUnhelpful(author, given!.id, true)).toEqual({ unhelpful: 1, unvoted: true, helpful: 0, voted: false });
    expect((await posts.getPost(id, author))!.answers[0]).toMatchObject({ unhelpful: 1, unvoted: true, helpful: 0, voted: false });
    expect(await posts.setAnswerHelpful(author, given!.id, true)).toMatchObject({ helpful: 1, voted: true });
    expect((await posts.getPost(id, author))!.answers[0]).toMatchObject({ unhelpful: 0, unvoted: false });
    expect(await privatePosts.setAnswerUnhelpful(author, given!.id, false)).toEqual({ unhelpful: 0, unvoted: false, helpful: 1, voted: true });

    /* A public post's answer takes no 没帮助. */
    const posted = await posts.publishPost(author, { question: `Public one ${crypto.randomUUID()}`, lang: 'en' });
    await posts.processPost((posted as { id: string }).id, { judge: async () => ({ publish: true }), match: async () => ({ answerers: [{ reeId: one.reeId, similarity: 0.9, mentioned: false }], candidates: 1, skipped: 0, vector: null }), answerOne: answerAll });
    const [publicAnswer] = await answerRows((posted as { id: string }).id);
    expect(await privatePosts.setAnswerUnhelpful(author, publicAnswer!.id, true)).toBeNull();
  });

  it('is asked through the route: 201, then answered after the response; 409 with the prices', async () => {
    const paid = await makeRee({ queryFee: 30 });
    const author = await user('pp-author7', 1_000);
    token = crypto.randomUUID();
    await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId: author, expiresAt: new Date(Date.now() + 60_000) });
    const request = (body: unknown) => new NextRequest('http://localhost:3000/api/posts/private', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', host: 'localhost:3000' } });
    const changed = await createRoute(request({ question: 'Through the route', reeIds: [paid.reeId], fees: { [paid.reeId]: BASE } }));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'price_changed', prices: [{ reeId: paid.reeId, price: BASE + 30 }] });
    const queued = later.length;
    const made = await createRoute(request({ question: 'Through the route', reeIds: [paid.reeId], fees: { [paid.reeId]: BASE + 30 }, clientToken: crypto.randomUUID() }));
    expect(made.status).toBe(201);
    expect(later.length).toBe(queued + 1);
    token = undefined;
  });
});

/* ---------------------------------------------------------- legacy counters */

/** The backfill exactly as migration 0066 runs it. */
const runLegacyBackfill = () => runBackfill('legacy-stats');

describeWithDb('legacy counters from conversations', () => {
  it('backfills what explore, rank and roles count from conversations today', async () => {
    /* The conversation tables, gone since migration 0070, back for this test only. */
    await restoreConversationTables();
    const { ownerId, reeId } = await makeRee();
    const askers = [await user('lg-a'), await user('lg-b'), await user('lg-c')];
    /** One exchange in a new conversation of `userId` (raw SQL: the schema no longer has the tables); answers the ree message's id. */
    const exchange = async (userId: string, options: { noAnswer?: boolean; copied?: boolean } = {}) => {
      const conversationId = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const replyId = crypto.randomUUID();
      const copied = options.copied ?? false;
      await db().execute(sql`insert into conversation (id, user_id) values (${conversationId}, ${userId})`);
      await db().execute(sql`insert into message (id, conversation_id, role, content, request_id, copied_from_post) values (${requestId}, ${conversationId}, 'user', 'Q?', ${requestId}, ${copied})`);
      await db().execute(sql`insert into message (id, conversation_id, role, ree_id, content, no_answer, request_id, copied_from_post)
        values (${replyId}, ${conversationId}, 'ree', ${reeId}, ${options.noAnswer ? '' : 'A.'}, ${options.noAnswer ?? false}, ${requestId}, ${copied})`);
      return replyId;
    };
    const answered = [await exchange(askers[0]!), await exchange(askers[1]!), await exchange(askers[2]!)];
    await exchange(askers[0]!, { noAnswer: true });
    await exchange(askers[1]!, { copied: true });
    const own = await exchange(ownerId);
    for (const [messageId, userId, vote] of [[answered[0]!, askers[0]!, 'up'], [answered[1]!, askers[1]!, 'up'], [answered[2]!, askers[2]!, 'down'], [own, ownerId, 'up']] as const) {
      await db().execute(sql`insert into ree_feedback (message_id, user_id, vote) values (${messageId}, ${userId}, ${vote})`);
    }

    await runLegacyBackfill();
    await computeRanks();
    const [now] = await db()
      .select({ answers: answersByOthers, up: votesByOthers('up'), down: votesByOthers('down'), rank: schema.ree.rank })
      .from(schema.ree)
      .where(eq(schema.ree.id, reeId));
    const metrics = await roleMetrics(db(), ownerId);
    const [ree] = await db().select().from(schema.reeLegacyStats).where(eq(schema.reeLegacyStats.reeId, reeId));
    const [person] = await db().select().from(schema.userLegacyStats).where(eq(schema.userLegacyStats.userId, ownerId));

    expect(now).toMatchObject({ answers: 3, up: 2, down: 1 });
    expect(ree).toMatchObject({ answersByOthers: now!.answers, answersAll: now!.rank!.answersAll, helpful: now!.up, unhelpful: now!.down, questionsByOthers: 4 });
    expect(metrics).toMatchObject({ externalQuestions: 4, helpful: 2, unhelpful: 1 });
    expect(person).toEqual({ userId: ownerId, externalQuestions: metrics.externalQuestions, helpful: metrics.helpful, unhelpful: metrics.unhelpful });

    /* Run again (a re-deploy, another file's rows): the same figures. */
    await runLegacyBackfill();
    expect((await db().select().from(schema.reeLegacyStats).where(eq(schema.reeLegacyStats.reeId, reeId)))[0]).toMatchObject({ answersByOthers: 3, helpful: 2, unhelpful: 1, answersAll: 3, questionsByOthers: 4 });
  });
});

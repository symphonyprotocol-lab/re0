/**
 * Step 4 acceptance (rebuild-proposal.md 8.4): five Rees and no sixth;
 * questions go to everyone, to an `@`-named one, or to "only this Ree"
 * without changing who is in; Rees answer side by side in their own parts;
 * a Ree with nothing relevant neither answers nor charges, and when nobody
 * can, public Rees are suggested; someone else's Ree costs 20 + its fee,
 * which lands in the owner's earned credits as `query_fee_earned`; explore
 * finds Rees by their passages and lists active ones without a question; a
 * Ree turned private leaves other people's conversations with its history
 * kept; a question brings an archived conversation back; the trash empties
 * after 30 days; and the cards carry the owner's role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { Client } from '@neondatabase/serverless';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const chat = await import('@/lib/services/chat');
const conversations = await import('@/lib/services/conversations');
const { answer } = await import('@/lib/services/answer');
const explore = await import('@/lib/services/explore');
const { computeRanks } = await import('@/lib/services/rank');
const { publicReeBySlug, relatedFor } = await import('@/lib/services/public-rees');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { questionTargets, parseConversationQuery } = await import('@/lib/domain/conversation');
const { parseExploreQuery } = await import('@/lib/domain/explore');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { ensureSearchIndexes, searchIndexStates, SEARCH_INDEX_LOCK } = await import('@/lib/infra/search-indexes');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi(0, { delayMs: 15 });
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => fake?.close());

const REFUNDS = 'Refund policy. Refunds are issued to the original payment method within 14 days of the request. Store credit is never forced on a customer.';
const TIDES = 'Lighthouse log. The keeper records the tide tables at dawn, every day of the year, and checks the lamp before dusk.';
const QUESTION = 'When are refunds issued to the original payment method?';
/**
 * A passage for the question plus a unique word. Explore's first level
 * ranks Rees by their nearest profile vector, and other test files leave
 * dozens of public Rees whose refund passage is nearer the bare question
 * than REFUNDS plus a word would be; a passage that is mostly the question
 * itself plus the word stays first however many of those there are.
 */
const wordPassage = (word: string) => `Ledger ${word}: refunds are issued to the original payment method.`;

/* One database session of its own (a build's settings and lock hold across statements), closed after the file. */
const sessions: Client[] = [];
afterAll(() => Promise.all(sessions.map((session) => session.end().catch(() => undefined))));
async function session(): Promise<Client> {
  const client = new Client({ connectionString: TEST_DATABASE_URL! });
  await client.connect();
  sessions.push(client);
  return client;
}

async function person(role: 'normal' | 'verified' | 'official' = 'normal') {
  const subject = uniqueName('u');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  if (role !== 'normal') await db().update(schema.user).set({ role }).where(eq(schema.user.id, userId));
  return userId;
}

async function reeOf(ownerId: string, options: { name?: string; content?: string | null; isPublic?: boolean; queryFee?: number; category?: string; tags?: string[] } = {}) {
  await rees.saveDraft(ownerId, {
    ...newReeDraft(),
    name: options.name ?? uniqueName('Ree').slice(0, 40),
    description: 'A companion for testing.',
    category: options.category ?? 'business',
    tags: options.tags ?? [],
    isPublic: options.isPublic ?? true,
    queryFee: options.queryFee ?? 0,
    step: 4,
    reached: 4,
  });
  const { ree } = await rees.createReeFromDraft(ownerId);
  if (ree.isPublic) await rees.setReePublished(ownerId, ree.id, true);
  const content = options.content === undefined ? REFUNDS : options.content;
  if (content) {
    const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: `${ree.name} notes`, content });
    await knowledge.processKnowledge(id);
  }
  const [row] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
  return row!;
}

type Event = { type: string; id?: string; delta?: string; data?: Record<string, unknown> };

async function read(response: Response) {
  const raw = await response.text();
  const events = raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Event);
  const outcomes = events.filter((event) => event.type === 'data-outcome').map((event) => event.data as { reeId: string; noAnswer: boolean; reason: string | null; cost: number });
  return { events, outcomes, byRee: new Map(outcomes.map((outcome) => [outcome.reeId, outcome])), suggestions: events.find((event) => event.type === 'data-suggestions')?.data as { rees: { id: string }[] } | undefined };
}

async function ask(userId: string, conversationId: string, question: string, scope: string | null = null) {
  const conversation = (await conversations.liveConversation(userId, conversationId))!;
  const members = (await conversations.participantsOf(db(), conversationId, userId)).filter((ree) => ree.usable);
  const chosen = questionTargets(members, question, scope);
  const rows = chosen.length ? await db().select().from(schema.ree).where(inArray(schema.ree.id, chosen.map((ree) => ree.id))) : [];
  return answer({ userId, lang: 'zh', conversation, targets: chosen.map((ree) => rows.find((row) => row.id === ree.id)!), question });
}

describeWithDb('multi-Ree conversations', () => {
  it('takes five Rees and refuses the sixth, at creation and when adding', async () => {
    const userId = await person();
    const six = await Promise.all(Array.from({ length: 6 }, () => reeOf(userId, { content: null, isPublic: false })));
    await expect(conversations.createConversation(userId, { reeIds: six.map((ree) => ree.id) })).rejects.toMatchObject({ code: 'too_many_rees' });
    const conversation = await conversations.createConversation(userId, { reeIds: six.slice(0, 5).map((ree) => ree.id) });
    await expect(conversations.addParticipant(userId, conversation.id, six[5]!.id)).rejects.toMatchObject({ code: 'too_many_rees', status: 409 });
    expect(await conversations.addParticipant(userId, conversation.id, six[0]!.id)).toBe('present');
    expect(await conversations.participantsOf(db(), conversation.id, userId)).toHaveLength(5);
    /* The picker's whole-set update is all or nothing. */
    const outsider = await reeOf(await person(), { content: null, isPublic: false });
    await expect(conversations.setParticipants(userId, conversation.id, [six[5]!.id, outsider.id])).rejects.toMatchObject({ code: 'ree_unavailable' });
    expect((await conversations.participantsOf(db(), conversation.id, userId)).map((ree) => ree.id).sort()).toEqual(six.slice(0, 5).map((ree) => ree.id).sort());
    expect(await conversations.setParticipants(userId, conversation.id, [six[5]!.id, six[0]!.id])).toHaveLength(2);
    expect((await conversations.participantsOf(db(), conversation.id, userId)).map((ree) => ree.id).sort()).toEqual([six[0]!.id, six[5]!.id].sort());
  });

  it('only pulls in the user’s own Rees and public ones', async () => {
    const owner = await person();
    const asker = await person();
    const hidden = await reeOf(owner, { content: null, isPublic: false });
    await expect(conversations.createConversation(asker, { reeIds: [hidden.id] })).rejects.toMatchObject({ code: 'ree_unavailable' });
    /* Naming its id to the picker does not reveal it either. */
    expect((await conversations.pickerCandidates(asker, '', [hidden.id])).map((ree) => ree.id)).not.toContain(hidden.id);
  });

  it('answers with every participant by default, side by side, each in its own part', async () => {
    const userId = await person();
    const three = await Promise.all([reeOf(userId), reeOf(userId), reeOf(userId)]);
    const conversation = await conversations.createConversation(userId, { reeIds: three.map((ree) => ree.id) });
    const result = await read(await ask(userId, conversation.id, QUESTION));
    expect(result.outcomes.map((outcome) => outcome.noAnswer)).toEqual([false, false, false]);
    expect(new Set(result.outcomes.map((outcome) => outcome.reeId))).toEqual(new Set(three.map((ree) => ree.id)));
    /* Streamed at the same time: the text deltas of different Rees interleave rather than come one Ree after another. */
    const order = result.events.filter((event) => event.type === 'text-delta').map((event) => event.id);
    const runs = order.filter((id, at) => at === 0 || order[at - 1] !== id).length;
    expect(runs).toBeGreaterThan(3);
    const starts = result.events.filter((event) => event.type === 'text-start') as (Event & { providerMetadata?: { re0?: { reeId?: string } } })[];
    expect(starts.map((event) => event.providerMetadata?.re0?.reeId).sort()).toEqual(three.map((ree) => ree.id).sort());
    const stored = await chat.messagesOf(conversation.id);
    expect(stored.filter((row) => row.role === 'ree')).toHaveLength(3);
    expect(stored.find((row) => row.role === 'user')?.content).toBe(QUESTION);
  });

  it('@ one Ree and only it answers; "只问这个 Ree" changes nobody’s membership', async () => {
    const userId = await person();
    const a = await reeOf(userId, { name: 'Alpha Refunds' });
    const b = await reeOf(userId, { name: 'Beta Refunds' });
    const conversation = await conversations.createConversation(userId, { reeIds: [a.id, b.id] });
    const mentioned = await read(await ask(userId, conversation.id, `@Beta Refunds ${QUESTION}`));
    expect(mentioned.outcomes.map((outcome) => outcome.reeId)).toEqual([b.id]);
    const scoped = await read(await ask(userId, conversation.id, QUESTION, a.id));
    expect(scoped.outcomes.map((outcome) => outcome.reeId)).toEqual([a.id]);
    expect((await conversations.participantsOf(db(), conversation.id, userId)).map((ree) => ree.id).sort()).toEqual([a.id, b.id].sort());
    expect(questionTargets([a, b], '@Nobody here?')).toEqual([]);
  });

  it('a Ree with nothing relevant does not answer or charge; when nobody can, public Rees are suggested', async () => {
    const asker = await person();
    /* A word only this test uses, in a passage close to the question, so the many public refund Rees of other tests do not crowd the suggestions. */
    const word = `zq${Date.now().toString(36)}`;
    const expert = await reeOf(await person(), { content: wordPassage(word), isPublic: true });
    const tides = await reeOf(asker, { content: TIDES, isPublic: false });
    const empty = await reeOf(asker, { content: null, isPublic: false });
    const conversation = await conversations.createConversation(asker, { reeIds: [tides.id, empty.id] });
    const before = await balanceOf(db(), asker);
    const result = await read(await ask(asker, conversation.id, `${QUESTION} ${word}`));
    expect(result.byRee.get(tides.id)).toMatchObject({ noAnswer: true, reason: 'out_of_scope', cost: 0 });
    expect(result.byRee.get(empty.id)).toMatchObject({ noAnswer: true, reason: 'no_sources', cost: 0 });
    expect(await balanceOf(db(), asker)).toBe(before);
    expect(result.suggestions?.rees.map((ree) => ree.id)).toContain(expert.id);
    const [question] = await db().select().from(schema.message).where(and(eq(schema.message.conversationId, conversation.id), eq(schema.message.role, 'user')));
    expect(question!.suggestedReeIds).toContain(expert.id);
  });

  it('asking someone else’s Ree costs 20 + its fee, and the fee is the owner’s earned credits', async () => {
    const owner = await person();
    const asker = await person();
    const paid = await reeOf(owner, { queryFee: 30 });
    const conversation = await conversations.createConversation(asker, { reeIds: [paid.id] });
    const [askerBefore, ownerBefore] = [await balanceOf(db(), asker), await balanceOf(db(), owner)];
    const result = await read(await ask(asker, conversation.id, QUESTION));
    expect(result.byRee.get(paid.id)).toMatchObject({ noAnswer: false, cost: 50 });
    expect(await balanceOf(db(), asker)).toBe(askerBefore - 50);
    expect(await balanceOf(db(), owner)).toBe(ownerBefore + 30);
    const earned = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, owner), eq(schema.creditEntry.reason, 'query_fee_earned')));
    expect(earned).toHaveLength(1);
    expect(earned[0]).toMatchObject({ delta: 30, reeId: paid.id });
    const [grant] = await db().select().from(schema.creditGrant).where(and(eq(schema.creditGrant.userId, owner), eq(schema.creditGrant.source, 'earned')));
    expect(grant).toMatchObject({ amount: 30, remaining: 30 });
    /* Hold and settlement of each part; rows written in one millisecond have no order of their own. */
    const ledger = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, asker), eq(schema.creditEntry.reeId, paid.id)));
    expect(ledger.map((entry) => `${entry.reason}:${entry.delta}`).sort()).toEqual(['query_base:0', 'query_fee_paid:-30', 'query_fee_paid:0', 'query_hold:-20']);
  });

  it('holds every asked Ree’s maximum and refuses with 402 when that is more than the balance', async () => {
    const owner = await person();
    const asker = await person();
    const pricey = await reeOf(owner, { queryFee: 1_500 });
    const second = await reeOf(owner, { queryFee: 1_000 });
    const conversation = await conversations.createConversation(asker, { reeIds: [pricey.id, second.id] });
    await db().update(schema.creditGrant).set({ remaining: 2_000 }).where(eq(schema.creditGrant.userId, asker));
    const response = await ask(asker, conversation.id, QUESTION);
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: 'insufficient_credits', needed: 2_540 });
    expect(await chat.messagesOf(conversation.id)).toHaveLength(0);
  });

  it('a Ree turned private leaves other people’s conversations; its answers stay', async () => {
    const owner = await person();
    const asker = await person();
    const ree = await reeOf(owner);
    const theirs = await conversations.createConversation(asker, { reeIds: [ree.id] });
    const own = await conversations.createConversation(owner, { reeIds: [ree.id] });
    await read(await ask(asker, theirs.id, QUESTION));
    await rees.updateRee(owner, ree.id, { name: ree.name, description: ree.description, category: ree.category, tags: ree.tags, systemPrompt: '', sampleQuestions: [], queryFee: 0, isPublic: false, color: ree.color, avatarBlob: null });
    expect(await conversations.participantsOf(db(), theirs.id, asker)).toHaveLength(0);
    expect(await conversations.participantsOf(db(), own.id, owner)).toHaveLength(1);
    const history = await chat.messagesOf(theirs.id);
    expect(history.some((row) => row.role === 'ree' && row.reeId === ree.id && !row.noAnswer)).toBe(true);
    expect((await conversations.reeBriefs(db(), asker, [ree.id])).get(ree.id)).toMatchObject({ name: ree.name, usable: false });
    expect(await db().select().from(schema.reeProfileVector).where(eq(schema.reeProfileVector.reeId, ree.id))).toHaveLength(0);
    await expect(conversations.addParticipant(asker, theirs.id, ree.id)).rejects.toMatchObject({ code: 'ree_unavailable' });
  });

  it('a question brings an archived conversation back to Recent', async () => {
    const userId = await person();
    const ree = await reeOf(userId, { isPublic: false });
    const conversation = await conversations.createConversation(userId, { reeIds: [ree.id] });
    await conversations.runBatch(userId, 'pin', [conversation.id]);
    expect(await conversations.runBatch(userId, 'archive', [conversation.id])).toBe(1);
    const archived = (await conversations.liveConversation(userId, conversation.id))!;
    expect(archived).toMatchObject({ pinned: false });
    expect(archived.archivedAt).not.toBeNull();
    await read(await ask(userId, conversation.id, QUESTION));
    const back = (await conversations.liveConversation(userId, conversation.id))!;
    expect(back.archivedAt).toBeNull();
    expect(back.title).toBe(QUESTION);
    expect((await conversations.sidebarHistory(userId)).map((item) => item.id)).toContain(conversation.id);
  });

  it('searches titles, messages and Ree names, with tab counts, and organises in batches', async () => {
    const userId = await person();
    const ree = await reeOf(userId, { name: 'Searchable Lighthouse', content: null, isPublic: false });
    const a = await conversations.createConversation(userId, { reeIds: [ree.id], title: 'Quarterly review' });
    const b = await conversations.createConversation(userId, { title: 'Design handoff' });
    await db().insert(schema.message).values({ conversationId: b.id, role: 'user', content: 'What about the token naming?' });
    const query = (q: string, view = 'all') => parseConversationQuery(new URLSearchParams({ q, view }));
    expect((await conversations.listConversations(userId, query('quarterly'))).items.map((item) => item.id)).toEqual([a.id]);
    expect((await conversations.listConversations(userId, query('lighthouse'))).items.map((item) => item.id)).toEqual([a.id]);
    const byMessage = await conversations.listConversations(userId, query('token'));
    expect(byMessage.items.map((item) => [item.id, item.matched])).toEqual([[b.id, 'What about the token naming?']]);
    await conversations.runBatch(userId, 'trash', [b.id]);
    const counts = (await conversations.listConversations(userId, query(''))).counts;
    expect(counts).toMatchObject({ all: 1, recent: 1, trash: 1 });
    expect(await conversations.matchingConversationIds(userId, query('', 'trash'))).toEqual([b.id]);
    expect(await conversations.runBatch(userId, 'restore', [b.id])).toBe(1);
    await conversations.updateConversation(userId, a.id, { title: '重命名后的标题' });
    expect((await conversations.liveConversation(userId, a.id))!.title).toBe('重命名后的标题');
    await expect(conversations.updateConversation(userId, a.id, { title: 'x'.repeat(121) })).rejects.toMatchObject({ code: 'invalid_title' });
  });

  it('a row matched by its title or a Ree shows its latest message, or none', async () => {
    const userId = await person();
    const talked = await conversations.createConversation(userId, { title: 'Budget planning' });
    const at = Date.now();
    await db().insert(schema.message).values([
      { conversationId: talked.id, role: 'user', content: 'First question', createdAt: new Date(at - 2000) },
      { conversationId: talked.id, role: 'user', content: 'Latest question', createdAt: new Date(at - 1000) },
    ]);
    const quiet = await conversations.createConversation(userId, { title: 'Budget, nothing asked' });
    const found = await conversations.listConversations(userId, parseConversationQuery(new URLSearchParams({ q: 'budget' })));
    const byId = new Map(found.items.map((item) => [item.id, item]));
    expect(byId.get(talked.id)).toMatchObject({ matched: null, latest: 'Latest question' });
    expect(byId.get(quiet.id)).toMatchObject({ matched: null, latest: null });
    const byText = await conversations.listConversations(userId, parseConversationQuery(new URLSearchParams({ q: 'first' })));
    expect(byText.items.map((item) => [item.id, item.matched])).toEqual([[talked.id, 'First question']]);
  });

  it('previews the last eight messages of a trashed conversation, to its owner only', async () => {
    const userId = await person();
    const other = await person();
    const ree = await reeOf(userId, { name: 'Preview Ree', content: null, isPublic: false });
    const conversation = await conversations.createConversation(userId, { reeIds: [ree.id], title: 'Old talk' });
    const at = Date.now();
    await db()
      .insert(schema.message)
      .values(
        Array.from({ length: 10 }, (_, index) => ({
          conversationId: conversation.id,
          role: index % 2 ? ('ree' as const) : ('user' as const),
          reeId: index % 2 ? ree.id : null,
          content: `message ${index}`,
          createdAt: new Date(at - (10 - index) * 1000),
        })),
      );
    expect(await conversations.trashedPreview(userId, conversation.id)).toBeNull();
    await conversations.runBatch(userId, 'trash', [conversation.id]);
    const preview = (await conversations.trashedPreview(userId, conversation.id))!;
    expect(preview.title).toBe('Old talk');
    expect(preview.messages.map((message) => message.content)).toEqual(Array.from({ length: 8 }, (_, index) => `message ${index + 2}`));
    expect(preview.messages[0]).toMatchObject({ role: 'user', reeName: null });
    expect(preview.messages[1]).toMatchObject({ role: 'ree', reeName: 'Preview Ree' });
    expect(await conversations.trashedPreview(other, conversation.id)).toBeNull();
    expect(await conversations.trashedPreview(userId, 'not-a-uuid')).toBeNull();
  });

  it('finds the tab and page that hold a conversation for "选择此对话"', async () => {
    const userId = await person();
    const oldest = await conversations.createConversation(userId, { title: 'one' });
    const middle = await conversations.createConversation(userId, { title: 'two' });
    const newest = await conversations.createConversation(userId, { title: 'three' });
    const at = Date.now();
    for (const [index, row] of [oldest, middle, newest].entries()) await db().update(schema.conversation).set({ updatedAt: new Date(at - (3 - index) * 60_000) }).where(eq(schema.conversation.id, row.id));
    await conversations.createConversation(await person(), { title: 'someone else' });
    expect(await conversations.conversationPosition(userId, newest.id, 1)).toEqual({ view: 'all', page: 1 });
    expect(await conversations.conversationPosition(userId, oldest.id, 1)).toEqual({ view: 'all', page: 3 });
    expect(await conversations.conversationPosition(userId, oldest.id, 20)).toEqual({ view: 'all', page: 1 });
    await conversations.runBatch(userId, 'archive', [middle.id]);
    expect(await conversations.conversationPosition(userId, middle.id, 1)).toEqual({ view: 'archived', page: 1 });
    await conversations.runBatch(userId, 'trash', [newest.id]);
    expect(await conversations.conversationPosition(userId, newest.id, 1)).toBeNull();
    /* 全部 still counts the archived one before it; the trashed one no longer. */
    expect(await conversations.conversationPosition(userId, oldest.id, 1)).toEqual({ view: 'all', page: 2 });
  });

  it('immediately deletes trashed conversations with their messages, feedback and participants', async () => {
    const userId = await person();
    const ree = await reeOf(userId, { content: null, isPublic: false });
    const conversation = await conversations.createConversation(userId, { reeIds: [ree.id], title: 'Delete now' });
    const empty = await conversations.createConversation(userId, { title: 'Empty chat' });
    const [message] = await db().insert(schema.message).values({ conversationId: conversation.id, role: 'ree', reeId: ree.id, content: 'Remove this answer' }).returning();
    await conversations.setFeedback(userId, message!.id, 'up');
    await conversations.runBatch(userId, 'trash', [conversation.id, empty.id]);

    expect(await conversations.runBatch(userId, 'delete', [conversation.id, empty.id, conversation.id])).toBe(2);
    expect(await conversations.liveConversation(userId, conversation.id, { trashed: true })).toBeNull();
    expect(await conversations.liveConversation(userId, empty.id, { trashed: true })).toBeNull();
    expect(await chat.messagesOf(conversation.id)).toHaveLength(0);
    expect(await db().select().from(schema.conversationRee).where(eq(schema.conversationRee.conversationId, conversation.id))).toHaveLength(0);
    expect(await db().select().from(schema.reeFeedback).where(eq(schema.reeFeedback.messageId, message!.id))).toHaveLength(0);
    expect(await conversations.runBatch(userId, 'restore', [conversation.id])).toBe(0);
    expect(await conversations.runBatch(userId, 'delete', [conversation.id])).toBe(0);
  });

  it('restricts immediate deletion to the caller’s trash, including mixed and restored selections', async () => {
    const userId = await person();
    const other = await person();
    const trashed = await conversations.createConversation(userId, {});
    const live = await conversations.createConversation(userId, {});
    const archived = await conversations.createConversation(userId, {});
    const restored = await conversations.createConversation(userId, {});
    const foreign = await conversations.createConversation(other, {});
    const ree = await reeOf(userId, { content: null, isPublic: false });
    const [testChat] = await db().insert(schema.conversation).values({ userId, kind: 'ree_test', reeId: ree.id, deletedAt: new Date() }).returning();
    await conversations.runBatch(userId, 'trash', [trashed.id, restored.id]);
    await conversations.runBatch(userId, 'restore', [restored.id]);
    await conversations.runBatch(userId, 'archive', [archived.id]);
    await conversations.runBatch(other, 'trash', [foreign.id]);

    expect(await conversations.runBatch(userId, 'delete', [trashed.id, live.id, archived.id, restored.id, foreign.id, testChat!.id])).toBe(1);
    const kept = await db().select({ id: schema.conversation.id }).from(schema.conversation).where(inArray(schema.conversation.id, [live.id, archived.id, restored.id, foreign.id, testChat!.id]));
    expect(kept).toHaveLength(5);
    expect(await conversations.runBatch(userId, 'delete', [])).toBe(0);
    expect(await conversations.runBatch(userId, 'delete', ['invalid-id'])).toBe(0);
  });

  it('empties the trash after 30 days, messages included', async () => {
    const userId = await person();
    const conversation = await conversations.createConversation(userId, {});
    await db().insert(schema.message).values({ conversationId: conversation.id, role: 'user', content: 'gone soon' });
    await conversations.runBatch(userId, 'trash', [conversation.id]);
    await conversations.purgeConversationTrash(new Date(Date.now() + 29 * 86_400_000));
    expect(await conversations.liveConversation(userId, conversation.id, { trashed: true })).not.toBeNull();
    await conversations.purgeConversationTrash(new Date(Date.now() + 31 * 86_400_000));
    expect(await conversations.liveConversation(userId, conversation.id, { trashed: true })).toBeNull();
    expect(await chat.messagesOf(conversation.id)).toHaveLength(0);
  });

  it('records one vote per asker on an answer, and takes it back', async () => {
    const owner = await person();
    const asker = await person();
    const ree = await reeOf(owner);
    const conversation = await conversations.createConversation(asker, { reeIds: [ree.id] });
    await read(await ask(asker, conversation.id, QUESTION));
    const [reply] = await db().select().from(schema.message).where(and(eq(schema.message.conversationId, conversation.id), eq(schema.message.role, 'ree')));
    expect(await conversations.setFeedback(asker, reply!.id, 'up')).toBe('up');
    expect(await conversations.setFeedback(asker, reply!.id, 'down')).toBe('down');
    expect(await db().select().from(schema.reeFeedback).where(eq(schema.reeFeedback.messageId, reply!.id))).toHaveLength(1);
    await expect(conversations.setFeedback(owner, reply!.id, 'up')).rejects.toMatchObject({ code: 'not_found' });
    const page = await publicReeBySlug(ree.slug);
    expect(page).toMatchObject({ answers: 1, positiveRate: 0 });
    expect(await conversations.setFeedback(asker, reply!.id, null)).toBeNull();
    expect((await publicReeBySlug(ree.slug))!.positiveRate).toBeNull();
  });
});

describeWithDb('explore and public pages', () => {
  it('finds Rees by a matched passage, the excerpt taken from it, and ranks a tie by role', async () => {
    const word = `zx${Date.now().toString(36)}`;
    const content = wordPassage(word);
    const normal = await reeOf(await person(), { content });
    const official = await reeOf(await person('official'), { content });
    const tides = await reeOf(await person(), { content: TIDES });
    const privateOne = await reeOf(await person(), { content, isPublic: false });
    expect(await db().select().from(schema.reeProfileVector).where(eq(schema.reeProfileVector.reeId, official.id))).not.toHaveLength(0);
    const result = await explore.explore(parseExploreQuery(new URLSearchParams({ q: `${QUESTION} ${word}` })), { cursor: null, size: 24 });
    expect(result.nextCursor).toBeNull();
    expect(result.mode).toBe('search');
    expect(result.items.length).toBeLessThanOrEqual(10);
    const ids = result.items.map((card) => card.id);
    expect(ids).toContain(official.id);
    expect(ids).toContain(normal.id);
    expect(ids).not.toContain(tides.id);
    expect(ids).not.toContain(privateOne.id);
    /* Same passages, same relevance: the official owner's Ree comes first, and both lead the Rees without the word. */
    expect(ids.slice(0, 2)).toEqual([official.id, normal.id]);
    for (const card of result.items) {
      const passages = await db().select({ content: schema.chunk.content }).from(schema.chunk).where(eq(schema.chunk.reeId, card.id));
      const excerpt = card.excerpt!.replace(/^…|…$/g, '');
      expect(passages.some((passage) => passage.content.replace(/\s+/g, ' ').includes(excerpt))).toBe(true);
    }
    expect(result.items.find((card) => card.id === official.id)).toMatchObject({ role: 'official', price: 20, sources: 1 });
  });

  it('without a question lists the most active public Rees, by the hourly rank', async () => {
    const owner = await person();
    const busy = await reeOf(owner, { category: 'life' });
    const quiet = await reeOf(owner, { category: 'life' });
    const asker = await person();
    const conversation = await conversations.createConversation(asker, { reeIds: [busy.id] });
    await read(await ask(asker, conversation.id, QUESTION));
    await computeRanks();
    const [ranked] = await db().select({ rank: schema.ree.rank }).from(schema.ree).where(eq(schema.ree.id, busy.id));
    expect(ranked!.rank).toMatchObject({ asked30: 1, answered30: 1, pulls30: 1, activity30: 2, answersAll: 1 });
    const browse = await explore.explore(parseExploreQuery(new URLSearchParams({ category: 'life' })), { cursor: null, size: 96 });
    expect(browse.mode).toBe('browse');
    const ids = browse.items.map((card) => card.id);
    expect(ids.indexOf(busy.id)).toBeLessThan(ids.indexOf(quiet.id));
    expect(browse.items.every((card) => card.category === 'life')).toBe(true);

    /* "回答最多" orders by the hourly count, not by aggregating every message per request. */
    const byAnswers = async () => (await explore.explore(parseExploreQuery(new URLSearchParams({ category: 'life', sort: 'answers' })), { cursor: null, size: 96 })).items.map((card) => card.id);
    const answered = await byAnswers();
    expect(answered.indexOf(busy.id)).toBeLessThan(answered.indexOf(quiet.id));
    await db().update(schema.ree).set({ rank: { answersAll: 1_000_000 } }).where(eq(schema.ree.id, quiet.id));
    const reordered = await byAnswers();
    expect(reordered.indexOf(quiet.id)).toBeLessThan(reordered.indexOf(busy.id));
  });

  it('loads the list in batches after the last key: every public Ree once, in every order', async () => {
    const owner = await person();
    const made = [];
    for (let at = 0; at < 5; at += 1) made.push(await reeOf(owner, { category: 'learning' }));
    /* Same activity, same role, the same creation time to the microsecond: only the id tells them apart. */
    await db().update(schema.ree).set({ createdAt: made[0]!.createdAt }).where(inArray(schema.ree.id, made.map((ree) => ree.id)));
    for (const sort of ['active', 'answers', 'free'] as const) {
      const query = parseExploreQuery(new URLSearchParams({ category: 'learning', sort }));
      const seen: string[] = [];
      let cursor: string | null = null;
      let total = 0;
      do {
        /* Batches of two, so a list of five or more crosses the cursor at least twice, ties included. */
        const batch: Awaited<ReturnType<typeof explore.explore>> = await explore.explore(query, { cursor, size: 2 }, { includeIntros: false });
        total = batch.total;
        seen.push(...batch.items.map((card) => card.id));
        if (batch.nextCursor) expect(batch.items).toHaveLength(2);
        cursor = batch.nextCursor;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(total);
      for (const ree of made) expect(seen).toContain(ree.id);
    }
    const tiny = parseExploreQuery(new URLSearchParams({ category: 'learning' }));
    const first = await explore.explore(tiny, { cursor: null, size: 2 }, { includeIntros: false });
    const second = await explore.explore(tiny, { cursor: first.nextCursor, size: 2 }, { includeIntros: false });
    expect(first.nextCursor).not.toBeNull();
    expect(second.items.map((card) => card.id)).not.toContain(first.items[0]!.id);
    expect(second.items.map((card) => card.id)).not.toContain(first.items[1]!.id);
    await expect(explore.explore(tiny, { cursor: 'bogus', size: 2 }, { includeIntros: false })).rejects.toBeInstanceOf(explore.ExploreCursorError);
    const searched = await explore.explore({ ...tiny, q: QUESTION }, { cursor: first.nextCursor, size: 24 }, { includeIntros: false });
    expect(searched).toMatchObject({ mode: 'search', items: [], nextCursor: null });
  });

  it('puts pinned Rees first under the default order only, in pin order, across batches', async () => {
    const owner = await person();
    const plain = [];
    for (let at = 0; at < 3; at += 1) plain.push(await reeOf(owner, { category: 'professional' }));
    const second = await reeOf(owner, { category: 'professional', queryFee: 50 });
    const first = await reeOf(owner, { category: 'professional', queryFee: 50 });
    const waiting = await reeOf(owner, { category: 'professional' });
    const pin = (id: string, order: number | null) => db().update(schema.ree).set({ pinOrder: order }).where(eq(schema.ree.id, id));
    try {
      await pin(second.id, 2);
      await pin(first.id, 1);
      /* Pinned but unpublished: discovery's own filter keeps it out. */
      await pin(waiting.id, 3);
      await db().update(schema.ree).set({ isPublished: false }).where(eq(schema.ree.id, waiting.id));
      /* The most active of all, yet unpinned: it follows the pins under "推荐优先" and leads "回答最多". */
      await db().update(schema.ree).set({ rank: { activity30: 1_000_000, answersAll: 1_000_000 } }).where(eq(schema.ree.id, plain[0]!.id));

      const walk = async (sort: 'active' | 'answers' | 'free') => {
        const query = parseExploreQuery(new URLSearchParams({ category: 'professional', sort }));
        const ids: string[] = [];
        const pinned: string[] = [];
        let cursor: string | null = null;
        do {
          /* One card a batch, so a cursor sits on each pinned Ree and on the first one after them. */
          const batch: Awaited<ReturnType<typeof explore.explore>> = await explore.explore(query, { cursor, size: 1 }, { includeIntros: false });
          ids.push(...batch.items.map((card) => card.id));
          pinned.push(...batch.items.filter((card) => card.pinned).map((card) => card.id));
          cursor = batch.nextCursor;
        } while (cursor);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).not.toContain(waiting.id);
        return { ids, pinned };
      };
      const active = await walk('active');
      expect(active.ids.slice(0, 3)).toEqual([first.id, second.id, plain[0]!.id]);
      expect(active.pinned).toEqual([first.id, second.id]);
      const answers = await walk('answers');
      expect(answers.ids[0]).toBe(plain[0]!.id);
      const free = await walk('free');
      expect(free.ids.indexOf(first.id)).toBeGreaterThan(free.ids.indexOf(plain[1]!.id));
      expect(free.ids.indexOf(second.id)).toBeGreaterThan(free.ids.indexOf(plain[2]!.id));

      /* The home page: every pinned Ree before every unpinned one, in pin order. */
      const home = await explore.activeRees(500);
      const lastPinned = home.map((card) => card.pinned).lastIndexOf(true);
      expect(home.slice(0, lastPinned + 1).every((card) => card.pinned)).toBe(true);
      expect(home.findIndex((card) => card.id === first.id)).toBeLessThan(home.findIndex((card) => card.id === second.id));
      expect(home.map((card) => card.id)).not.toContain(waiting.id);
    } finally {
      for (const ree of [first, second, waiting]) await pin(ree.id, null);
    }
  });

  it('puts the Ree a query names first, by its name or tag, without changing how a question ranks', async () => {
    const product = `zq${Date.now().toString(36)}`;
    const owner = await person();
    /* Named after the product but nothing in its knowledge mentions it. */
    const named = await reeOf(owner, { name: `${product}.js Docs Assistant`, content: TIDES });
    /* Knowledge full of the product's name, under another name. */
    const mentions = await reeOf(owner, { content: `${product}js ${product}js setup. ${wordPassage(`${product}js`)}` });
    const tagged = await reeOf(owner, { content: TIDES, tags: [`${product}.js`] });
    const hidden = await reeOf(owner, { name: `${product}.js Private Notes`, content: TIDES, isPublic: false });
    for (const q of [`${product}js`, `${product}.js`, `${product} js`, `${product.toUpperCase()}.JS`]) {
      const result = await explore.explore(parseExploreQuery(new URLSearchParams({ q })), { cursor: null, size: 24 }, { includeIntros: false });
      const ids = result.items.map((card) => card.id);
      expect(ids[0], q).toBe(named.id);
      /* Only the spelling its knowledge uses finds the Ree that merely mentions the product. */
      if (q === `${product}js`) expect(ids, q).toContain(mentions.id);
      expect(ids.indexOf(tagged.id), q).toBeGreaterThan(0);
      expect(ids, q).not.toContain(hidden.id);
      /* The excerpt still comes from the named Ree's own knowledge. */
      expect(result.items[0]!.excerpt).toContain('Lighthouse');
    }
    /* A question that does not name it ranks by passages as before: the named Ree has none about refunds. */
    const question = await explore.explore(parseExploreQuery(new URLSearchParams({ q: `${QUESTION} ${product}js` })), { cursor: null, size: 24 }, { includeIntros: false });
    const ids = question.items.map((card) => card.id);
    expect(ids).toContain(mentions.id);
    expect(ids.indexOf(mentions.id)).toBeLessThan(ids.indexOf(named.id) === -1 ? Infinity : ids.indexOf(named.id));
  });

  it('finds the nearest passages through each slot\'s HNSW index, as an exact scan would', async () => {
    await ensureSearchIndexes(await session(), { budgetMs: 60_000 });
    await reeOf(await person(), { content: wordPassage(uniqueName('w')) });
    const vector = await chat.embedQuestion(QUESTION);
    const all = await db().select({ id: schema.ree.id }).from(schema.ree).where(explore.publicRee());
    const search = explore.passageSearch(vector, all.map((row) => row.id), 5);
    const run = (statement: ReturnType<typeof sql>, indexed: boolean) =>
      db().transaction(async (tx) => {
        if (indexed) await tx.execute(search.settings);
        return (await tx.execute<Record<string, unknown>>(statement)).rows;
      });
    /* The same five similarities (tied passages may differ, their scores do not), recomputed on the stored vectors. */
    const top = (rows: Record<string, unknown>[]) => rows.map((row) => Number(row.similarity)).sort((x, y) => y - x).slice(0, 5).map((value) => value.toFixed(5));
    const exact = await run(search.exact, false);
    expect(exact).toHaveLength(5);
    expect(top(await run(search.indexed, true))).toEqual(top(exact));
    /* Whatever the table's size, the plan walks the indexes instead of sorting every candidate passage. */
    const plan = (await run(sql`explain ${search.indexed}`, true)).map((row) => String(Object.values(row)[0])).join('\n');
    expect(plan).toContain('chunk_embedding_half_idx');
    expect(plan).toContain('chunk_embedding_next_half_idx');
  });

  it('searches exactly while the passage indexes are missing or invalid, and builds them concurrently once', async () => {
    const client = await session();
    const word = uniqueName('w');
    const ree = await reeOf(await person(), { content: wordPassage(word) });
    const found = async () => {
      explore.forgetSearchIndexCheck();
      const result = await explore.explore(parseExploreQuery(new URLSearchParams({ q: `${QUESTION} ${word}` })), { cursor: null, size: 24 }, { includeIntros: false });
      return result.items.map((card) => card.id);
    };
    const states = async () => [...(await searchIndexStates(client)).values()];

    /* As production is after the migration and before the build. */
    await client.query('drop index if exists chunk_embedding_half_idx; drop index if exists chunk_embedding_next_half_idx');
    expect(await states()).toEqual(['missing', 'missing']);
    explore.forgetSearchIndexCheck();
    expect(await explore.searchIndexesReady()).toBe(false);
    expect(await found()).toContain(ree.id);

    expect((await ensureSearchIndexes(client, { budgetMs: 60_000 })).map((outcome) => outcome.action)).toEqual(['built', 'built']);
    expect(await states()).toEqual(['valid', 'valid']);
    explore.forgetSearchIndexCheck();
    expect(await explore.searchIndexesReady()).toBe(true);
    expect(await found()).toContain(ree.id);
    /* Every deploy runs it again: nothing to do. */
    expect((await ensureSearchIndexes(client, { budgetMs: 60_000 })).map((outcome) => outcome.action)).toEqual(['valid', 'valid']);

    /* What an interrupted concurrent build leaves: an index the planner may not use. */
    await client.query(`update pg_index set indisvalid = false where indexrelid = 'chunk_embedding_half_idx'::regclass`);
    expect(await states()).toEqual(['invalid', 'valid']);
    explore.forgetSearchIndexCheck();
    expect(await explore.searchIndexesReady()).toBe(false);
    expect(await found()).toContain(ree.id);
    expect((await ensureSearchIndexes(client, { budgetMs: 60_000 })).map((outcome) => outcome.action)).toEqual(['rebuilt', 'valid']);
    expect(await states()).toEqual(['valid', 'valid']);
  });

  it('leaves the passage indexes to a build already running, and drops what a build out of time leaves', async () => {
    const client = await session();
    const other = await session();
    const states = async () => [...(await searchIndexStates(client)).values()];
    await ensureSearchIndexes(client, { budgetMs: 60_000 });
    await client.query('drop index chunk_embedding_next_half_idx');

    await other.query('select pg_advisory_lock(hashtext($1))', [SEARCH_INDEX_LOCK]);
    expect((await ensureSearchIndexes(client, { budgetMs: 60_000 })).map((outcome) => outcome.action)).toEqual(['skipped', 'skipped']);
    expect(await states()).toEqual(['valid', 'missing']);
    await other.query('select pg_advisory_unlock(hashtext($1))', [SEARCH_INDEX_LOCK]);

    /* An older snapshot (another table's, so no lock on chunk) makes the concurrent build wait past its budget. */
    await other.query('begin isolation level repeatable read');
    await other.query('select count(*) from ree');
    try {
      const cut = await ensureSearchIndexes(client, { budgetMs: 2_000 });
      expect(cut.map((outcome) => outcome.action)).toEqual(['valid', 'failed']);
      expect(cut[1]!.detail).toMatch(/statement timeout/);
      /* Its half-built index is gone, not left for every write to maintain. */
      expect(await states()).toEqual(['valid', 'missing']);
    } finally {
      await other.query('rollback');
    }
    expect((await ensureSearchIndexes(client, { budgetMs: 60_000 })).map((outcome) => outcome.action)).toEqual(['valid', 'built']);
  });

  it('embeds a search question once and reuses its vector for the same words', async () => {
    const q = `${uniqueName('tide')} lighthouse keeper`;
    const embedded = () => fake.requests.filter((request) => request.inputs?.includes(q)).length;
    const before = embedded();
    for (let round = 0; round < 3; round += 1) await explore.explore(parseExploreQuery(new URLSearchParams({ q })), { cursor: null, size: 24 }, { includeIntros: false });
    expect(embedded() - before).toBe(1);
  });

  it('counts free searches per IP and per account', async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
    const now = new Date();
    for (let at = 0; at < 30; at += 1) expect(await explore.allowSearch({ ip, userId: null }, now)).toBe(true);
    expect(await explore.allowSearch({ ip, userId: null }, now)).toBe(false);
    expect(await explore.allowSearch({ ip, userId: null }, new Date(now.getTime() + 61_000))).toBe(true);
  });

  it('shows only public Rees on their page, with related ones from public fields', async () => {
    const owner = await person('verified');
    const ree = await reeOf(owner, { category: 'design', tags: ['tokens'] });
    const sibling = await reeOf(await person(), { category: 'design', tags: ['tokens'] });
    const page = await publicReeBySlug(ree.slug);
    expect(page).toMatchObject({ role: 'verified', sources: 1, price: 20 });
    expect((await relatedFor(page!, 1)).items.map((card) => card.id)).toContain(sibling.id);
    const hidden = await reeOf(owner, { isPublic: false });
    expect(await publicReeBySlug(hidden.slug)).toBeNull();
  });

  it('suggests three example questions after the first source, kept apart until adopted', async () => {
    const owner = await person();
    const ree = await reeOf(owner, { isPublic: false });
    expect(ree.sampleQuestions).toEqual([]);
    expect(ree.suggestedQuestions).toHaveLength(3);
  });
});

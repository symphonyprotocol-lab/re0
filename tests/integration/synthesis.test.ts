/**
 * Ree 圆桌 (ree-council-proposal.md 4): a question two or more Rees answered
 * can be synthesized once. The fee is held when asked, settled to the
 * platform when the synthesis lands -- no owner earns from it -- and given
 * back when the model fails or leaves nothing; then it may be tried again.
 * Markers that name no Ree or citation are removed and the rest mapped
 * to the stored snapshots; the synthesis is not a message, so no Ree sees
 * it and no answer count moves. Too few credits is a 402; a second try 409.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf, placeHold } = await import('@/lib/services/credits');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const chat = await import('@/lib/services/chat');
const conversations = await import('@/lib/services/conversations');
const { answer } = await import('@/lib/services/answer');
const { synthesize, synthesesFor, setSynthesisFeedback } = await import('@/lib/services/synthesis');
const { answerCounts } = await import('@/lib/services/statistics');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { SYNTHESIS_FEE, SYNTHESIS_STALE_MS } = await import('@/lib/constants');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => fake?.close());

/* Not the refund passage other files search explore for: public Rees made here would crowd their results. */
const WARRANTY = 'Warranty policy. Warranty repairs are finished within 10 working days of the drop-off. A loan unit is offered while the repair is open.';
const TIDES = 'Lighthouse log. The keeper records the tide tables at dawn, every day of the year, and checks the lamp before dusk.';
const QUESTION = 'How many working days do warranty repairs take?';

async function person() {
  const subject = uniqueName('rt');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  return userId;
}

async function reeOf(ownerId: string, options: { content?: string; isPublic?: boolean; queryFee?: number } = {}) {
  await rees.saveDraft(ownerId, {
    ...newReeDraft(),
    name: uniqueName('Ree').slice(0, 40),
    description: 'A companion for testing.',
    category: 'business',
    isPublic: options.isPublic ?? false,
    queryFee: options.queryFee ?? 0,
    step: 4,
    reached: 4,
  });
  const { ree } = await rees.createReeFromDraft(ownerId);
  if (ree.isPublic) await rees.setReePublished(ownerId, ree.id, true);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: `${ree.name} notes`, content: options.content ?? WARRANTY });
  await knowledge.processKnowledge(id);
  const [row] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
  return row!;
}

type Event = { type: string; delta?: string; data?: Record<string, unknown> };
type Part = { synthesisId: string | null; requestId: string; state: string; content: string; reeIds: string[]; sources: { marker: string; reeId: string; messageId: string; index: number | null; citation: { index: number } | null }[]; cost: number };

async function events(response: Response): Promise<Event[]> {
  return (await response.text())
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Event);
}

function parts(list: Event[]): Part[] {
  return list.filter((event) => event.type === 'data-synthesis').map((event) => event.data as unknown as Part);
}

/** A conversation where someone else's paid Ree and the asker's own Ree both answer, and one off-topic Ree does not. */
async function answeredTwice(question = QUESTION) {
  const asker = await person();
  const owner = await person();
  const paid = await reeOf(owner, { isPublic: true, queryFee: 30 });
  const own = await reeOf(asker);
  const tides = await reeOf(asker, { content: TIDES });
  const created = await conversations.createConversation(asker, { reeIds: [paid.id, own.id, tides.id] });
  const conversation = (await conversations.liveConversation(asker, created.id))!;
  await (await answer({ userId: asker, lang: 'zh', conversation, targets: [paid, own, tides], question })).text();
  const [asked] = await db().select().from(schema.message).where(and(eq(schema.message.conversationId, conversation.id), eq(schema.message.role, 'user')));
  return { asker, owner, paid, own, tides, conversation, requestId: asked!.id };
}

async function synthesisLedger(userId: string) {
  const rows = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, userId), inArray(schema.creditEntry.reason, ['synthesis_hold', 'synthesis_settle', 'synthesis_refund']))).orderBy(asc(schema.creditEntry.createdAt));
  return rows.map((row) => [row.reason, row.delta, row.reeId]);
}

describeWithDb('Ree 圆桌 synthesis', () => {
  it('streams a synthesis, keeps only real markers and charges the platform once', async () => {
    const { asker, owner, paid, own, conversation, requestId } = await answeredTwice();
    const before = await balanceOf(db(), asker);
    const ownerBefore = await balanceOf(db(), owner);
    const answersBefore = await answerCounts([paid.id, own.id], null);
    const replies = await db().select().from(schema.message).where(and(eq(schema.message.requestId, requestId), eq(schema.message.noAnswer, false))).orderBy(asc(schema.message.createdAt));
    expect(replies).toHaveLength(2);

    const list = await events(await synthesize({ userId: asker, lang: 'zh', conversation, requestId }));
    const states = parts(list);
    /* Who is A and B comes first, then the text, then the checked result. */
    expect(states.map((part) => part.state)).toEqual(['streaming', 'done']);
    expect(list.findIndex((event) => event.type === 'data-synthesis')).toBeLessThan(list.findIndex((event) => event.type === 'text-delta'));
    const done = states[1]!;
    expect(done.reeIds).toEqual(replies.map((row) => row.reeId));
    expect(done.content).toBe(
      '## 结论\n- Refunds go back to the original payment method within 14 days [A1][B1].\n## 共识\n- Both name the same window [A1][B1].\n## 分歧\n- None noted.\n## 没覆盖到\n- Store credit is not covered [B].',
    );
    expect(done.sources.map((source) => [source.marker, source.messageId, source.citation?.index ?? null])).toEqual([
      ['A1', replies[0]!.id, 1],
      ['B1', replies[1]!.id, 1],
      ['B', replies[1]!.id, null],
    ]);
    expect(done.cost).toBe(SYNTHESIS_FEE);

    expect(await balanceOf(db(), asker)).toBe(before - SYNTHESIS_FEE);
    expect(await balanceOf(db(), owner)).toBe(ownerBefore);
    expect(await synthesisLedger(asker)).toEqual([
      ['synthesis_hold', -SYNTHESIS_FEE, null],
      ['synthesis_settle', 0, null],
    ]);
    const [row] = await db().select().from(schema.synthesis).where(eq(schema.synthesis.requestId, requestId));
    expect(row).toMatchObject({ status: 'done', costCredits: SYNTHESIS_FEE, model: 'fake-gen-1', userId: asker, content: done.content });
    const calls = await db().select().from(schema.modelCall).where(and(eq(schema.modelCall.userId, asker), eq(schema.modelCall.purpose, 'synthesis')));
    expect(calls).toHaveLength(1);

    /* Not a message: answer counts and every Ree's history are untouched. */
    expect(await answerCounts([paid.id, own.id], null)).toEqual(answersBefore);
    const rows = await chat.messagesOf(conversation.id);
    expect(rows.filter((message) => message.role === 'ree')).toHaveLength(3);
    expect(chat.turnsOf(rows, paid.id).map((turn) => turn.content).join('\n')).not.toContain('结论');

    /* Reloaded, it sits with its question. */
    const syntheses = await synthesesFor(asker, conversation.id);
    const ui = chat.toUIMessages(rows, { syntheses });
    expect(ui[1]!.parts.find((part) => part.type === 'data-synthesis')).toMatchObject({ data: { state: 'done', content: done.content, synthesisId: row!.id, vote: null } });
  });

  it('allows one synthesis per question', async () => {
    const { asker, conversation, requestId } = await answeredTwice();
    await events(await synthesize({ userId: asker, lang: 'zh', conversation, requestId }));
    const again = await synthesize({ userId: asker, lang: 'zh', conversation, requestId });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'already_synthesized' });
    expect((await synthesisLedger(asker)).map(([reason]) => reason)).toEqual(['synthesis_hold', 'synthesis_settle']);
  });

  it('refuses a question with fewer than two answers, or from another conversation', async () => {
    const asker = await person();
    const ree = await reeOf(asker);
    const created = await conversations.createConversation(asker, { reeIds: [ree.id] });
    const conversation = (await conversations.liveConversation(asker, created.id))!;
    await (await answer({ userId: asker, lang: 'zh', conversation, targets: [ree], question: QUESTION })).text();
    const [asked] = await db().select().from(schema.message).where(and(eq(schema.message.conversationId, conversation.id), eq(schema.message.role, 'user')));
    const one = await synthesize({ userId: asker, lang: 'zh', conversation, requestId: asked!.id });
    expect(one.status).toBe(422);
    expect(await one.json()).toMatchObject({ error: 'not_enough_answers' });

    const other = await answeredTwice();
    const elsewhere = await synthesize({ userId: asker, lang: 'zh', conversation, requestId: other.requestId });
    expect(elsewhere.status).toBe(404);
    expect(await synthesisLedger(asker)).toEqual([]);
  });

  it('answers 402 and keeps nothing when the fee cannot be held', async () => {
    const { asker, conversation, requestId } = await answeredTwice();
    await db().update(schema.creditGrant).set({ remaining: 0 }).where(eq(schema.creditGrant.userId, asker));
    const [grant] = await db().select().from(schema.creditGrant).where(eq(schema.creditGrant.userId, asker)).limit(1);
    await db().update(schema.creditGrant).set({ remaining: SYNTHESIS_FEE - 1 }).where(eq(schema.creditGrant.id, grant!.id));
    const refused = await synthesize({ userId: asker, lang: 'zh', conversation, requestId });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: 'insufficient_credits', balance: SYNTHESIS_FEE - 1, needed: SYNTHESIS_FEE });
    expect(await db().select().from(schema.synthesis).where(eq(schema.synthesis.requestId, requestId))).toEqual([]);
    expect(await synthesisLedger(asker)).toEqual([]);
  });

  it('gives the fee back when the model fails, and can be tried again', async () => {
    const { asker, conversation, requestId } = await answeredTwice();
    const before = await balanceOf(db(), asker);
    fake.synthesis.fail = true;
    try {
      const states = parts(await events(await synthesize({ userId: asker, lang: 'zh', conversation, requestId })));
      expect(states.map((part) => part.state)).toEqual(['streaming', 'failed']);
    } finally {
      fake.synthesis.fail = false;
    }
    expect(await balanceOf(db(), asker)).toBe(before);
    expect((await synthesisLedger(asker)).map(([reason, delta]) => [reason, delta])).toEqual([
      ['synthesis_hold', -SYNTHESIS_FEE],
      ['synthesis_refund', SYNTHESIS_FEE],
    ]);
    expect(await db().select().from(schema.synthesis).where(eq(schema.synthesis.requestId, requestId))).toEqual([]);

    const retried = parts(await events(await synthesize({ userId: asker, lang: 'zh', conversation, requestId })));
    expect(retried.at(-1)!.state).toBe('done');
    expect(await balanceOf(db(), asker)).toBe(before - SYNTHESIS_FEE);
  });

  it('gives the fee back when nothing is left once the markers are checked', async () => {
    const { asker, conversation, requestId } = await answeredTwice(`${QUESTION} SYNTH_EMPTY`);
    const before = await balanceOf(db(), asker);
    const states = parts(await events(await synthesize({ userId: asker, lang: 'zh', conversation, requestId })));
    expect(states.at(-1)).toMatchObject({ state: 'failed', cost: 0 });
    expect(await balanceOf(db(), asker)).toBe(before);
    expect(await db().select().from(schema.synthesis).where(eq(schema.synthesis.requestId, requestId))).toEqual([]);
  });

  it('replaces a running synthesis that died long ago, giving its fee back, but not a live one', async () => {
    const { asker, conversation, requestId } = await answeredTwice();
    const before = await balanceOf(db(), asker);
    /* A synthesis whose function was cut off mid-stream: its row and its hold, never closed. */
    await db().transaction(async (tx) => {
      const [row] = await tx.insert(schema.synthesis).values({ conversationId: conversation.id, requestId, userId: asker }).returning({ id: schema.synthesis.id });
      await placeHold(tx, { userId: asker, kind: 'chat', ledger: 'chat_synthesis', amount: SYNTHESIS_FEE, refId: row!.id, note: 'synthesis' });
    });
    const live = await synthesize({ userId: asker, lang: 'zh', conversation, requestId });
    expect(live.status).toBe(409);
    expect(await live.json()).toMatchObject({ error: 'synthesis_running' });
    await db().update(schema.synthesis).set({ createdAt: new Date(Date.now() - SYNTHESIS_STALE_MS - 1000) }).where(eq(schema.synthesis.requestId, requestId));
    expect(parts(await events(await synthesize({ userId: asker, lang: 'zh', conversation, requestId }))).at(-1)!.state).toBe('done');
    /* Charged once: the dead one's fee came back when it was replaced. */
    expect(await balanceOf(db(), asker)).toBe(before - SYNTHESIS_FEE);
    expect((await synthesisLedger(asker)).map(([reason, delta]) => [reason, delta])).toEqual([
      ['synthesis_hold', -SYNTHESIS_FEE],
      ['synthesis_refund', SYNTHESIS_FEE],
      ['synthesis_hold', -SYNTHESIS_FEE],
      ['synthesis_settle', 0],
    ]);
    expect(await db().select().from(schema.creditHold).where(and(eq(schema.creditHold.userId, asker), eq(schema.creditHold.status, 'held')))).toEqual([]);
  });

  it('records 有用 / 没用 for the asker only, apart from any Ree rating', async () => {
    const { asker, conversation, requestId } = await answeredTwice();
    await events(await synthesize({ userId: asker, lang: 'zh', conversation, requestId }));
    const [row] = await db().select().from(schema.synthesis).where(eq(schema.synthesis.requestId, requestId));
    expect(await setSynthesisFeedback(asker, row!.id, 'up')).toBe('up');
    expect((await synthesesFor(asker, conversation.id)).get(requestId)?.vote).toBe('up');
    await expect(setSynthesisFeedback(await person(), row!.id, 'down')).rejects.toMatchObject({ code: 'not_found' });
    expect(await setSynthesisFeedback(asker, row!.id, null)).toBeNull();
    expect(await db().select().from(schema.synthesisFeedback).where(eq(schema.synthesisFeedback.synthesisId, row!.id))).toEqual([]);
    const replies = await db().select({ id: schema.message.id }).from(schema.message).where(eq(schema.message.requestId, requestId));
    expect(await db().select().from(schema.reeFeedback).where(inArray(schema.reeFeedback.messageId, replies.map((reply) => reply.id)))).toEqual([]);
  });

  it('goes with the conversation when the question is deleted', async () => {
    const { asker, conversation, requestId } = await answeredTwice();
    await events(await synthesize({ userId: asker, lang: 'zh', conversation, requestId }));
    await db().delete(schema.message).where(eq(schema.message.conversationId, conversation.id));
    expect(await db().select().from(schema.synthesis).where(eq(schema.synthesis.requestId, requestId))).toEqual([]);
  });
});

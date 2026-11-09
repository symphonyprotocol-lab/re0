/**
 * 回答核验 (ree-council-proposal.md 3): a checked question holds the check
 * fee per answering Ree with the rest; once an answer is settled its cited
 * sentences are checked, the result kept on the reply and the fee settled
 * to the platform. A Ree that does not answer, or a check that fails, gives
 * the fee back and leaves the answer as it is; too few credits for answer
 * and check together is a 402; verdicts that fit no sentence are dropped.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const chat = await import('@/lib/services/chat');
const conversations = await import('@/lib/services/conversations');
const { answer } = await import('@/lib/services/answer');
const { checkFigures } = await import('@/lib/services/statistics');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { VERIFY_FEE, QUERY_BASE_FEE } = await import('@/lib/constants');

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
  const subject = uniqueName('chk');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  return userId;
}

async function reeOf(ownerId: string, options: { content?: string | null; isPublic?: boolean; queryFee?: number } = {}) {
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
  const content = options.content === undefined ? WARRANTY : options.content;
  if (content) {
    const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: `${ree.name} notes`, content });
    await knowledge.processKnowledge(id);
  }
  const [row] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
  return row!;
}

type Event = { type: string; id?: string; data?: Record<string, unknown> };
type Check = { reeId: string; messageId: string; state: string; checks: { status: string; cites: number[]; reason: string; start: number; end: number }[]; cost: number };

async function read(response: Response) {
  const raw = await response.text();
  const events = raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Event);
  const text = events.filter((event) => event.type === 'text-delta').map((event) => (event as { delta?: string }).delta).join('');
  const checks = events.filter((event) => event.type === 'data-check').map((event) => event.data as Check);
  const outcomes = events.filter((event) => event.type === 'data-outcome').map((event) => event.data as { reeId: string; noAnswer: boolean; cost: number; messageId: string | null });
  return { events, text, checks, outcomes };
}

async function ledger(userId: string) {
  const rows = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.userId, userId)).orderBy(asc(schema.creditEntry.createdAt));
  return rows.filter((row) => /^(query|verify)_/.test(row.reason)).map((row) => [row.reason, row.delta]);
}

async function testChat(withKnowledge = true) {
  const userId = await person();
  const ree = await reeOf(userId, { content: withKnowledge ? WARRANTY : TIDES });
  const conversation = await chat.testConversation(userId, ree.id);
  return { userId, ree, conversation };
}

describeWithDb('answer checks (回答核验)', () => {
  it('checks a settled answer, keeps the result on the reply and charges the check fee to the platform', async () => {
    const { userId, ree, conversation } = await testChat();
    const before = await balanceOf(db(), userId);
    const result = await read(await answer({ userId, lang: 'zh', conversation, targets: [ree], question: QUESTION, verify: true }));
    expect(result.text).toContain('[1]');
    /* The answer is done before the check starts; the check then runs, then lands. */
    const order = result.events.map((event) => event.type).filter((type) => type === 'data-outcome' || type === 'data-check');
    expect(order).toEqual(['data-outcome', 'data-check', 'data-check']);
    expect(result.checks.map((check) => check.state)).toEqual(['pending', 'done']);
    const done = result.checks[1]!;
    expect(done).toMatchObject({ reeId: ree.id, messageId: result.outcomes[0]!.messageId, cost: VERIFY_FEE });
    expect(done.checks).toHaveLength(1);
    expect(done.checks[0]).toMatchObject({ status: 'supported', cites: [1] });
    expect(result.text.slice(done.checks[0]!.start, done.checks[0]!.end)).toBe(result.text.trim());

    expect(await balanceOf(db(), userId)).toBe(before - QUERY_BASE_FEE - VERIFY_FEE);
    expect(await ledger(userId)).toEqual([
      ['query_hold', -QUERY_BASE_FEE],
      ['verify_hold', -VERIFY_FEE],
      ['query_base', 0],
      ['verify_settle', 0],
    ]);
    const [reply] = await db().select().from(schema.message).where(and(eq(schema.message.conversationId, conversation.id), eq(schema.message.role, 'ree')));
    expect(reply).toMatchObject({ checkState: 'done', checkCredits: VERIFY_FEE, costCredits: QUERY_BASE_FEE });
    expect(reply!.checks).toEqual(done.checks);
    const calls = await db().select().from(schema.modelCall).where(and(eq(schema.modelCall.userId, userId), eq(schema.modelCall.purpose, 'verify')));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ status: 'succeeded', audience: 'free' });

    /* Reloaded, the conversation shows the same check. */
    const ui = chat.toUIMessages(await chat.messagesOf(conversation.id));
    const part = ui[1]!.parts.find((entry) => entry.type === 'data-check');
    expect(part).toMatchObject({ data: { state: 'done', cost: VERIFY_FEE, checks: done.checks } });
    expect(await checkFigures(ree.id, null)).toEqual({ answers: 1, cited: 1, unsupported: 0, partial: 0, uncited: 0 });

    /* Clearing the test conversation deletes the reply, not what its check counted. */
    await chat.clearConversation(conversation.id);
    expect(await checkFigures(ree.id, null)).toEqual({ answers: 1, cited: 1, unsupported: 0, partial: 0, uncited: 0 });
  });

  it('flags unsupported and uncited sentences, leaves out pleasantries and drops verdicts for sentences never asked about', async () => {
    const { userId, ree, conversation } = await testChat();
    const result = await read(await answer({ userId, lang: 'en', conversation, targets: [ree], question: `${QUESTION} MIXED`, verify: true }));
    const done = result.checks.at(-1)!;
    expect(done.state).toBe('done');
    expect(done.checks.map((check) => [result.text.slice(check.start, check.end), check.status])).toEqual([
      ['Refunds are issued to the original payment method within 14 days [1].', 'supported'],
      ['Store credit is offered on request UNSUPPORTED [1].', 'unsupported'],
      ['Refunds are always quick.', 'uncited'],
    ]);
    expect(done.checks[1]!.reason).toBe('The passage does not mention store credit.');
    expect(await checkFigures(ree.id, null)).toEqual({ answers: 1, cited: 2, unsupported: 1, partial: 0, uncited: 1 });
  });

  it('gives the check fee back when the Ree does not answer', async () => {
    const { userId, ree, conversation } = await testChat(false);
    const before = await balanceOf(db(), userId);
    const result = await read(await answer({ userId, lang: 'zh', conversation, targets: [ree], question: QUESTION, verify: true }));
    expect(result.outcomes[0]).toMatchObject({ noAnswer: true, cost: 0 });
    expect(result.checks).toEqual([]);
    expect(await balanceOf(db(), userId)).toBe(before);
    expect(await ledger(userId)).toEqual([
      ['query_hold', -QUERY_BASE_FEE],
      ['verify_hold', -VERIFY_FEE],
      ['query_refund', QUERY_BASE_FEE],
      ['verify_refund', VERIFY_FEE],
    ]);
  });

  it('treats a refusal that ends with the sentinel as no answer and checks nothing', async () => {
    const { userId, ree, conversation } = await testChat();
    const before = await balanceOf(db(), userId);
    const result = await read(await answer({ userId, lang: 'en', conversation, targets: [ree], question: `${QUESTION} LATE REFUSAL`, verify: true }));
    expect(result.outcomes[0]).toMatchObject({ noAnswer: true, cost: 0 });
    expect(result.checks).toEqual([]);
    expect(await balanceOf(db(), userId)).toBe(before);
    expect(await ledger(userId)).toEqual([
      ['query_hold', -QUERY_BASE_FEE],
      ['verify_hold', -VERIFY_FEE],
      ['query_refund', QUERY_BASE_FEE],
      ['verify_refund', VERIFY_FEE],
    ]);
    const [reply] = await db().select().from(schema.message).where(and(eq(schema.message.conversationId, conversation.id), eq(schema.message.role, 'ree')));
    expect(reply).toMatchObject({ noAnswer: true, content: '', checkState: null });
  });

  it('keeps the answer and refunds the check when the check fails', async () => {
    const { userId, ree, conversation } = await testChat();
    const before = await balanceOf(db(), userId);
    fake.checks.fail = true;
    try {
      const result = await read(await answer({ userId, lang: 'zh', conversation, targets: [ree], question: QUESTION, verify: true }));
      expect(result.outcomes[0]).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE });
      expect(result.checks.map((check) => [check.state, check.cost])).toEqual([
        ['pending', 0],
        ['failed', 0],
      ]);
    } finally {
      fake.checks.fail = false;
    }
    expect(await balanceOf(db(), userId)).toBe(before - QUERY_BASE_FEE);
    expect((await ledger(userId)).slice(-2)).toEqual([
      ['query_base', 0],
      ['verify_refund', VERIFY_FEE],
    ]);
    const [reply] = await db().select().from(schema.message).where(and(eq(schema.message.conversationId, conversation.id), eq(schema.message.role, 'ree')));
    expect(reply).toMatchObject({ checkState: 'failed', checkCredits: 0, noAnswer: false });
    expect(reply!.content).toContain('[1]');
    const ui = chat.toUIMessages(await chat.messagesOf(conversation.id));
    expect(ui[1]!.parts.find((entry) => entry.type === 'data-check')).toMatchObject({ data: { state: 'failed', checks: [] } });
    const calls = await db().select().from(schema.modelCall).where(and(eq(schema.modelCall.userId, userId), eq(schema.modelCall.purpose, 'verify')));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.status === 'failed')).toBe(true);
    expect(await checkFigures(ree.id, null)).toMatchObject({ answers: 0 });
  });

  it('refuses with 402 when answer and check together are more than the balance', async () => {
    const { userId, ree, conversation } = await testChat();
    await db().update(schema.creditGrant).set({ remaining: QUERY_BASE_FEE + VERIFY_FEE - 1 }).where(eq(schema.creditGrant.userId, userId));
    const refused = await answer({ userId, lang: 'zh', conversation, targets: [ree], question: QUESTION, verify: true });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: 'insufficient_credits', balance: QUERY_BASE_FEE + VERIFY_FEE - 1, needed: QUERY_BASE_FEE + VERIFY_FEE });
    expect(await chat.messagesOf(conversation.id)).toHaveLength(0);
    expect(await ledger(userId)).toEqual([]);
    /* Without the check the same balance answers. */
    const result = await read(await answer({ userId, lang: 'zh', conversation, targets: [ree], question: QUESTION }));
    expect(result.outcomes[0]).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE });
    expect(result.checks).toEqual([]);
  });

  it('holds nothing extra and checks nothing when the toggle is off', async () => {
    const { userId, ree, conversation } = await testChat();
    const result = await read(await answer({ userId, lang: 'zh', conversation, targets: [ree], question: QUESTION, verify: false }));
    expect(result.checks).toEqual([]);
    expect((await ledger(userId)).map(([reason]) => reason)).toEqual(['query_hold', 'query_base']);
    const [reply] = await db().select().from(schema.message).where(and(eq(schema.message.conversationId, conversation.id), eq(schema.message.role, 'ree')));
    expect(reply).toMatchObject({ checkState: null, checks: [], checkCredits: 0 });
  });

  it('checks each answering Ree on its own in a conversation and pays the owner only the query fee', async () => {
    const asker = await person();
    const owner = await person();
    const paid = await reeOf(owner, { isPublic: true, queryFee: 30 });
    const tides = await reeOf(asker, { content: TIDES });
    const empty = await reeOf(asker, { content: null });
    const created = await conversations.createConversation(asker, { reeIds: [paid.id, tides.id, empty.id] });
    const conversation = (await conversations.liveConversation(asker, created.id))!;
    const before = await balanceOf(db(), asker);
    const ownerBefore = await balanceOf(db(), owner);
    const result = await read(await answer({ userId: asker, lang: 'zh', conversation, targets: [paid, tides, empty], question: QUESTION, verify: true }));
    expect(result.checks.filter((check) => check.state === 'done').map((check) => check.reeId)).toEqual([paid.id]);
    /* 20 + 30 for the answer, 10 for its check; the off-topic Ree's hold came back, the empty one never held. */
    expect(await balanceOf(db(), asker)).toBe(before - QUERY_BASE_FEE - 30 - VERIFY_FEE);
    expect(await balanceOf(db(), owner)).toBe(ownerBefore + 30);
    const verifyEntries = await db()
      .select({ reason: schema.creditEntry.reason, reeId: schema.creditEntry.reeId, delta: schema.creditEntry.delta })
      .from(schema.creditEntry)
      .where(and(eq(schema.creditEntry.userId, asker), inArray(schema.creditEntry.reason, ['verify_hold', 'verify_settle', 'verify_refund'])));
    expect(verifyEntries.filter((entry) => entry.reeId === paid.id).map((entry) => entry.reason).sort()).toEqual(['verify_hold', 'verify_settle']);
    expect(verifyEntries.filter((entry) => entry.reeId === tides.id).map((entry) => entry.reason).sort()).toEqual(['verify_hold', 'verify_refund']);
    expect(verifyEntries.some((entry) => entry.reeId === empty.id)).toBe(false);
    const earned = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, owner), eq(schema.creditEntry.reason, 'query_fee_earned')));
    expect(earned.map((entry) => entry.delta)).toEqual([30]);
  });
});

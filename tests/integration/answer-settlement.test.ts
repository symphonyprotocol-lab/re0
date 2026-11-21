/**
 * The money path of one answer (review H2, H3, M6), asked as a private post
 * since the conversations went: the owner's query fee is withdrawable only
 * for what the asker paid from money paid in, and only after the maturity
 * period; a full answer that ends on the no-answer sentinel is still
 * charged; a stream cut off by a provider error is not.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, resetRewardSettings, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { handbookPages, makePdf } from '../fixtures/pdf';
import { startFakeFirecrawl } from '../fixtures/fake-firecrawl';
import type { FakeWeb } from '../fixtures/fake-web';
import { EARNED_MATURITY_DAYS, QUERY_BASE_FEE } from '@/lib/constants';

const blobs = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/blob', () => ({
  blobSize: async (path: string) => blobs.get(path)?.length ?? null,
  readBlob: async (path: string) => blobs.get(path) ?? null,
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { addGrant, balanceOf, placeHold, restoreVoidedEarned } = await import('@/lib/services/credits');
const billing = await import('@/lib/services/billing');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const privatePosts = await import('@/lib/services/private-posts');
/*
 * These tests are about how a Ree's own answer settles. When no Ree answers,
 * a private post now gets the asker an AI general answer at the base fee
 * (ai-answers.ts, covered by tests/integration/ai-answers.test.ts); here it
 * fails, so its hold is given back and every figure is the Ree's alone.
 */
const noAi = { aiAnswer: async () => { throw new Error('no AI in these tests'); } };
const payouts = await import('@/lib/services/payouts');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');

const DAY = 24 * 60 * 60 * 1000;
const FEE = 5_000;
const QUESTION = 'When are refunds issued to the original payment method?';

let fake: FakeOpenAi;
let firecrawl: FakeWeb;
beforeAll(async () => {
  firecrawl = startFakeFirecrawl();
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  firecrawl?.restore();
  vi.unstubAllEnvs();
  await fake?.close();
});

async function newUser(prefix: string): Promise<string> {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'zh', '/');
  return userId;
}

/** An owner's public Ree with ready knowledge and a query fee, and an asker. */
async function setUp(fee = FEE) {
  const ownerId = await newUser('owner');
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: 'Northwind', category: 'business', step: 4, reached: 4 });
  const { ree: created } = await rees.createReeFromDraft(ownerId);
  const path = `knowledge/${ownerId}/h/handbook.pdf`;
  blobs.set(path, makePdf(handbookPages()));
  await knowledge.processKnowledge(await knowledge.addKnowledge(ownerId, created, { kind: 'document', blobPath: path, fileName: 'handbook.pdf' }));
  await db().update(schema.ree).set({ queryFee: fee, isPublic: true, isPublished: true }).where(eq(schema.ree.id, created.id));
  const ree = { ...created, queryFee: fee };
  const askerId = await newUser('asker');
  return { ownerId, ree, askerId };
}

/** A Pack bought through Paddle: a purchase row and the grant it paid for. Answers its transaction and purchase ids. */
async function boughtPack(userId: string, credits: number) {
  const transactionId = uniqueName('txn');
  const purchaseId = await db().transaction(async (tx) => {
    const [purchase] = await tx
      .insert(schema.purchase)
      .values({ userId, kind: 'pack', paddleTransactionId: transactionId, amountMinor: 1_000, credits })
      .returning({ id: schema.purchase.id });
    await addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'purchase', refId: purchase!.id, purchaseId: purchase!.id });
    return purchase!.id;
  });
  return { transactionId, purchaseId };
}

function refundEvent(transactionId: string, total = '1000', action = 'refund') {
  return {
    event_id: uniqueName('evt'),
    event_type: 'adjustment.updated',
    occurred_at: new Date().toISOString(),
    data: { id: uniqueName('adj'), transaction_id: transactionId, action, status: 'approved', totals: { total } },
  };
}

async function emptyWelcome(userId: string) {
  await db().update(schema.creditGrant).set({ remaining: 0 }).where(and(eq(schema.creditGrant.userId, userId), eq(schema.creditGrant.source, 'welcome')));
}

async function earnedGrants(userId: string) {
  return db().select().from(schema.creditGrant).where(and(eq(schema.creditGrant.userId, userId), eq(schema.creditGrant.source, 'earned')));
}

/**
 * Asks the Ree privately at the price shown (`seen`, the query fee; the
 * current one when left out) and waits for its answer: the answer's text and
 * what it cost, or why it was refused. Each ask is its own question (a
 * random tag), so the duplicate window never folds two into one.
 */
async function ask(userId: string, ree: { id: string; queryFee: number }, question: string, seen = ree.queryFee) {
  const made = await privatePosts.publishPrivatePost(userId, { question: `${question} (${randomUUID().slice(0, 8)})`, reeIds: [ree.id], fees: { [ree.id]: QUERY_BASE_FEE + seen }, lang: 'en' });
  if (!made.ok) return { refused: made, text: '', outcome: undefined };
  await privatePosts.processPrivatePost(made.id, noAi);
  const [row] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, made.id));
  const charged = await db()
    .select({ delta: schema.creditEntry.delta })
    .from(schema.creditEntry)
    .where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.refId, row!.id)));
  /* Every entry the answer wrote for the asker -- the holds, their settlement or refund -- nets to what it cost. */
  return {
    postId: made.id,
    refused: null,
    text: row!.text,
    outcome: { noAnswer: row!.state === 'no_answer', failed: row!.state === 'failed', cost: -charged.reduce((sum, entry) => sum + entry.delta, 0) || 0 },
  };
}

describeWithDb('who may withdraw a query fee (H2)', () => {
  it('a fee paid from welcome credits is earned but never withdrawable', async () => {
    const { ownerId, ree, askerId } = await setUp();
    const result = await ask(askerId, ree, QUESTION);
    expect(result.outcome).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE + FEE });
    const earned = await earnedGrants(ownerId);
    expect(earned.map((grant) => [grant.amount, grant.withdrawableAt])).toEqual([[FEE, null]]);
    /* Spendable by the owner, but not a payout, now or later. */
    expect(await balanceOf(db(), ownerId)).toBeGreaterThanOrEqual(FEE);
    expect(await payouts.withdrawable(db(), ownerId, false, new Date(Date.now() + 365 * DAY))).toBe(0);
  });

  it('a fee paid from a bought Pack is withdrawable once it has matured', async () => {
    const { ownerId, ree, askerId } = await setUp();
    await emptyWelcome(askerId);
    await boughtPack(askerId, 100_000);
    const result = await ask(askerId, ree, QUESTION);
    expect(result.outcome).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE + FEE });
    const [grant] = await earnedGrants(ownerId);
    expect(grant).toMatchObject({ amount: FEE });
    expect(grant!.withdrawableAt!.getTime() - grant!.createdAt.getTime()).toBeGreaterThanOrEqual(EARNED_MATURITY_DAYS * DAY - 60_000);
    expect(await payouts.withdrawable(db(), ownerId)).toBe(0);
    expect(await payouts.withdrawable(db(), ownerId, false, new Date(Date.now() + (EARNED_MATURITY_DAYS + 1) * DAY))).toBe(FEE);
  });

  it('a fee paid partly from free and partly from paid credits is split', async () => {
    const { ownerId, ree, askerId } = await setUp();
    /* Spend order is welcome before Pack: 20 base + 1,000 of the fee from welcome, the other 4,000 from the Pack. */
    await db().update(schema.creditGrant).set({ remaining: QUERY_BASE_FEE + 1_000 }).where(and(eq(schema.creditGrant.userId, askerId), eq(schema.creditGrant.source, 'welcome')));
    await boughtPack(askerId, 100_000);
    await ask(askerId, ree, QUESTION);
    const earned = await earnedGrants(ownerId);
    expect(earned.map((grant) => [grant.amount, grant.withdrawableAt !== null]).sort()).toEqual([
      [1_000, false],
      [4_000, true],
    ]);
  });
});

describeWithDb('a refund of the asker’s purchase voids the owner’s unmatured earnings only when it leaves a debt (H2 follow-up)', () => {
  async function voidsOf(ownerId: string) {
    return db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, ownerId), eq(schema.creditEntry.reason, 'earned_void')));
  }

  it('a refund the purchase’s own credits cover leaves the owner’s earnings alone', async () => {
    const { ownerId, ree, askerId } = await setUp();
    await emptyWelcome(askerId);
    const pack = await boughtPack(askerId, 100_000);
    await ask(askerId, ree, QUESTION);
    /* Half refunded: 50,000 credits, all still on the Pack. */
    expect(await billing.applyPaddleEvent(refundEvent(pack.transactionId, '500'), { planPriceId: 'x', packPriceId: 'y' })).toBe('refunded');
    expect((await earnedGrants(ownerId)).map((grant) => grant.remaining)).toEqual([FEE]);
    expect(await voidsOf(ownerId)).toHaveLength(0);
    expect(await db().select().from(schema.creditDebt).where(eq(schema.creditDebt.userId, askerId))).toHaveLength(0);
  });

  it('a refund the buyer’s other balances cover leaves the owner’s earnings alone', async () => {
    const { ownerId, ree, askerId } = await setUp();
    await emptyWelcome(askerId);
    const pack = await boughtPack(askerId, 100_000);
    await ask(askerId, ree, QUESTION);
    /* The rest of the Pack is held, so the refund comes wholly from another Pack bought later. */
    await db().transaction((tx) => placeHold(tx, { userId: askerId, kind: 'knowledge', amount: 100_000 - QUERY_BASE_FEE - FEE, refId: crypto.randomUUID() }));
    const other = await boughtPack(askerId, 200_000);
    expect(await billing.applyPaddleEvent(refundEvent(pack.transactionId), { planPriceId: 'x', packPriceId: 'y' })).toBe('refunded');
    const [otherGrant] = await db().select().from(schema.creditGrant).where(eq(schema.creditGrant.purchaseId, other.purchaseId));
    expect(otherGrant!.remaining).toBe(100_000);
    expect(await db().select().from(schema.creditDebt).where(eq(schema.creditDebt.userId, askerId))).toHaveLength(0);
    expect((await earnedGrants(ownerId)).map((grant) => grant.remaining)).toEqual([FEE]);
    expect(await voidsOf(ownerId)).toHaveLength(0);
  });

  it('a debt voids at most its own amount of unmatured earnings, never what matured, and a replay changes nothing', async () => {
    const { ownerId, ree, askerId } = await setUp();
    await emptyWelcome(askerId);
    const pack = await boughtPack(askerId, 100_000);
    for (let i = 0; i < 3; i++) await ask(askerId, ree, QUESTION);
    const earned = await earnedGrants(ownerId);
    expect(earned).toHaveLength(3);
    const matured = earned[0]!.id;
    await db().update(schema.creditGrant).set({ withdrawableAt: new Date(Date.now() - DAY) }).where(eq(schema.creditGrant.id, matured));
    /* The rest of the Pack is held; another Pack covers 92,000 of the refund, so 8,000 is owed. */
    await db().transaction((tx) => placeHold(tx, { userId: askerId, kind: 'knowledge', amount: 100_000 - 3 * (QUERY_BASE_FEE + FEE), refId: crypto.randomUUID() }));
    await boughtPack(askerId, 92_000);
    const event = refundEvent(pack.transactionId);
    expect(await billing.applyPaddleEvent(event, { planPriceId: 'x', packPriceId: 'y' })).toBe('refunded');
    const [debt] = await db().select().from(schema.creditDebt).where(eq(schema.creditDebt.userId, askerId));
    expect(debt).toMatchObject({ amount: 8_000, remaining: 8_000 });
    const after = await earnedGrants(ownerId);
    expect(after.find((grant) => grant.id === matured)!.remaining).toBe(FEE);
    /* 8,000 of the 10,000 unmatured is voided, not all of it. */
    expect(after.filter((grant) => grant.id !== matured).reduce((sum, grant) => sum + grant.remaining, 0)).toBe(2 * FEE - 8_000);
    const voids = await voidsOf(ownerId);
    expect(voids.map((entry) => entry.delta)).toEqual([-8_000]);
    expect(voids[0]).toMatchObject({ refId: pack.purchaseId });

    /* The same adjustment delivered again, under the same and a new event id. */
    await billing.applyPaddleEvent(event, { planPriceId: 'x', packPriceId: 'y' });
    expect(await billing.applyPaddleEvent({ ...event, event_id: uniqueName('evt') }, { planPriceId: 'x', packPriceId: 'y' })).toBe('already_reversed');
    expect((await voidsOf(ownerId)).map((entry) => entry.delta)).toEqual([-8_000]);
    expect(await db().select().from(schema.creditDebt).where(eq(schema.creditDebt.userId, askerId))).toHaveLength(1);
    expect((await earnedGrants(ownerId)).reduce((sum, grant) => sum + grant.remaining, 0)).toBe(3 * FEE - 8_000);
  });

  it('voids what has not matured, notes what has, and never takes the owner below zero', async () => {
    const { ownerId, ree, askerId } = await setUp();
    await emptyWelcome(askerId);
    const pack = await boughtPack(askerId, 100_000);
    await ask(askerId, ree, QUESTION);
    await ask(askerId, ree, QUESTION);
    const earned = await earnedGrants(ownerId);
    expect(earned.map((grant) => grant.fundingPurchaseId)).toEqual([pack.purchaseId, pack.purchaseId]);
    /* One of the two has already matured: it stays the owner's. */
    await db().update(schema.creditGrant).set({ withdrawableAt: new Date(Date.now() - DAY) }).where(eq(schema.creditGrant.id, earned[0]!.id));
    /* The asker spends the rest, so the full refund finds 89,960 credits spent. */
    await db().transaction((tx) => placeHold(tx, { userId: askerId, kind: 'knowledge', amount: 100_000 - 2 * (QUERY_BASE_FEE + FEE), refId: crypto.randomUUID() }));
    expect(await billing.applyPaddleEvent(refundEvent(pack.transactionId), { planPriceId: 'x', packPriceId: 'y' })).toBe('refunded');
    const after = await earnedGrants(ownerId);
    const unmatured = after.find((grant) => grant.id !== earned[0]!.id)!;
    expect(unmatured.remaining).toBe(0);
    expect(after.find((grant) => grant.id === earned[0]!.id)!.remaining).toBe(FEE);
    const [voidEntry] = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, ownerId), eq(schema.creditEntry.reason, 'earned_void')));
    expect(voidEntry).toMatchObject({ delta: -FEE, refId: pack.purchaseId });
    expect(voidEntry!.note).toContain(`${FEE} could not be recovered`);
    /* Asker: nothing left on the Pack, the whole refund owed; welcome untouched. */
    const [debt] = await db().select().from(schema.creditDebt).where(eq(schema.creditDebt.userId, askerId));
    expect(debt).toMatchObject({ amount: 100_000, remaining: 100_000 });
  });
});

describeWithDb('paying off a refund debt restores the owner’s voided earnings in step', () => {
  const PRICES = { planPriceId: 'x', packPriceId: 'y' };

  async function entriesOf(userId: string, reason: 'earned_void' | 'earned_restore') {
    return db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.reason, reason)));
  }

  /** One answered question paid from a Pack whose rest is held, then that Pack refunded or charged back in full: 100,000 owed, FEE voided. */
  async function voidedByDebt(action = 'refund') {
    const setup = await setUp();
    await emptyWelcome(setup.askerId);
    const pack = await boughtPack(setup.askerId, 100_000);
    await ask(setup.askerId, setup.ree, QUESTION);
    await db().transaction((tx) => placeHold(tx, { userId: setup.askerId, kind: 'knowledge', amount: 100_000 - QUERY_BASE_FEE - FEE, refId: crypto.randomUUID() }));
    const [grant] = await earnedGrants(setup.ownerId);
    expect(await billing.applyPaddleEvent(refundEvent(pack.transactionId, '1000', action), PRICES)).toBe(action === 'refund' ? 'refunded' : 'charged_back');
    expect((await earnedGrants(setup.ownerId))[0]!.remaining).toBe(0);
    return { ...setup, pack, grant: grant! };
  }

  it('restores in proportion to what is repaid, into the same grant with its original maturity, and a replay restores nothing', async () => {
    const { ownerId, askerId, pack, grant } = await voidedByDebt();
    /* 40% of the debt repaid: 40% of what was voided comes back. */
    await boughtPack(askerId, 40_000);
    let [after] = await earnedGrants(ownerId);
    expect(after).toMatchObject({ id: grant.id, remaining: 2_000, withdrawableAt: grant.withdrawableAt, fundingPurchaseId: pack.purchaseId });
    expect(after!.withdrawableAt!.getTime()).toBeGreaterThan(Date.now());
    /* The rest repaid: all of it is back, never more. */
    await boughtPack(askerId, 60_000);
    [after] = await earnedGrants(ownerId);
    expect(after!.remaining).toBe(FEE);
    const restores = await entriesOf(ownerId, 'earned_restore');
    expect(restores.map((entry) => entry.delta)).toEqual([2_000, 3_000]);
    expect(restores.every((entry) => entry.refId === pack.purchaseId)).toBe(true);
    /* Settling again, or credits arriving with no debt left, gives nothing more. */
    expect(await db().transaction((tx) => restoreVoidedEarned(tx, pack.purchaseId))).toBe(0);
    await boughtPack(askerId, 10_000);
    expect((await entriesOf(ownerId, 'earned_restore')).length).toBe(2);
    expect((await earnedGrants(ownerId))[0]!.remaining).toBe(FEE);
  });

  it('a debt that voided less than it owed gives back only what was voided', async () => {
    const { ownerId, askerId, ree } = await setUp();
    await emptyWelcome(askerId);
    const pack = await boughtPack(askerId, 100_000);
    await ask(askerId, ree, QUESTION);
    await ask(askerId, ree, QUESTION);
    const earned = await earnedGrants(ownerId);
    /* One matured: the void cannot take it (unrecovered), so it never comes back either. */
    await db().update(schema.creditGrant).set({ withdrawableAt: new Date(Date.now() - DAY) }).where(eq(schema.creditGrant.id, earned[0]!.id));
    await db().transaction((tx) => placeHold(tx, { userId: askerId, kind: 'knowledge', amount: 100_000 - 2 * (QUERY_BASE_FEE + FEE), refId: crypto.randomUUID() }));
    await billing.applyPaddleEvent(refundEvent(pack.transactionId), PRICES);
    await boughtPack(askerId, 100_000);
    expect((await entriesOf(ownerId, 'earned_restore')).map((entry) => entry.delta)).toEqual([FEE]);
    expect((await earnedGrants(ownerId)).map((grant) => grant.remaining)).toEqual([FEE, FEE]);
  });

  it('a won chargeback and a repayment of the same debt do not restore twice', async () => {
    const { ownerId, askerId, pack, grant } = await voidedByDebt('chargeback');
    /* 20,000 repaid: 1,000 back. */
    await boughtPack(askerId, 20_000);
    expect((await earnedGrants(ownerId))[0]!.remaining).toBe(1_000);
    /* The merchant wins: the other 80,000 of debt is cancelled, the rest of the void comes back, once. */
    const reverse = refundEvent(pack.transactionId, '1000', 'chargeback_reverse');
    expect(await billing.applyPaddleEvent(reverse, PRICES)).toBe('chargeback_reversed');
    await billing.applyPaddleEvent({ ...reverse, event_id: uniqueName('evt') }, PRICES);
    await boughtPack(askerId, 50_000);
    const [after] = await earnedGrants(ownerId);
    expect(after).toMatchObject({ id: grant.id, remaining: FEE, withdrawableAt: grant.withdrawableAt });
    expect((await entriesOf(ownerId, 'earned_restore')).map((entry) => entry.delta)).toEqual([1_000, 4_000]);
    const [debt] = await db().select().from(schema.creditDebt).where(eq(schema.creditDebt.userId, askerId));
    expect(debt!.remaining).toBe(0);
  });
});

describeWithDb('the price the asker saw (review low)', () => {
  it('refuses a question when a fee went up since it was shown, before holding anything', async () => {
    const { ree, askerId } = await setUp();
    const before = await balanceOf(db(), askerId);
    const raised = await ask(askerId, ree, QUESTION, FEE - 1);
    expect(raised.refused).toEqual({ ok: false, error: 'price_changed', prices: [{ reeId: ree.id, price: QUERY_BASE_FEE + FEE }] });
    expect(await balanceOf(db(), askerId)).toBe(before);
    /* The same or a lower fee than shown is asked as usual. */
    const same = await ask(askerId, ree, QUESTION, FEE);
    expect(same.outcome).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE + FEE });
  });
});

describeWithDb('the earnings card (H2 follow-up)', () => {
  it('splits earned credits into withdrawable, maturing (with the next date) and never withdrawable', async () => {
    const userId = await newUser('earner');
    const now = new Date();
    const soon = new Date(now.getTime() + 3 * DAY);
    await db().transaction(async (tx) => {
      await addGrant(tx, { userId, source: 'earned', amount: 1_000, reason: 'query_fee_earned', refId: crypto.randomUUID(), withdrawableAt: new Date(now.getTime() - DAY) });
      await addGrant(tx, { userId, source: 'earned', amount: 2_000, reason: 'query_fee_earned', refId: crypto.randomUUID(), withdrawableAt: soon });
      await addGrant(tx, { userId, source: 'earned', amount: 4_000, reason: 'query_fee_earned', refId: crypto.randomUUID(), withdrawableAt: new Date(now.getTime() + 20 * DAY) });
      await addGrant(tx, { userId, source: 'earned', amount: 8_000, reason: 'query_fee_earned', refId: crypto.randomUUID(), withdrawableAt: null });
    });
    expect(await payouts.earnedBreakdown(db(), userId, now)).toEqual({ maturing: 6_000, locked: 8_000, nextMaturesAt: soon, nextMaturing: 2_000 });
    expect(await payouts.payoutOverview(userId, now)).toMatchObject({ withdrawable: 1_000, maturing: 6_000, locked: 8_000, nextMaturing: 2_000 });
  });
});

describeWithDb('settling the stream (H3, M6)', () => {
  it('charges a full answer that ends on the no-answer sentinel, and keeps a short refusal free', async () => {
    const { ownerId, ree, askerId } = await setUp();
    const before = await balanceOf(db(), askerId);
    const long = await ask(askerId, ree, `${QUESTION} LONG THEN SENTINEL`);
    expect(long.text).toContain('14 days');
    expect(long.text).not.toContain('[[NO_ANSWER]]');
    expect(long.outcome).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE + FEE });
    expect(await balanceOf(db(), askerId)).toBe(before - QUERY_BASE_FEE - FEE);
    expect((await earnedGrants(ownerId)).map((grant) => grant.amount)).toEqual([FEE]);

    /* Another asker and Ree, so the first answer's earnings stay apart. */
    const other = await setUp();
    const otherBefore = await balanceOf(db(), other.askerId);
    const short = await ask(other.askerId, other.ree, `${QUESTION} LATE REFUSAL`);
    expect(short.outcome).toMatchObject({ noAnswer: true, cost: 0 });
    expect(await balanceOf(db(), other.askerId)).toBe(otherBefore);
  });

  it('a stream cut off by a provider error fails the Ree and charges nothing', async () => {
    const { ownerId, ree, askerId } = await setUp();
    const before = await balanceOf(db(), askerId);
    const result = await ask(askerId, ree, `${QUESTION} STREAM ERROR`);
    expect(result.outcome).toMatchObject({ failed: true, cost: 0 });
    expect(await balanceOf(db(), askerId)).toBe(before);
    expect(await earnedGrants(ownerId)).toHaveLength(0);
    const [reply] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, result.postId!));
    expect(reply).toMatchObject({ state: 'failed', text: '' });
    const open = await db().select().from(schema.creditHold).where(and(eq(schema.creditHold.userId, askerId), eq(schema.creditHold.status, 'held')));
    expect(open).toHaveLength(0);
  });
});

describeWithDb('starter task rewards and invite-funded fees through the real question flow', () => {
  /* Every other suite runs with these rewards off (setup.ts); here they are on, as in production. */
  async function rewardsOn(values: Partial<typeof schema.rewardSettings.$inferInsert> = {}) {
    const row = { invitesEnabled: true, withdrawableInvites: 1_000, withdrawableInvitesPerInviter: 20, inviteCredits: 0, firstReeCredits: 2_500, firstPostCredits: 1_000, firstHelpfulCredits: 1_000, checkInCredits: 0, checkInMaxDays: 30, checkInWindowMonths: 3, revision: randomUUID(), updatedBy: null, ...values };
    await db().insert(schema.rewardSettings).values(row).onConflictDoUpdate({ target: schema.rewardSettings.id, set: row });
  }
  afterAll(resetRewardSettings);

  it('pays the first post (a private question) once, beside the holds and their settlement, and never for later ones', async () => {
    await rewardsOn();
    const { ownerId, ree, askerId } = await setUp();
    const before = await balanceOf(db(), askerId);
    const first = await ask(askerId, ree, QUESTION);
    expect(first.outcome).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE + FEE });
    expect(await balanceOf(db(), askerId)).toBe(before - QUERY_BASE_FEE - FEE + 1_000);
    const second = await ask(askerId, ree, `${QUESTION} Again?`);
    expect(second.outcome).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE + FEE });
    expect(await balanceOf(db(), askerId)).toBe(before - 2 * (QUERY_BASE_FEE + FEE) + 1_000);
    const rewards = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, askerId), eq(schema.creditEntry.reason, 'task_first_post')));
    expect(rewards.map((entry) => entry.delta)).toEqual([1_000]);
    /* Every hold of both questions settled; nothing left held. */
    const held = await db().select().from(schema.creditHold).where(and(eq(schema.creditHold.userId, askerId), eq(schema.creditHold.status, 'held')));
    expect(held).toHaveLength(0);
    /* The owner's own Ree, published (unpublished first: `setUp` made it public to be asked): paid once. A comment on it pays nothing (its task is retired). */
    await db().update(schema.ree).set({ isPublic: true, isPublished: false }).where(eq(schema.ree.id, ree.id));
    await rees.setReePublished(ownerId, ree.id, true);
    const { addReeComment } = await import('@/lib/services/ree-comments');
    await addReeComment(ree.id, { id: askerId, name: 'Asker', avatarBlob: null }, { id: randomUUID(), content: 'Helpful' });
    await addReeComment(ree.id, { id: askerId, name: 'Asker', avatarBlob: null }, { id: randomUUID(), content: 'Again' });
    const paid = await db().select({ userId: schema.creditEntry.userId, reason: schema.creditEntry.reason }).from(schema.creditEntry).where(inArray(schema.creditEntry.reason, ['task_first_ree', 'task_first_comment']));
    expect(paid.filter((row) => row.userId === ownerId).map((row) => row.reason)).toEqual(['task_first_ree']);
    expect(paid.filter((row) => row.userId === askerId)).toEqual([]);
  });

  it('a fee paid with invite-funded credits reaches the owner withdrawable after maturity, marked invite-funded', async () => {
    await rewardsOn({ firstPostCredits: 0 });
    const { ownerId, ree, askerId } = await setUp();
    await emptyWelcome(askerId);
    await db().transaction((tx) => addGrant(tx, { userId: askerId, source: 'earned', amount: 50_000, reason: 'invite_reward', refId: randomUUID(), withdrawableAt: new Date(), inviteFunded: true }));
    const result = await ask(askerId, ree, QUESTION);
    expect(result.outcome).toMatchObject({ noAnswer: false, cost: QUERY_BASE_FEE + FEE });
    const [grant] = await db().select().from(schema.creditGrant).where(and(eq(schema.creditGrant.userId, ownerId), eq(schema.creditGrant.source, 'earned')));
    expect(grant).toMatchObject({ amount: FEE, inviteFunded: true, fundingPurchaseId: null });
    expect(grant!.withdrawableAt!.getTime() - grant!.createdAt.getTime()).toBeGreaterThanOrEqual(EARNED_MATURITY_DAYS * DAY - 60_000);
    expect(await payouts.withdrawable(db(), ownerId, false, new Date(Date.now() + (EARNED_MATURITY_DAYS + 1) * DAY))).toBe(FEE);
  });
});

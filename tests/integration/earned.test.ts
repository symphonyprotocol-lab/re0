/**
 * Earned credits besides a payout (docs/design/earned-credits.md), against
 * the database: using the product never spends them; a conversion writes one
 * entry out and Pack grants in; a Plan or Pack paid in part with earned
 * credits holds them with the checkout, pays them with the webhook, gives
 * them back in proportion to a refund (paying the refund's debt first); a
 * purchase paid in full never reaches Paddle; concurrent conversions,
 * checkouts and payouts never take the same credits twice.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { WELCOME_CREDITS } from '@/lib/constants';
import { consoleAdministrator } from '../fixtures/console-administrator';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { addGrant, balanceOf, placeHold, InsufficientCredits } = await import('@/lib/services/credits');
const billing = await import('@/lib/services/billing');
const earnedService = await import('@/lib/services/earned');
const { db, schema } = await import('@/lib/infra/db');

const PRICES = { planPriceId: 'pri_test_plan', packPriceId: 'pri_test_pack' };
const CONFIG = {
  apiKey: 'test',
  webhookSecret: 'pdl_ntfset_test_secret',
  clientToken: 'test_client',
  environment: 'sandbox' as const,
  ...PRICES,
  checkoutUrl: 'http://localhost/checkout',
};
const DAY = 86_400_000;
const start = new Date('2026-11-01T00:00:00Z');
const end = new Date('2026-12-01T00:00:00Z');
const during = new Date('2026-11-10T00:00:00Z');
const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26)}`;

async function newUser(): Promise<string> {
  const subject = uniqueName('earner');
  const session = await createSession(
    { provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'Earner', avatarUrl: null },
    'zh',
    '/dashboard',
  );
  return session.userId;
}

/** Earned credits as an invitation or a query fee would leave them: withdrawable now, maturing, or never. */
async function earn(userId: string, amount: number, kind: 'withdrawable' | 'maturing' | 'locked' = 'withdrawable', inviteFunded = false) {
  const withdrawableAt = kind === 'withdrawable' ? new Date(during.getTime() - DAY) : kind === 'maturing' ? new Date(during.getTime() + 20 * DAY) : null;
  const { grantId } = await db().transaction((tx) =>
    addGrant(tx, { userId, source: 'earned', amount, reason: inviteFunded ? 'invite_reward' : 'query_fee_earned', refId: randomUUID(), withdrawableAt, fundingPurchaseId: null, inviteFunded }, new Date(during.getTime() - 2 * DAY)),
  );
  return grantId;
}

async function grantsOf(userId: string) {
  return db().select().from(schema.creditGrant).where(eq(schema.creditGrant.userId, userId)).orderBy(schema.creditGrant.createdAt);
}

async function entriesOf(userId: string) {
  return db().select().from(schema.creditEntry).where(eq(schema.creditEntry.userId, userId)).orderBy(schema.creditEntry.createdAt);
}

async function earnedLeft(userId: string) {
  return (await grantsOf(userId)).filter((grant) => grant.source === 'earned').reduce((sum, grant) => sum + grant.remaining, 0);
}

/** Every ledger row's allocations add up to its movement, and every grant holds exactly what its entries put there. */
async function expectLedgerTraceable(userId: string) {
  const grants = new Map((await grantsOf(userId)).map((grant) => [grant.id, grant]));
  const net = new Map<string, number>();
  for (const entry of await entriesOf(userId)) {
    const moved = entry.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    expect(moved, `${entry.reason} ${entry.delta}`).toBe(Math.abs(entry.delta));
    for (const allocation of entry.allocations) {
      expect(grants.get(allocation.grantId)?.source).toBe(allocation.source);
      net.set(allocation.grantId, (net.get(allocation.grantId) ?? 0) + Math.sign(entry.delta) * allocation.amount);
    }
  }
  for (const [grantId, grant] of grants) expect(net.get(grantId) ?? 0, grant.source).toBe(grant.remaining);
}

function transactionEvent(userId: string, options: { kind: 'plan' | 'pack'; quantity?: number; transactionId: string; subscriptionId?: string | null; total: string }) {
  return {
    event_id: id('evt'),
    event_type: 'transaction.completed',
    occurred_at: new Date().toISOString(),
    data: {
      id: options.transactionId,
      status: 'completed',
      customer_id: 'ctm_test',
      subscription_id: options.subscriptionId ?? null,
      origin: 'web',
      currency_code: 'USD',
      custom_data: { re0_user_id: userId, re0_kind: options.kind },
      billing_period: options.kind === 'plan' ? { starts_at: start.toISOString(), ends_at: end.toISOString() } : null,
      items: [{ quantity: options.quantity ?? 1, price: { id: options.kind === 'plan' ? PRICES.planPriceId : PRICES.packPriceId } }],
      details: { totals: { grand_total: options.total } },
    },
  };
}

function adjustmentEvent(transactionId: string, total: string, action = 'refund') {
  return {
    event_id: id('evt'),
    event_type: 'adjustment.updated',
    occurred_at: new Date().toISOString(),
    data: { id: id('adj'), transaction_id: transactionId, action, status: 'approved', totals: { total } },
  };
}

/** A Plan for the November period, bought through checkout like a user would. */
async function subscribe(userId: string) {
  const subscriptionId = id('sub');
  const transactionId = id('txn');
  await db().insert(schema.paddleCheckout).values({ paddleTransactionId: transactionId, userId, kind: 'plan', quantity: 1, unitCredits: 50_000, createdAt: during });
  await billing.applyPaddleEvent(
    {
      event_id: id('evt'),
      event_type: 'subscription.created',
      occurred_at: new Date().toISOString(),
      data: {
        id: subscriptionId,
        transaction_id: transactionId,
        status: 'active',
        customer_id: 'ctm_test',
        custom_data: { re0_user_id: userId, re0_kind: 'plan' },
        current_billing_period: { starts_at: start.toISOString(), ends_at: end.toISOString() },
        scheduled_change: null,
        items: [{ price: { id: PRICES.planPriceId } }],
        updated_at: start.toISOString(),
      },
    } as never,
    PRICES,
    during,
  );
  await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'plan', transactionId, subscriptionId, total: '1000' }) as never, PRICES, during);
}

/** A fake Paddle: records what checkout asked it for and what it cancelled. */
function fakePaddle() {
  const created: { kind: string; earnedMinor: number; id: string }[] = [];
  const cancelled: string[] = [];
  return {
    created,
    cancelled,
    deps: {
      config: CONFIG,
      now: during,
      create: async (_config: unknown, order: { kind: string }, _user: unknown, _price: unknown, earnedMinor = 0) => {
        const transaction = { kind: order.kind, earnedMinor, id: id('txn') };
        created.push(transaction);
        return { id: transaction.id };
      },
      cancel: async (_config: unknown, transactionId: string) => {
        cancelled.push(transactionId);
      },
    },
  };
}

beforeAll(async () => {
  /* Default prices (Plan USD 10 for 50,000, Pack USD 10 for 100,000) and default earned rules, whatever another file left. */
  await db().delete(schema.billingPrice);
  await db().delete(schema.earnedSettings);
});

afterAll(async () => {
  await db().delete(schema.earnedSettings);
});

describeWithDb('earned credits are never spent by using the product', () => {
  it('leaves them out of the balance and refuses a charge only they could pay', async () => {
    const userId = await newUser();
    await earn(userId, 5_000, 'withdrawable', true);
    expect(await balanceOf(db(), userId, during)).toBe(WELCOME_CREDITS);
    await expect(db().transaction((tx) => placeHold(tx, { userId, kind: 'knowledge', amount: WELCOME_CREDITS + 1, refId: randomUUID() }, during))).rejects.toBeInstanceOf(InsufficientCredits);
    const holdId = await db().transaction((tx) => placeHold(tx, { userId, kind: 'knowledge', amount: WELCOME_CREDITS, refId: randomUUID() }, during));
    const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.id, holdId));
    expect(hold!.allocations.every((entry) => entry.source !== 'earned')).toBe(true);
    expect(await earnedLeft(userId)).toBe(5_000);

    const summary = await billing.billingSummary(userId, during);
    expect(summary.total).toBe(0);
    expect(summary.buckets.earned).toBe(5_000);
    expect(summary.earned).toMatchObject({ total: 5_000, withdrawable: 5_000, deductible: 5_000, invite: 5_000 });
    expect((await billing.shellBilling(userId, during)).balance).toBe(0);
  });
});

describeWithDb('converting earned credits', () => {
  it('writes the earned side and the Pack grants it became, paid and free apart, and cannot overdraw', async () => {
    const userId = await newUser();
    const withdrawable = await earn(userId, 3_000, 'withdrawable');
    const maturing = await earn(userId, 1_000, 'maturing');
    const locked = await earn(userId, 500, 'locked');
    const result = await earnedService.convertEarned(userId, { credits: 2_000, rateBp: 10_000 }, during);
    expect(result).toMatchObject({ ok: true, converted: 2_000, received: 2_000 });
    /* Never-withdrawable first (500), then maturing (1,000), then withdrawable (500). */
    const left = new Map((await grantsOf(userId)).map((grant) => [grant.id, grant.remaining]));
    expect([left.get(withdrawable), left.get(maturing), left.get(locked)]).toEqual([2_500, 0, 0]);
    const packs = (await grantsOf(userId)).filter((grant) => grant.source === 'pack');
    expect(packs.map((grant) => [grant.amount, grant.convertedPaid]).sort()).toEqual([[1_500, true], [500, false]].sort());
    const entries = (await entriesOf(userId)).filter((entry) => entry.reason === 'earned_convert' || entry.reason === 'earned_converted');
    expect(entries.map((entry) => [entry.reason, entry.delta])).toEqual([['earned_convert', -2_000], ['earned_converted', 1_500], ['earned_converted', 500]]);
    expect(await balanceOf(db(), userId, during)).toBe(WELCOME_CREDITS + 2_000);
    await expectLedgerTraceable(userId);

    expect(await earnedService.convertEarned(userId, { credits: 2_501, rateBp: 10_000 }, during)).toMatchObject({ ok: false, error: 'insufficient_earned', available: 2_500 });
    expect(await earnedService.convertEarned(userId, { credits: 50, rateBp: 10_000 }, during)).toEqual({ ok: false, error: 'below_minimum' });
    expect(await earnedService.convertEarned(userId, { credits: 500, rateBp: 5_000 }, during)).toEqual({ ok: false, error: 'rate_changed' });
  });

  it('converts paid-for earnings into credits that count as paid when they pay a query fee', async () => {
    const owner = await newUser();
    const asker = await newUser();
    await earn(asker, 1_000, 'withdrawable');
    await earnedService.convertEarned(asker, { credits: 1_000, rateBp: 10_000 }, during);
    const holdId = await db().transaction((tx) => placeHold(tx, { userId: asker, kind: 'knowledge', amount: WELCOME_CREDITS + 500, refId: randomUUID() }, during));
    const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.id, holdId));
    const { paidShare } = await import('@/lib/services/credits');
    const share = await paidShare(db(), hold!.allocations);
    expect(share).toMatchObject({ paid: 500, free: WELCOME_CREDITS });
    expect(owner).toBeTruthy();
  });

  it('uses the console’s rate and serialises concurrent conversions', async () => {
    const before = await earnedService.earnedSettings();
    const saved = await earnedService.saveEarnedSettings(await administrator(), { ...before, convertRateBp: 5_000, revision: before.revision });
    await expect(earnedService.saveEarnedSettings(await administrator(), { ...before, revision: before.revision })).rejects.toThrow('pricing_conflict');
    const userId = await newUser();
    await earn(userId, 1_000);
    const [a, b] = await Promise.all([
      earnedService.convertEarned(userId, { credits: 600, rateBp: 5_000 }, during),
      earnedService.convertEarned(userId, { credits: 600, rateBp: 5_000 }, during),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect(await earnedLeft(userId)).toBe(400);
    expect(await balanceOf(db(), userId, during)).toBe(WELCOME_CREDITS + 300);
    await earnedService.saveEarnedSettings(await administrator(), { ...saved, convertRateBp: 10_000, revision: saved.revision });
    await expectLedgerTraceable(userId);
  });

  it('cannot convert what a payout holds', async () => {
    const userId = await newUser();
    await earn(userId, 1_000);
    await db().transaction((tx) => placeHold(tx, { userId, kind: 'payout', amount: 800, refId: randomUUID(), sources: ['earned'], withdrawableOnly: true }, during));
    expect(await earnedService.convertEarned(userId, { credits: 300, rateBp: 10_000 }, during)).toMatchObject({ ok: false, error: 'insufficient_earned', available: 200 });
  });
});

async function administrator(): Promise<string> {
  return (await consoleAdministrator()).id;
}

describeWithDb('paying for a Plan or Pack with earned credits', () => {
  it('holds part of the price with the checkout, discounts it in Paddle and pays it with the webhook', async () => {
    const userId = await newUser();
    await subscribe(userId);
    const grantId = await earn(userId, 50_000, 'maturing');
    const paddle = fakePaddle();
    const checkout = await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true, earnedMinor: 300 }, paddle.deps);
    expect(checkout).toMatchObject({ ok: true, earnedMinor: 300 });
    expect(paddle.created).toEqual([{ kind: 'pack', earnedMinor: 300, id: expect.any(String) }]);
    const transactionId = (checkout.ok && checkout.transactionId) || '';
    expect(await earnedLeft(userId)).toBe(20_000);

    expect(await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'pack', transactionId, total: '700' }) as never, PRICES, during)).toBe('credited');
    const [purchase] = await db().select().from(schema.purchase).where(eq(schema.purchase.paddleTransactionId, transactionId));
    expect(purchase).toMatchObject({ amountMinor: 700, credits: 100_000, earnedCredits: 30_000, earnedMinor: 300 });
    const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.id, purchase!.earnedHoldId!));
    expect(hold).toMatchObject({ status: 'settled', refId: purchase!.id, kind: 'deduction' });
    expect((await grantsOf(userId)).find((grant) => grant.id === grantId)!.remaining).toBe(20_000);
    await expectLedgerTraceable(userId);

    /* Half the money refunded: half the Pack back, half the earned credits back to the same grant. */
    await billing.applyPaddleEvent(adjustmentEvent(transactionId, '350') as never, PRICES, during);
    expect((await grantsOf(userId)).find((grant) => grant.id === grantId)!.remaining).toBe(35_000);
    let [after] = await db().select().from(schema.purchase).where(eq(schema.purchase.id, purchase!.id));
    expect(after).toMatchObject({ reversedCredits: 50_000, earnedReturned: 15_000 });
    /* The rest refunded. */
    await billing.applyPaddleEvent(adjustmentEvent(transactionId, '350') as never, PRICES, during);
    [after] = await db().select().from(schema.purchase).where(eq(schema.purchase.id, purchase!.id));
    expect(after).toMatchObject({ reversedCredits: 100_000, earnedReturned: 30_000 });
    expect(await earnedLeft(userId)).toBe(50_000);
    await expectLedgerTraceable(userId);
  });

  it('a refund that leaves a debt is paid first from the earned credits it gives back', async () => {
    const userId = await newUser();
    await subscribe(userId);
    await earn(userId, 30_000);
    const paddle = fakePaddle();
    const checkout = await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true, earnedMinor: 300 }, paddle.deps);
    const transactionId = (checkout.ok && checkout.transactionId) || '';
    await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'pack', transactionId, total: '700' }) as never, PRICES, during);
    /* Everything spendable is spent. */
    const spendable = await balanceOf(db(), userId, during);
    await db().transaction((tx) => placeHold(tx, { userId, kind: 'knowledge', amount: spendable, refId: randomUUID() }, during));
    await billing.applyPaddleEvent(adjustmentEvent(transactionId, '700') as never, PRICES, during);
    const debts = await db().select().from(schema.creditDebt).where(eq(schema.creditDebt.userId, userId));
    expect(debts).toHaveLength(1);
    /* 100,000 owed; the 30,000 earned credits given back paid 30,000 of it. */
    expect(debts[0]).toMatchObject({ amount: 100_000, remaining: 70_000 });
    expect(await earnedLeft(userId)).toBe(0);
    await expectLedgerTraceable(userId);
  });

  it('a Pack paid in full never reaches Paddle', async () => {
    const userId = await newUser();
    await subscribe(userId);
    await earn(userId, 150_000);
    const paddle = fakePaddle();
    const checkout = await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true, earnedMinor: 1_000 }, paddle.deps);
    expect(checkout).toMatchObject({ ok: true, purchaseId: expect.any(String), earnedMinor: 1_000 });
    expect(paddle.created).toEqual([]);
    const [purchase] = await db().select().from(schema.purchase).where(eq(schema.purchase.id, (checkout.ok && checkout.purchaseId) || ''));
    expect(purchase).toMatchObject({ paddleTransactionId: null, amountMinor: 0, earnedCredits: 100_000, earnedMinor: 1_000, credits: 100_000 });
    expect(await earnedLeft(userId)).toBe(50_000);
    expect((await grantsOf(userId)).find((grant) => grant.purchaseId === purchase!.id)).toMatchObject({ source: 'pack', amount: 100_000 });
    await expectLedgerTraceable(userId);
  });

  it('a Plan paid in full is one month that does not renew, and holds off a subscription', async () => {
    const userId = await newUser();
    await earn(userId, 100_000);
    const paddle = fakePaddle();
    const checkout = await billing.startCheckout(userId, { kind: 'plan', consent: true, earnedMinor: 1_000 }, paddle.deps);
    expect(checkout).toMatchObject({ ok: true, purchaseId: expect.any(String) });
    expect(paddle.created).toEqual([]);
    const plan = await billing.planStateOf(db(), userId, during);
    expect(plan).toMatchObject({ active: true, source: 'redeemed' });
    expect(plan.redeemedUntil?.toISOString()).toBe(new Date('2026-12-10T00:00:00Z').toISOString());
    const [grant] = (await grantsOf(userId)).filter((row) => row.source === 'plan');
    expect(grant).toMatchObject({ amount: 50_000, remaining: 50_000 });
    expect(grant!.expiresAt?.toISOString()).toBe('2026-12-10T00:00:00.000Z');
    expect(await billing.startCheckout(userId, { kind: 'plan', consent: true }, paddle.deps)).toEqual({ ok: false, error: 'plan_redeemed_active' });
    /* A Pack is open to it, like to any Plan. */
    expect(await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true }, paddle.deps)).toMatchObject({ ok: true });
    const summary = await billing.billingSummary(userId, during);
    expect(summary.plan).toMatchObject({ active: true, allowance: 50_000 });
  });

  it('refuses what the rules or the balance do not allow', async () => {
    const userId = await newUser();
    await subscribe(userId);
    await earn(userId, 95_000);
    await earn(userId, 50_000, 'locked');
    const paddle = fakePaddle();
    /* 9.50 would leave 0.50, under the 1.00 minimum. */
    expect(await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true, earnedMinor: 950 }, paddle.deps)).toEqual({ ok: false, error: 'deduction_leaves_too_little' });
    /* Earnings paid from free credits only convert: 95,000 is all that may pay. */
    expect(await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true, earnedMinor: 1_000 }, paddle.deps)).toEqual({ ok: false, error: 'insufficient_earned' });
    expect(await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true, earnedMinor: 1_001 }, paddle.deps)).toEqual({ ok: false, error: 'deduction_too_large' });
    expect(await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true, earnedMinor: 'all' }, paddle.deps)).toEqual({ ok: false, error: 'invalid_deduction' });
    expect(paddle.created).toEqual([]);
    expect(await earnedLeft(userId)).toBe(145_000);
  });

  it('a new checkout frees the earned credits an open one held, and the sweep frees an abandoned one', async () => {
    const userId = await newUser();
    await subscribe(userId);
    await earn(userId, 60_000);
    const paddle = fakePaddle();
    const first = await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true, earnedMinor: 500 }, paddle.deps);
    expect(await earnedLeft(userId)).toBe(10_000);
    const second = await billing.startCheckout(userId, { kind: 'pack', quantity: 2, consent: true, earnedMinor: 500 }, paddle.deps);
    expect(second.ok).toBe(true);
    expect(paddle.cancelled).toEqual([first.ok && first.transactionId]);
    expect(await earnedLeft(userId)).toBe(10_000);
    const [old] = await db().select().from(schema.paddleCheckout).where(eq(schema.paddleCheckout.paddleTransactionId, (first.ok && first.transactionId) || ''));
    expect(old!.supersededAt).not.toBeNull();
    /* The replaced checkout paid anyway is refused, never credited twice from the same earned credits. */
    expect(await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'pack', transactionId: old!.paddleTransactionId, total: '500' }) as never, PRICES, during)).toBe('unmatched');

    /* Left unpaid for a day: the sweep cancels it and gives the credits back. */
    expect(await billing.releaseStaleEarnedCheckouts(new Date(during.getTime() + 2 * DAY), { config: CONFIG, cancel: paddle.deps.cancel })).toBeGreaterThanOrEqual(1);
    expect(paddle.cancelled).toContain(second.ok && second.transactionId);
    expect(await earnedLeft(userId)).toBe(60_000);
    const releases = (await entriesOf(userId)).filter((entry) => entry.reason === 'deduction_release');
    expect(releases.map((entry) => entry.delta)).toEqual([50_000, 50_000]);
    await expectLedgerTraceable(userId);
  });

  it('serialises concurrent checkouts and conversions over the same earned credits', async () => {
    const userId = await newUser();
    await subscribe(userId);
    await earn(userId, 60_000);
    const paddle = fakePaddle();
    const results = await Promise.all([
      billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true, earnedMinor: 500 }, paddle.deps),
      billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true, earnedMinor: 500 }, paddle.deps),
      earnedService.convertEarned(userId, { credits: 20_000, rateBp: 10_000 }, during),
    ]);
    /* Never more out of earned than there was, and at most one checkout still holds any. */
    const left = await earnedLeft(userId);
    expect(left).toBeGreaterThanOrEqual(0);
    const holding = await db()
      .select({ hold: schema.creditHold.status })
      .from(schema.paddleCheckout)
      .innerJoin(schema.creditHold, eq(schema.creditHold.id, schema.paddleCheckout.earnedHoldId))
      .where(and(eq(schema.paddleCheckout.userId, userId), eq(schema.creditHold.status, 'held')));
    expect(holding.length).toBeLessThanOrEqual(1);
    const converted = results[2] as Awaited<ReturnType<typeof earnedService.convertEarned>>;
    expect(left).toBe(60_000 - holding.length * 50_000 - (converted.ok ? 20_000 : 0));
    await expectLedgerTraceable(userId);
  });
});

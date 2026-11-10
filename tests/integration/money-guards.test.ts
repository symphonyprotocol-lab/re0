/**
 * Guards on the money path (review M5, M10, M15 and the low refund-order
 * item): a Paddle payment is credited only against our own checkout or a
 * subscription we hold, never on `custom_data` alone; a refund that beats
 * its payment is retried, not dropped; a payout is not requested, approved
 * or paid while the user owes a refund or is disabled; a console credit
 * adjustment applies once per idempotency key.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

vi.mock('@/lib/infra/blob-access', () => ({
  blobInfo: async () => ({ size: 200_000, contentType: 'image/png' }),
  signedReadUrl: async (pathname: string) => ({ url: `https://blob.test/${pathname}`, expiresAt: new Date(Date.now() + 60_000) }),
  listByPrefix: async () => ({ blobs: [], cursor: null }),
  deleteBlobs: async () => undefined,
}));
vi.mock('@/lib/infra/blob', () => ({ uploadTicket: async (pathname: string) => ({ pathname, token: 'client-token' }) }));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { addGrant, balanceOf, expirePlanGrants, placeHold } = await import('@/lib/services/credits');
const billing = await import('@/lib/services/billing');
const kyc = await import('@/lib/services/kyc');
const payouts = await import('@/lib/services/payouts');
const adminUsers = await import('@/lib/services/admin-users');
const { reportingDate } = await import('@/lib/domain/statistics');
const { db, schema } = await import('@/lib/infra/db');

const PRICES = { planPriceId: 'pri_guard_plan', packPriceId: 'pri_guard_pack' };
const DAY = 24 * 60 * 60 * 1000;
const during = new Date('2026-11-10T00:00:00Z');
const start = new Date('2026-11-01T00:00:00Z');
const end = new Date('2026-12-01T00:00:00Z');

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26)}`;

async function newUser(prefix = 'guard'): Promise<string> {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'zh', '/');
  return userId;
}

async function newAdministrator(): Promise<string> {
  const [row] = await db()
    .insert(schema.administrator)
    .values({ name: 'Reviewer', email: `${uniqueName('admin')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x' })
    .returning({ id: schema.administrator.id });
  return row!.id;
}

function transaction(userId: string | null, options: { kind: 'plan' | 'pack'; transactionId?: string; subscriptionId?: string | null; origin?: string; priceId?: string; quantity?: number; total?: string }) {
  return {
    event_id: id('evt'),
    event_type: 'transaction.completed',
    occurred_at: during.toISOString(),
    data: {
      id: options.transactionId ?? id('txn'),
      status: 'completed',
      customer_id: 'ctm_test',
      subscription_id: options.subscriptionId ?? null,
      origin: options.origin ?? 'web',
      currency_code: 'USD',
      custom_data: userId ? { re0_user_id: userId, re0_kind: options.kind } : null,
      billing_period: options.kind === 'plan' ? { starts_at: start.toISOString(), ends_at: end.toISOString() } : null,
      items: [{ quantity: options.quantity ?? 1, price: { id: options.priceId ?? (options.kind === 'plan' ? PRICES.planPriceId : PRICES.packPriceId) } }],
      details: { totals: { grand_total: options.total ?? String(1000 * (options.quantity ?? 1)) } },
    },
  };
}

function subscriptionCreated(userId: string, subscriptionId: string, transactionId: string) {
  return {
    event_id: id('evt'),
    event_type: 'subscription.created',
    occurred_at: during.toISOString(),
    data: {
      id: subscriptionId,
      status: 'active',
      customer_id: 'ctm_test',
      custom_data: { re0_user_id: userId, re0_kind: 'plan' },
      current_billing_period: { starts_at: start.toISOString(), ends_at: end.toISOString() },
      scheduled_change: null,
      items: [{ price: { id: PRICES.planPriceId } }],
      updated_at: start.toISOString(),
      transaction_id: transactionId,
    },
  };
}

/** The row `startCheckout` writes when it opens a Paddle checkout for the user. */
async function checkout(userId: string, kind: 'plan' | 'pack', options: { transactionId?: string; priceId?: string; quantity?: number; unitPriceMinor?: number } = {}) {
  const transactionId = options.transactionId ?? id('txn');
  await db()
    .insert(schema.paddleCheckout)
    .values({
      paddleTransactionId: transactionId,
      userId,
      kind,
      quantity: options.quantity ?? 1,
      priceKey: 'test',
      unitPriceMinor: options.unitPriceMinor ?? 1_000,
      unitCredits: kind === 'plan' ? 50_000 : 100_000,
      paddlePriceId: options.priceId ?? (kind === 'plan' ? PRICES.planPriceId : PRICES.packPriceId),
    });
  return transactionId;
}

async function purchases(userId: string) {
  return db().select().from(schema.purchase).where(eq(schema.purchase.userId, userId));
}

describeWithDb('Paddle payments are credited from our own records (M5)', () => {
  it('a payment for a checkout we opened is credited to that checkout’s buyer', async () => {
    const userId = await newUser();
    const transactionId = await checkout(userId, 'pack');
    expect(await billing.applyPaddleEvent(transaction(userId, { kind: 'pack', transactionId }), PRICES, during)).toBe('credited');
    expect((await purchases(userId)).map((row) => row.credits)).toEqual([100_000]);
  });

  it('a payment opened outside our checkout is recorded, not credited, whoever custom_data names', async () => {
    const userId = await newUser();
    const before = await balanceOf(db(), userId);
    const event = transaction(userId, { kind: 'pack' });
    expect(await billing.applyPaddleEvent(event, PRICES, during)).toBe('unmatched');
    expect(await purchases(userId)).toHaveLength(0);
    expect(await balanceOf(db(), userId)).toBe(before);
    const [recorded] = await db().select().from(schema.billingEvent).where(eq(schema.billingEvent.id, event.event_id));
    expect(recorded).toMatchObject({ outcome: 'unmatched' });
  });

  it('a checkout of one user cannot be credited to another, nor for a price or amount it did not quote', async () => {
    const buyer = await newUser();
    const other = await newUser();
    const forOther = await checkout(buyer, 'pack');
    expect(await billing.applyPaddleEvent(transaction(other, { kind: 'pack', transactionId: forOther }), PRICES, during)).toBe('unmatched');
    /* A replaced (retired) price, still in the catalogue, on a checkout quoted at the current one. */
    await db().insert(schema.billingPrice).values({ environment: 'sandbox', kind: 'pack', priceMinor: 500, credits: 100_000, paddlePriceId: 'pri_guard_old_pack', enabled: false });
    const retired = await checkout(buyer, 'pack');
    expect(await billing.applyPaddleEvent(transaction(buyer, { kind: 'pack', transactionId: retired, priceId: 'pri_guard_old_pack' }), PRICES, during)).toBe('unmatched');
    const cheap = await checkout(buyer, 'pack', { quantity: 1 });
    expect(await billing.applyPaddleEvent(transaction(buyer, { kind: 'pack', transactionId: cheap, quantity: 3, total: '1000' }), PRICES, during)).toBe('unmatched');
    expect(await purchases(buyer)).toHaveLength(0);
    expect(await purchases(other)).toHaveLength(0);
  });

  it('a subscription is mirrored only from our Plan checkout, and its renewals are credited to its holder', async () => {
    const userId = await newUser();
    /* Started outside our checkout: not mirrored, so its renewals have no holder. */
    const stray = id('sub');
    expect(await billing.applyPaddleEvent(subscriptionCreated(userId, stray, id('txn')), PRICES, during)).toBe('unmatched');
    expect(await db().select().from(schema.subscription).where(eq(schema.subscription.paddleSubscriptionId, stray))).toHaveLength(0);

    const subscriptionId = id('sub');
    const first = await checkout(userId, 'plan');
    expect(await billing.applyPaddleEvent(subscriptionCreated(userId, subscriptionId, first), PRICES, during)).toBe('subscription');
    expect(await billing.applyPaddleEvent(transaction(userId, { kind: 'plan', transactionId: first, subscriptionId }), PRICES, during)).toBe('credited');
    /* A renewal has no checkout; the subscription says whose it is, whatever custom_data says. */
    const someoneElse = await newUser();
    expect(await billing.applyPaddleEvent(transaction(someoneElse, { kind: 'plan', subscriptionId, origin: 'subscription_recurring' }), PRICES, during)).toBe('credited');
    expect(await purchases(userId)).toHaveLength(2);
    expect(await purchases(someoneElse)).toHaveLength(0);
  });

  it('a refund that arrives before its payment is retried, and leaves no trace', async () => {
    const event = {
      event_id: id('evt'),
      event_type: 'adjustment.updated',
      occurred_at: during.toISOString(),
      data: { id: id('adj'), transaction_id: id('txn'), action: 'refund', status: 'approved', totals: { total: '1000' } },
    };
    await expect(billing.applyPaddleEvent(event, PRICES, during)).rejects.toBeInstanceOf(billing.RetryLater);
    expect(await db().select().from(schema.billingEvent).where(eq(schema.billingEvent.id, event.event_id))).toHaveLength(0);
  });
});

/* ------------------------------------------------ refunds and chargebacks */

function adjustment(transactionId: string, action: string, total = '1000') {
  return {
    event_id: id('evt'),
    event_type: 'adjustment.updated',
    occurred_at: during.toISOString(),
    data: { id: id('adj'), transaction_id: transactionId, action, status: 'approved', totals: { total } },
  };
}

async function boughtPack(userId: string) {
  const transactionId = await checkout(userId, 'pack');
  await billing.applyPaddleEvent(transaction(userId, { kind: 'pack', transactionId }), PRICES, during);
  return transactionId;
}

async function spend(userId: string, amount: number, now = during) {
  await db().transaction((tx) => placeHold(tx, { userId, kind: 'knowledge', amount, refId: randomUUID() }, now));
}

async function debts(userId: string) {
  return db().select().from(schema.creditDebt).where(eq(schema.creditDebt.userId, userId));
}

describeWithDb('a refund takes back only from the purchase it refunds', () => {
  it('a spent Pack becomes a debt; another Pack and the welcome credits are left alone', async () => {
    const userId = await newUser();
    const transactionId = await boughtPack(userId);
    await boughtPack(userId);
    /* Welcome (100,000) is spent first, then 60,000 of the older Pack. */
    await spend(userId, 160_000);
    expect(await balanceOf(db(), userId, during)).toBe(140_000);
    expect(await billing.applyPaddleEvent(adjustment(transactionId, 'refund'), PRICES, during)).toBe('refunded');
    /* Its own 40,000 left is taken back; the 60,000 spent is owed, not taken from the second Pack. */
    expect(await balanceOf(db(), userId, during)).toBe(100_000);
    expect((await debts(userId)).map((row) => row.amount)).toEqual([60_000]);
  });

  it('a Plan period that ended: what expired unused is not owed, only what was spent', async () => {
    const userId = await newUser();
    const subscriptionId = id('sub');
    const first = await checkout(userId, 'plan');
    await billing.applyPaddleEvent(subscriptionCreated(userId, subscriptionId, first), PRICES, during);
    await billing.applyPaddleEvent(transaction(userId, { kind: 'plan', transactionId: first, subscriptionId }), PRICES, during);
    /* 10,000 of the Plan's 50,000 spent (Plan credits go first), the other 40,000 expire with the period. */
    await spend(userId, 10_000);
    const after = new Date(end.getTime() + 1000);
    await db().transaction((tx) => expirePlanGrants(tx, { userId, cutoff: after }, after));
    const welcome = await balanceOf(db(), userId, after);
    expect(await billing.applyPaddleEvent(adjustment(first, 'refund'), PRICES, after)).toBe('refunded');
    expect(await balanceOf(db(), userId, after)).toBe(welcome);
    expect((await debts(userId)).map((row) => row.amount)).toEqual([10_000]);
  });

  it('a chargeback the merchant wins gives back what it took: the debt first, then the Pack, once', async () => {
    const userId = await newUser();
    const transactionId = await boughtPack(userId);
    await spend(userId, 130_000);
    expect(await billing.applyPaddleEvent(adjustment(transactionId, 'chargeback'), PRICES, during)).toBe('charged_back');
    expect((await debts(userId)).map((row) => row.remaining)).toEqual([30_000]);
    const [purchase] = await purchases(userId);
    expect(purchase).toMatchObject({ status: 'chargeback', reversedCredits: 100_000 });

    const reverse = adjustment(transactionId, 'chargeback_reverse');
    expect(await billing.applyPaddleEvent(reverse, PRICES, during)).toBe('chargeback_reversed');
    expect((await debts(userId)).map((row) => row.remaining)).toEqual([0]);
    expect(await balanceOf(db(), userId, during)).toBe(70_000);
    const [restored] = await purchases(userId);
    expect(restored).toMatchObject({ status: 'paid', reversedCredits: 0 });
    const entries = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.reason, 'chargeback_reverse')));
    expect(entries.map((entry) => entry.delta)).toEqual([70_000]);
    /* Re-delivered under a new event id: the adjustment id is applied once. */
    expect(await billing.applyPaddleEvent({ ...reverse, event_id: id('evt') }, PRICES, during)).toBe('already_reversed');
  });
});

describeWithDb('unmatched payments for the console (M5 follow-up)', () => {
  it('lists the payments that were recorded but not credited, newest first, with the count', async () => {
    const userId = await newUser();
    const event = transaction(userId, { kind: 'pack' });
    expect(await billing.applyPaddleEvent(event, PRICES, during)).toBe('unmatched');
    const listed = await billing.unmatchedBillingEvents(200);
    expect(listed.total).toBeGreaterThanOrEqual(1);
    expect(listed.items.find((item) => item.id === event.event_id)).toMatchObject({ eventType: 'transaction.completed', transactionId: event.data.id, userId, priceIds: [PRICES.packPriceId] });
  });
});

/* ---------------------------------------------------------------- payouts */

function kycForm(userId: string) {
  return {
    legalName: 'Mei Lin',
    country: 'Malaysia',
    documentKind: 'passport',
    documentLast4: '2048',
    documentExpires: reportingDate(Date.now() + 365 * DAY),
    taxForm: 'W-8BEN',
    declared: true,
    consent: true,
    documentBlob: `kyc/${userId}/${randomUUID()}.png`,
    selfieBlob: `kyc/${userId}/${randomUUID()}.png`,
  };
}

/** Verified, with a PayPal address and `earned` credits that are paid for and matured. */
async function payableCreator(reviewer: string, earned = 700_000): Promise<string> {
  const userId = await newUser('creator');
  const record = await kyc.submitKyc(userId, kycForm(userId));
  await kyc.decideKyc(reviewer, record.id, 'verified', { matched: true });
  await payouts.setPaypalEmail(userId, 'creator@example.com');
  await db().transaction((tx) => addGrant(tx, { userId, source: 'earned', amount: earned, reason: 'query_fee_earned', refId: randomUUID(), withdrawableAt: new Date(Date.now() - DAY) }));
  return userId;
}

async function owe(userId: string, amount: number) {
  await db().insert(schema.creditDebt).values({ userId, amount, remaining: amount });
}

describeWithDb('payouts wait for refund debts and stop for disabled accounts (M10)', () => {
  it('refuses a request while a refund is owed', async () => {
    const reviewer = await newAdministrator();
    const userId = await payableCreator(reviewer);
    await owe(userId, 100_000);
    await expect(payouts.requestPayout(userId, 600_000)).rejects.toMatchObject({ code: 'debt_open' });
  });

  it('refuses approval and payment once a debt or a disabled account appears; rejection still works', async () => {
    const reviewer = await newAdministrator();
    const userId = await payableCreator(reviewer);
    const payout = await payouts.requestPayout(userId, 600_000);
    await owe(userId, 100_000);
    await expect(payouts.decidePayout(reviewer, payout.id, 'approved', '')).rejects.toMatchObject({ code: 'debt_open' });
    expect((await payouts.payoutDetail(payout.id))).toMatchObject({ payable: false, user: { debt: 100_000 } });
    await db().update(schema.creditDebt).set({ remaining: 0 }).where(eq(schema.creditDebt.userId, userId));
    await payouts.decidePayout(reviewer, payout.id, 'approved', '');
    await db().update(schema.user).set({ disabledAt: new Date() }).where(eq(schema.user.id, userId));
    await expect(payouts.recordPayment(reviewer, payout.id, { transferId: uniqueName('PP'), paid: '59.00' })).rejects.toMatchObject({ code: 'disabled' });
    const failed = await payouts.failPayout(reviewer, payout.id, 'account disabled');
    expect(failed.status).toBe('failed');
  });

  it('only matured, paid-for earned credits count as withdrawable', async () => {
    const userId = await newUser('earner');
    const now = new Date();
    await db().transaction(async (tx) => {
      await addGrant(tx, { userId, source: 'earned', amount: 300_000, reason: 'query_fee_earned', refId: randomUUID(), withdrawableAt: new Date(now.getTime() - DAY) });
      await addGrant(tx, { userId, source: 'earned', amount: 200_000, reason: 'query_fee_earned', refId: randomUUID(), withdrawableAt: new Date(now.getTime() + DAY) });
      await addGrant(tx, { userId, source: 'earned', amount: 100_000, reason: 'query_fee_earned', refId: randomUUID(), withdrawableAt: null });
    });
    expect(await payouts.withdrawable(db(), userId, false, now)).toBe(300_000);
    expect(await payouts.withdrawable(db(), userId, false, new Date(now.getTime() + 2 * DAY))).toBe(500_000);
  });
});

/* ------------------------------------------------- console credit adjust */

describeWithDb('a console credit adjustment applies once per key (M15)', () => {
  it('a double submit grants once and answers the first result', async () => {
    const reviewer = await newAdministrator();
    const userId = await newUser();
    const before = await balanceOf(db(), userId);
    const requestId = randomUUID();
    const input = { bucket: 'pack', direction: 'grant', amount: 5_000, reason: 'support credit', requestId };
    const [one, two] = await Promise.all([adminUsers.adjustCredits(reviewer, userId, input), adminUsers.adjustCredits(reviewer, userId, input)]);
    expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
    expect(one.delta).toBe(5_000);
    expect(two.delta).toBe(5_000);
    expect(await balanceOf(db(), userId)).toBe(before + 5_000);
    const entries = await db().select().from(schema.creditEntry).where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.reason, 'admin_adjust')));
    expect(entries).toHaveLength(1);
    /* The same key for another adjustment is refused; a key is required. */
    await expect(adminUsers.adjustCredits(reviewer, userId, { ...input, amount: 6_000 })).rejects.toMatchObject({ code: 'stale' });
    await expect(adminUsers.adjustCredits(reviewer, userId, { ...input, requestId: undefined })).rejects.toMatchObject({ code: 'request_id' });
  });
});

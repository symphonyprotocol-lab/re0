/**
 * Acceptance (8.4 step 3), against the database with Paddle's notifications
 * replayed as signed bodies: a Plan payment credits 100,000 credits for its
 * period; a Pack needs an active Plan and 3 Packs credit 300,000 that never
 * expire; credits are spent Plan → welcome → Pack → earned and every ledger
 * row names its grants; turning renewal off keeps the period, which then
 * expires while Packs stay; a refund takes credits back without a negative
 * balance, recording a debt the next credits pay off; webhooks are applied
 * once; the ledger pages and filters on the server.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf, placeHold, releaseHold, settleHold, addGrant } = await import('@/lib/services/credits');
const { chargedFromNote } = await import('@/lib/domain/credits');
const billing = await import('@/lib/services/billing');
const { signPaddleBody } = await import('@/lib/infra/paddle');
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

const DAY = 24 * 60 * 60 * 1000;
const start = new Date('2026-11-01T00:00:00Z');
const end = new Date('2026-12-01T00:00:00Z');
const during = new Date('2026-11-10T00:00:00Z');

async function newUser(): Promise<string> {
  const subject = uniqueName('buyer');
  const session = await createSession(
    { provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'Buyer', avatarUrl: null },
    'zh',
    '/dashboard',
    new Date('2026-10-01T00:00:00Z'),
  );
  return session.userId;
}

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26)}`;

function transactionEvent(
  userId: string | null,
  options: { kind: 'plan' | 'pack'; quantity?: number; transactionId?: string; subscriptionId?: string | null; period?: [Date, Date]; total?: string; type?: string },
) {
  const period = options.period;
  return {
    event_id: id('evt'),
    event_type: options.type ?? 'transaction.completed',
    occurred_at: new Date().toISOString(),
    data: {
      id: options.transactionId ?? id('txn'),
      status: 'completed',
      customer_id: 'ctm_test',
      subscription_id: options.subscriptionId ?? null,
      origin: 'web',
      currency_code: 'USD',
      custom_data: userId ? { re0_user_id: userId, re0_kind: options.kind } : null,
      billing_period: period ? { starts_at: period[0].toISOString(), ends_at: period[1].toISOString() } : null,
      items: [{ quantity: options.quantity ?? 1, price: { id: options.kind === 'plan' ? PRICES.planPriceId : PRICES.packPriceId } }],
      details: { totals: { grand_total: options.total ?? String(1000 * (options.quantity ?? 1)) } },
    },
  };
}

function subscriptionEvent(
  userId: string,
  options: { subscriptionId: string; status?: string; period?: [Date, Date]; cancel?: boolean; updatedAt?: Date; type?: string },
) {
  const period = options.period ?? [start, end];
  return {
    event_id: id('evt'),
    event_type: options.type ?? 'subscription.updated',
    occurred_at: new Date().toISOString(),
    data: {
      id: options.subscriptionId,
      status: options.status ?? 'active',
      customer_id: 'ctm_test',
      custom_data: { re0_user_id: userId, re0_kind: 'plan' },
      current_billing_period: { starts_at: period[0].toISOString(), ends_at: period[1].toISOString() },
      scheduled_change: options.cancel ? { action: 'cancel', effective_at: period[1].toISOString() } : null,
      items: [{ price: { id: PRICES.planPriceId } }],
      updated_at: (options.updatedAt ?? start).toISOString(),
    },
  };
}

function adjustmentEvent(transactionId: string, options: { action?: string; total: string; status?: string; adjustmentId?: string }) {
  return {
    event_id: id('evt'),
    event_type: 'adjustment.updated',
    occurred_at: new Date().toISOString(),
    data: {
      id: options.adjustmentId ?? id('adj'),
      transaction_id: transactionId,
      action: options.action ?? 'refund',
      status: options.status ?? 'approved',
      totals: { total: options.total },
    },
  };
}

/** Through the webhook entry point, signed like Paddle signs it. */
async function deliver(event: object, now = during) {
  const raw = JSON.stringify(event);
  return billing.receivePaddleWebhook(raw, signPaddleBody(raw, CONFIG.webhookSecret), CONFIG, now);
}

/** A Plan for the November period: subscription row and its paid first transaction. */
async function subscribe(userId: string, now = during) {
  const subscriptionId = id('sub');
  const transactionId = id('txn');
  await billing.applyPaddleEvent(subscriptionEvent(userId, { subscriptionId, type: 'subscription.created' }), PRICES, now);
  await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'plan', transactionId, subscriptionId, period: [start, end] }), PRICES, now);
  return { subscriptionId, transactionId };
}

async function grantsOf(userId: string) {
  return db().select().from(schema.creditGrant).where(eq(schema.creditGrant.userId, userId)).orderBy(schema.creditGrant.createdAt);
}

async function entriesOf(userId: string) {
  return db().select().from(schema.creditEntry).where(eq(schema.creditEntry.userId, userId)).orderBy(schema.creditEntry.createdAt);
}

/** Every ledger row's allocations name grants of this user and add up to the row's movement. */
async function expectLedgerTraceable(userId: string) {
  const grants = new Map((await grantsOf(userId)).map((grant) => [grant.id, grant]));
  for (const entry of await entriesOf(userId)) {
    const moved = entry.allocations.reduce((sum, allocation) => sum + allocation.amount, 0);
    expect(moved, `${entry.reason} ${entry.delta}`).toBe(Math.abs(entry.delta));
    for (const allocation of entry.allocations) {
      expect(grants.get(allocation.grantId)?.source).toBe(allocation.source);
    }
  }
  /* Grants only ever hold what their entries put there. */
  const net = new Map<string, number>();
  for (const entry of await entriesOf(userId)) {
    for (const allocation of entry.allocations) {
      net.set(allocation.grantId, (net.get(allocation.grantId) ?? 0) + Math.sign(entry.delta) * allocation.amount);
    }
  }
  for (const [grantId, grant] of grants) expect(net.get(grantId) ?? 0, grant.source).toBe(grant.remaining);
}

describeWithDb('Plan and Pack purchases', () => {
  it('credits a Plan payment with 100,000 credits for its period, once', async () => {
    const userId = await newUser();
    const { transactionId } = await subscribe(userId);
    expect(await balanceOf(db(), userId, during)).toBe(102_000);
    const [plan] = (await grantsOf(userId)).filter((grant) => grant.source === 'plan');
    expect(plan).toMatchObject({ amount: 100_000, remaining: 100_000 });
    expect(plan!.expiresAt?.toISOString()).toBe(end.toISOString());
    expect(plan!.periodStart?.toISOString()).toBe(start.toISOString());

    /* The same payment told twice (`transaction.paid`, then `.completed`) and an event re-sent. */
    const again = transactionEvent(userId, { kind: 'plan', transactionId, period: [start, end], type: 'transaction.paid' });
    expect(await billing.applyPaddleEvent(again, PRICES, during)).toBe('already_credited');
    expect(await billing.applyPaddleEvent(again, PRICES, during)).toBe('duplicate');
    expect(await balanceOf(db(), userId, during)).toBe(102_000);

    const summary = await billing.billingSummary(userId, during);
    expect(summary.plan).toMatchObject({ active: true, allowance: 100_000, used: 0, remaining: 100_000 });
    expect(await billing.checkoutState(userId, transactionId)).toEqual({ credited: true, kind: 'plan', credits: 100_000 });
    await expectLedgerTraceable(userId);
  });

  it('refuses a Pack without an active Plan, and bad quantities', async () => {
    const userId = await newUser();
    const create = async () => ({ id: id('txn') });
    expect(await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true }, { config: CONFIG, create })).toEqual({ ok: false, error: 'plan_required' });
    expect(await billing.startCheckout(userId, { kind: 'pack', quantity: 0, consent: true }, { config: CONFIG, create })).toEqual({ ok: false, error: 'invalid_quantity' });
    expect(await billing.startCheckout(userId, { kind: 'pack', quantity: 11, consent: true }, { config: CONFIG, create })).toEqual({ ok: false, error: 'invalid_quantity' });
    expect(await billing.startCheckout(userId, { kind: 'plan', consent: false }, { config: CONFIG, create })).toEqual({ ok: false, error: 'consent_required' });
    const plan = await billing.startCheckout(userId, { kind: 'plan', consent: true }, { config: CONFIG, create });
    expect(plan.ok).toBe(true);
  });

  it('sells Packs to a Plan holder: 3 Packs credit 300,000 that never expire', async () => {
    const userId = await newUser();
    await subscribe(userId);
    let created: unknown;
    const create = async (_config: unknown, order: unknown, buyer: unknown) => {
      created = { order, buyer };
      return { id: id('txn') };
    };
    const checkout = await billing.startCheckout(userId, { kind: 'pack', quantity: 3, consent: true }, { config: CONFIG, create, now: during });
    expect(checkout.ok).toBe(true);
    expect(created).toEqual({ order: { kind: 'pack', quantity: 3 }, buyer: userId });
    expect(await billing.startCheckout(userId, { kind: 'plan', consent: true }, { config: CONFIG, create, now: during })).toEqual({ ok: false, error: 'already_subscribed' });

    await deliver(transactionEvent(userId, { kind: 'pack', quantity: 3, transactionId: checkout.ok ? checkout.transactionId : undefined }));
    const pack = (await grantsOf(userId)).find((grant) => grant.source === 'pack');
    expect(pack).toMatchObject({ amount: 300_000, remaining: 300_000, expiresAt: null });
    const [purchase] = await db().select().from(schema.purchase).where(and(eq(schema.purchase.userId, userId), eq(schema.purchase.kind, 'pack')));
    expect(purchase).toMatchObject({ quantity: 3, credits: 300_000, amountMinor: 3000, status: 'paid' });
    /* Long after every Plan period: the Pack is still there. */
    expect(await balanceOf(db(), userId, new Date('2028-01-01T00:00:00Z'))).toBe(302_000);
  });

  it('spends Plan, then welcome, then Pack, then earned; refunds walk back', async () => {
    const userId = await newUser();
    await subscribe(userId);
    await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'pack', quantity: 1 }), PRICES, during);
    await db().transaction((tx) => addGrant(tx, { userId, source: 'earned', amount: 5_000, reason: 'admin_adjust', refId: randomUUID() }, during));
    const holdId = await db().transaction((tx) =>
      placeHold(tx, { userId, kind: 'knowledge', amount: 100_000 + 2_000 + 100_000 + 1_000, refId: randomUUID() }, during),
    );
    const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.id, holdId));
    expect(hold!.allocations.map((allocation) => [allocation.source, allocation.amount])).toEqual([
      ['plan', 100_000],
      ['welcome', 2_000],
      ['pack', 100_000],
      ['earned', 1_000],
    ]);
    expect(await balanceOf(db(), userId, during)).toBe(4_000);
    await db().transaction((tx) => releaseHold(tx, holdId, {}, during));
    const byKind = Object.fromEntries((await grantsOf(userId)).map((grant) => [grant.source, grant.remaining]));
    expect(byKind).toEqual({ welcome: 2_000, plan: 100_000, pack: 100_000, earned: 5_000 });
    await expectLedgerTraceable(userId);
  });
});

describeWithDb('one Plan at a time', () => {
  it('reopens an open Plan checkout instead of creating a second one', async () => {
    const userId = await newUser();
    let created = 0;
    const create = async () => {
      created += 1;
      return { id: id('txn') };
    };
    const [first, second] = await Promise.all([
      billing.startCheckout(userId, { kind: 'plan', consent: true }, { config: CONFIG, create, now: during }),
      billing.startCheckout(userId, { kind: 'plan', consent: true }, { config: CONFIG, create, now: during }),
    ]);
    expect(created).toBe(1);
    expect(first.ok && second.ok && first.transactionId === second.transactionId).toBe(true);
    /* An hour later it is a new checkout. */
    const later = await billing.startCheckout(userId, { kind: 'plan', consent: true }, { config: CONFIG, create, now: new Date(during.getTime() + 61 * 60 * 1000) });
    expect(created).toBe(2);
    expect(later.ok && first.ok && later.transactionId !== first.transactionId).toBe(true);
  });

  it('refuses a new Plan while a failed renewal is still being retried', async () => {
    const userId = await newUser();
    const { subscriptionId } = await subscribe(userId);
    const after = new Date(end.getTime() + 60 * 60 * 1000);
    await billing.applyPaddleEvent(
      subscriptionEvent(userId, { subscriptionId, status: 'past_due', period: [end, new Date('2027-01-01T00:00:00Z')], updatedAt: after }),
      PRICES,
      after,
    );
    expect(await billing.hasActivePlan(db(), userId, after)).toBe(false);
    const create = async () => ({ id: id('txn') });
    expect(await billing.startCheckout(userId, { kind: 'plan', consent: true }, { config: CONFIG, create, now: after })).toEqual({ ok: false, error: 'renewal_pending' });
    expect(await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true }, { config: CONFIG, create, now: after })).toEqual({ ok: false, error: 'plan_required' });
    /* Paddle gives up and cancels: a new Plan may start. */
    await billing.applyPaddleEvent(subscriptionEvent(userId, { subscriptionId, status: 'canceled', updatedAt: new Date(after.getTime() + 1000), type: 'subscription.canceled' }), PRICES, after);
    expect((await billing.startCheckout(userId, { kind: 'plan', consent: true }, { config: CONFIG, create, now: after })).ok).toBe(true);
  });
});

describeWithDb('payments as Paddle took them', () => {
  it('credits a Pack quantity beyond the checkout’s ten, and a missing total records the list price', async () => {
    const userId = await newUser();
    await subscribe(userId);
    const big = id('txn');
    await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'pack', quantity: 12, transactionId: big }), PRICES, during);
    const odd = transactionEvent(userId, { kind: 'pack', quantity: 2 });
    (odd.data as { details: unknown }).details = null;
    await billing.applyPaddleEvent(odd, PRICES, during);
    const purchases = await db().select().from(schema.purchase).where(and(eq(schema.purchase.userId, userId), eq(schema.purchase.kind, 'pack')));
    expect(purchases.map((row) => [row.quantity, row.credits, row.amountMinor]).sort()).toEqual([
      [12, 1_200_000, 12_000],
      [2, 200_000, 2_000],
    ]);
    /* A partial refund of the one without a total stays partial. */
    await deliver(adjustmentEvent(odd.data.id, { total: '1000' }));
    const [refunded] = await db().select().from(schema.purchase).where(eq(schema.purchase.paddleTransactionId, odd.data.id));
    expect(refunded!.reversedCredits).toBe(100_000);
  });
});

describeWithDb('the Plan period', () => {
  it('turning renewal off keeps the period; at its end Plan credits expire and Packs stay', async () => {
    const userId = await newUser();
    const { subscriptionId } = await subscribe(userId);
    await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'pack', quantity: 2 }), PRICES, during);

    const cancelled = { ...subscriptionEvent(userId, { subscriptionId, cancel: true }).data };
    const result = await billing.setRenewal(userId, 'cancel', { config: CONFIG, cancel: async () => cancelled, now: during });
    expect(result).toEqual({ ok: true, cancelAtPeriodEnd: true, periodEnd: end.toISOString() });
    expect(await billing.hasActivePlan(db(), userId, during)).toBe(true);
    expect((await billing.billingSummary(userId, during)).plan).toMatchObject({ active: true, cancelAtPeriodEnd: true });

    /* Back on, then off again: the toggle follows Paddle's answer. */
    const resumed = { ...subscriptionEvent(userId, { subscriptionId }).data };
    expect(await billing.setRenewal(userId, 'resume', { config: CONFIG, resume: async () => resumed, now: during })).toMatchObject({ cancelAtPeriodEnd: false });
    const cancelledAgain = { ...subscriptionEvent(userId, { subscriptionId, cancel: true }).data };
    await billing.setRenewal(userId, 'cancel', { config: CONFIG, cancel: async () => cancelledAgain, now: during });

    const after = new Date(end.getTime() + 2 * 60 * 60 * 1000);
    expect(await balanceOf(db(), userId, after)).toBe(202_000);
    const swept = await billing.expireDuePlans(after);
    expect(swept.grants).toBeGreaterThanOrEqual(1);
    expect(swept.subscriptions).toBeGreaterThanOrEqual(1);
    const byKind = Object.fromEntries((await grantsOf(userId)).map((grant) => [grant.source, grant.remaining]));
    expect(byKind).toEqual({ welcome: 2_000, plan: 0, pack: 200_000 });
    const expiry = (await entriesOf(userId)).filter((entry) => entry.reason === 'expire');
    expect(expiry.map((entry) => entry.delta)).toEqual([-100_000]);
    expect(await billing.hasActivePlan(db(), userId, after)).toBe(false);
    const create = async () => ({ id: id('txn') });
    expect(await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true }, { config: CONFIG, create, now: after })).toEqual({ ok: false, error: 'plan_required' });

    /* The cron again, and Paddle's own `canceled` notice later: nothing more to do. */
    await billing.expireDuePlans(after);
    await billing.applyPaddleEvent(subscriptionEvent(userId, { subscriptionId, status: 'canceled', type: 'subscription.canceled' }), PRICES, after);
    expect((await entriesOf(userId)).filter((entry) => entry.reason === 'expire')).toHaveLength(1);
    await expectLedgerTraceable(userId);
  });

  it('a renewal starts the next period and writes off what was left of the last', async () => {
    const userId = await newUser();
    const { subscriptionId } = await subscribe(userId);
    await db().transaction((tx) => placeHold(tx, { userId, kind: 'knowledge', amount: 30_000, refId: randomUUID() }, during));
    const next: [Date, Date] = [end, new Date('2027-01-01T00:00:00Z')];
    const renewedAt = new Date(end.getTime() + 5 * 60 * 1000);
    await billing.applyPaddleEvent(subscriptionEvent(userId, { subscriptionId, period: next }), PRICES, renewedAt);
    expect(await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'plan', subscriptionId, period: next }), PRICES, renewedAt)).toBe('credited');
    const plans = (await grantsOf(userId)).filter((grant) => grant.source === 'plan');
    expect(plans.map((grant) => grant.remaining)).toEqual([0, 100_000]);
    const expiry = (await entriesOf(userId)).filter((entry) => entry.reason === 'expire');
    expect(expiry.map((entry) => entry.delta)).toEqual([-70_000]);
    const summary = await billing.billingSummary(userId, renewedAt);
    expect(summary.plan).toMatchObject({ used: 0, remaining: 100_000 });
    expect(summary.plan.periodEnd).toBe(next[1].toISOString());
  });

  it('ignores an older subscription event than the state it holds', async () => {
    const userId = await newUser();
    const { subscriptionId } = await subscribe(userId);
    await billing.applyPaddleEvent(subscriptionEvent(userId, { subscriptionId, cancel: true, updatedAt: new Date('2026-11-05T00:00:00Z') }), PRICES, during);
    expect(
      await billing.applyPaddleEvent(subscriptionEvent(userId, { subscriptionId, updatedAt: new Date('2026-11-04T00:00:00Z') }), PRICES, during),
    ).toBe('stale');
    expect((await billing.subscriptionOf(db(), userId))?.cancelAtPeriodEnd).toBe(true);
  });

  it('a payment that beats its subscription event still unlocks Packs', async () => {
    const userId = await newUser();
    const subscriptionId = id('sub');
    await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'plan', subscriptionId, period: [start, end] }), PRICES, during);
    expect(await billing.hasActivePlan(db(), userId, during)).toBe(true);
    await billing.applyPaddleEvent(subscriptionEvent(userId, { subscriptionId, type: 'subscription.created' }), PRICES, during);
    expect(await db().select().from(schema.subscription).where(eq(schema.subscription.userId, userId))).toHaveLength(1);
  });
});

describeWithDb('refunds and chargebacks', () => {
  it('takes a refund back without a negative balance; the shortfall is a debt the next credits pay', async () => {
    const userId = await newUser();
    await subscribe(userId);
    const packTxn = id('txn');
    await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'pack', quantity: 1, transactionId: packTxn }), PRICES, during);
    /* Spend everything but 10,000: Plan, welcome and 92,000 of the Pack. */
    await db().transaction((tx) => placeHold(tx, { userId, kind: 'knowledge', amount: 192_000, refId: randomUUID() }, during));
    expect(await balanceOf(db(), userId, during)).toBe(10_000);

    const adjustmentId = id('adj');
    expect(await deliver(adjustmentEvent(packTxn, { total: '1000', adjustmentId }))).toBe('refunded');
    expect(await balanceOf(db(), userId, during)).toBe(0);
    const [debt] = await db().select().from(schema.creditDebt).where(eq(schema.creditDebt.userId, userId));
    expect(debt).toMatchObject({ amount: 90_000, remaining: 90_000 });
    const [refund] = (await entriesOf(userId)).filter((entry) => entry.reason === 'refund');
    expect(refund!.delta).toBe(-10_000);
    const [purchase] = await db().select().from(schema.purchase).where(eq(schema.purchase.paddleTransactionId, packTxn));
    expect(purchase).toMatchObject({ status: 'refunded', reversedCredits: 100_000 });

    /* The same adjustment again (created, then updated): nothing more. */
    expect(await deliver(adjustmentEvent(packTxn, { total: '1000', adjustmentId }))).toBe('already_reversed');
    expect((await billing.billingSummary(userId, during)).debt).toBe(90_000);

    /* Next month's Plan pays the debt first. */
    const next: [Date, Date] = [end, new Date('2027-01-01T00:00:00Z')];
    const subscription = await billing.subscriptionOf(db(), userId);
    await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'plan', subscriptionId: subscription!.paddleSubscriptionId, period: next }), PRICES, end);
    expect(await balanceOf(db(), userId, end)).toBe(10_000);
    const [cleared] = await db().select().from(schema.creditDebt).where(eq(schema.creditDebt.userId, userId));
    expect(cleared!.remaining).toBe(0);
    expect(cleared!.clearedAt).not.toBeNull();
    expect((await entriesOf(userId)).filter((entry) => entry.reason === 'debt_offset').map((entry) => entry.delta)).toEqual([-90_000]);
    await expectLedgerTraceable(userId);
  });

  it('takes back a partial refund pro rata, and marks a chargeback', async () => {
    const userId = await newUser();
    await subscribe(userId);
    const packTxn = id('txn');
    await billing.applyPaddleEvent(transactionEvent(userId, { kind: 'pack', quantity: 4, transactionId: packTxn }), PRICES, during);
    await deliver(adjustmentEvent(packTxn, { total: '1000' }));
    expect((await grantsOf(userId)).find((grant) => grant.source === 'pack')!.remaining).toBe(300_000);
    expect(await deliver(adjustmentEvent(packTxn, { total: '500', status: 'pending_approval' }))).toBe('ignored');
    expect(await deliver(adjustmentEvent(packTxn, { action: 'chargeback', total: '3000' }))).toBe('charged_back');
    const [purchase] = await db().select().from(schema.purchase).where(eq(schema.purchase.paddleTransactionId, packTxn));
    expect(purchase).toMatchObject({ status: 'chargeback', reversedCredits: 400_000 });
    expect((await grantsOf(userId)).find((grant) => grant.source === 'pack')!.remaining).toBe(0);
    await expectLedgerTraceable(userId);
  });
});

describeWithDb('the webhook door', () => {
  it('refuses a body whose signature does not verify', async () => {
    const userId = await newUser();
    const raw = JSON.stringify(transactionEvent(userId, { kind: 'pack', quantity: 1 }));
    await expect(billing.receivePaddleWebhook(raw, signPaddleBody(raw, 'another-secret'), CONFIG)).rejects.toBeInstanceOf(billing.WebhookRejected);
    await expect(billing.receivePaddleWebhook(raw, null, CONFIG)).rejects.toBeInstanceOf(billing.WebhookRejected);
    const stale = signPaddleBody(raw, CONFIG.webhookSecret, Date.now() - 10 * 60 * 1000);
    await expect(billing.receivePaddleWebhook(raw, stale, CONFIG)).rejects.toBeInstanceOf(billing.WebhookRejected);
    expect(await balanceOf(db(), userId)).toBe(2_000);
  });

  it('asks for a retry when it cannot tell whose payment it is, and leaves no trace', async () => {
    const event = transactionEvent(null, { kind: 'pack', quantity: 1 });
    await expect(billing.applyPaddleEvent(event, PRICES, during)).rejects.toBeInstanceOf(billing.RetryLater);
    expect(await db().select().from(schema.billingEvent).where(eq(schema.billingEvent.id, event.event_id))).toHaveLength(0);
  });

  it('ignores what is not ours', async () => {
    const userId = await newUser();
    const foreign = transactionEvent(userId, { kind: 'pack' });
    foreign.data.items = [{ quantity: 1, price: { id: 'pri_someone_else' } }];
    expect(await billing.applyPaddleEvent(foreign, PRICES, during)).toBe('ignored');
    expect(await billing.applyPaddleEvent({ event_id: id('evt'), event_type: 'customer.updated', data: {} }, PRICES, during)).toBe('ignored');
  });
});

describeWithDb('the ledger list', () => {
  it('pages on the server and filters by activity', async () => {
    const userId = await newUser();
    for (let i = 0; i < 23; i += 1) {
      const holdId = await db().transaction((tx) => placeHold(tx, { userId, kind: 'knowledge', amount: 1, refId: randomUUID() }, new Date(during.getTime() + i * DAY / 24)));
      await db().transaction((tx) => releaseHold(tx, holdId, {}, new Date(during.getTime() + i * DAY / 24 + 1000)));
    }
    const all = await billing.listEntries(userId, { activity: 'all', page: 1, size: 20 });
    expect(all.total).toBe(47);
    expect(all.items).toHaveLength(20);
    const spend = await billing.listEntries(userId, { activity: 'spend', page: 3, size: 20 });
    expect(spend.total).toBe(46);
    expect(spend.items).toHaveLength(6);
    expect(spend.items.every((item) => item.reason.startsWith('knowledge_'))).toBe(true);
    /* An out-of-range page comes back as the last one. */
    expect((await billing.listEntries(userId, { activity: 'spend', page: 99, size: 20 })).page).toBe(3);
    expect((await billing.listEntries(userId, { activity: 'income', page: 1, size: 20 })).total).toBe(0);
    expect(all.items[0]!.sources).toEqual([{ source: 'welcome', amount: 1 }]);
  });

  it('shows what a settlement charged even when the caller labels it', async () => {
    const userId = await newUser();
    const holdId = await db().transaction((tx) => placeHold(tx, { userId, kind: 'knowledge', amount: 20, refId: randomUUID() }, during));
    await db().transaction((tx) => settleHold(tx, holdId, 7, { note: 'Handbook.pdf' }, during));
    /* Hold and settlement share a timestamp here, so pick the row by reason, not position. */
    const settle = (await billing.listEntries(userId, { activity: 'spend', page: 1, size: 20 })).items.find((item) => item.reason === 'knowledge_settle');
    expect(chargedFromNote(settle?.note)).toBe(7);
  });

  it('leaves query income out for an official account, server side, so pages stay right', async () => {
    const userId = await newUser();
    for (let i = 0; i < 3; i += 1) {
      const holdId = await db().transaction((tx) => placeHold(tx, { userId, kind: 'knowledge', amount: 1, refId: randomUUID() }, new Date(during.getTime() + i * 1000)));
      await db().transaction((tx) => releaseHold(tx, holdId, {}, new Date(during.getTime() + i * 1000 + 500)));
    }
    await db().insert(schema.creditEntry).values(
      ['query_fee_earned', 'query_fee_earned', 'payout_hold', 'payout_release'].map((reason, i) => ({
        userId,
        delta: reason === 'payout_hold' ? -50 : 50,
        reason: reason as 'query_fee_earned' | 'payout_hold' | 'payout_release',
        createdAt: new Date(during.getTime() + DAY + i * 1000),
      })),
    );
    expect((await billing.listEntries(userId, { activity: 'all', page: 1, size: 20 })).total).toBe(11);
    expect((await billing.listEntries(userId, { activity: 'income', page: 1, size: 20 })).total).toBe(4);
    expect((await billing.billingSummary(userId, during)).official).toBe(false);

    await db().update(schema.user).set({ role: 'official' }).where(eq(schema.user.id, userId));
    expect((await billing.billingSummary(userId, during)).official).toBe(true);
    const all = await billing.listEntries(userId, { activity: 'all', page: 1, size: 20 });
    expect(all.total).toBe(7);
    expect(all.items.some((item) => item.reason === 'query_fee_earned' || item.reason.startsWith('payout_'))).toBe(false);
    /* The income filter falls back to everything else, and paging counts only what is shown. */
    const income = await billing.listEntries(userId, { activity: 'income', page: 2, size: 20 });
    expect(income).toMatchObject({ activity: 'all', total: 7, page: 1 });
    expect((await billing.listEntries(userId, { activity: 'spend', page: 1, size: 20 })).total).toBe(6);
  });
});

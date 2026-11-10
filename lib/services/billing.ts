/**
 * Plan and Pack against the database and Paddle (rebuild-proposal.md 2.3,
 * 8.4 step 3): checkout, the webhook that credits payments, mirrors the
 * subscription and takes back refunds, renewal on / off, the expiry cron,
 * and what the billing tab and the sidebar read.
 *
 * Paddle's notifications are the record. A payment is credited once, by its
 * transaction id; every notification is applied once, by its event id, in
 * the same transaction as its effects; a subscription event older than the
 * state we hold is skipped. A Plan period's credits expire when the renewal
 * arrives (the webhook is the authority, 8.3); the cron only catches what no
 * renewal will (cancelled or lapsed Plans).
 */
import { cache } from 'react';
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { CHECKOUT_REUSE_MS, PACK, PLAN_EXPIRY_BATCH } from '@/lib/constants';
import {
  ACTIVITY_REASONS,
  creditsFor,
  parseOrder,
  planIsActive,
  planStateFrom,
  redeemedPeriodIndexAt,
  priceMinorFor,
  planUsage,
  reversalCredits,
  subscriptionStatusFrom,
  takeBack,
  type Activity,
  type CheckoutOrder,
  type PlanState,
  type PlanUsage,
  type PurchaseKind,
  type RedeemedPlan,
} from '@/lib/domain/billing';
import { availableOf, type Allocation } from '@/lib/domain/credits';
import { clampPage, likePattern } from '@/lib/domain/list';
import { periodRange, reportingDate, type PeriodFilter } from '@/lib/domain/statistics';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import {
  cancelAtPeriodEnd,
  cancelCheckoutTransaction,
  createCheckoutTransaction,
  customUserId,
  minorUnits,
  paddleConfig,
  paddleDate,
  parsePaddleEvent,
  PaddleNotConfigured,
  requirePaddle,
  resumeRenewal,
  verifyPaddleSignature,
  type PaddleAdjustment,
  type PaddleConfig,
  type PaddleEvent,
  type PaddleSubscription,
  type PaddleTransaction,
} from '@/lib/infra/paddle';
import { checkoutPrice, currentUnitCredits } from '@/lib/services/pricing';
import { addGrant, expirePlanGrants, grantsOf, moveGrants } from '@/lib/services/credits';

export class WebhookRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookRejected';
  }
}

/** A notification that cannot be placed yet (its buyer is unknown); answered with a 5xx so Paddle sends it again. */
export class RetryLater extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryLater';
  }
}

/* ------------------------------------------------------------ subscription */

type SubscriptionRow = typeof schema.subscription.$inferSelect;

/** The user's Plan: the active row reaching furthest, else the most recently changed one. */
export async function subscriptionOf(executor: Executor, userId: string): Promise<SubscriptionRow | null> {
  const [row] = await executor
    .select()
    .from(schema.subscription)
    .where(eq(schema.subscription.userId, userId))
    .orderBy(
      sql`case when ${schema.subscription.status} = 'active' then 0 else 1 end`,
      sql`${schema.subscription.currentPeriodEnd} desc nulls last`,
      desc(schema.subscription.updatedAt),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The user's redeemed Plans that have not ended by `now` (docs/design/redeem-codes.md
 * 4.2), current and waiting; every one when `now` is null.
 */
export async function redeemedPlansOf(executor: Executor, userId: string, now: Date | null = new Date()): Promise<RedeemedPlan[]> {
  const rows = await executor
    .select({
      startsAt: schema.redeemRedemption.planStartsAt,
      endsAt: schema.redeemRedemption.planEndsAt,
      months: schema.redeemRedemption.planMonths,
      credits: schema.redeemRedemption.credits,
    })
    .from(schema.redeemRedemption)
    .where(
      and(
        eq(schema.redeemRedemption.userId, userId),
        eq(schema.redeemRedemption.kind, 'plan'),
        isNull(schema.redeemRedemption.revokedAt),
        now ? gt(schema.redeemRedemption.planEndsAt, now) : undefined,
      ),
    );
  return rows.map((row) => ({ startsAt: row.startsAt!, endsAt: row.endsAt!, months: row.months!, credits: row.credits }));
}

/**
 * Whether the user's Plan is in force: a paying Paddle subscription, else a
 * redeemed Plan. Everything a Plan unlocks -- Packs, the Plan model, the
 * meter, the console's Plan credits -- asks this, never the subscription alone.
 */
export async function planStateOf(executor: Executor, userId: string, now = new Date()): Promise<PlanState> {
  const [subscription, redeemed] = await Promise.all([subscriptionOf(executor, userId), redeemedPlansOf(executor, userId, now)]);
  return planStateFrom(subscription, redeemed, now);
}

export async function hasActivePlan(executor: Executor, userId: string, now = new Date()): Promise<boolean> {
  return (await planStateOf(executor, userId, now)).active;
}

/* ---------------------------------------------------------------- checkout */

export type CheckoutRefusal =
  | 'invalid_kind'
  | 'invalid_quantity'
  | 'consent_required'
  | 'plan_required'
  | 'already_subscribed'
  | 'renewal_pending'
  | 'plan_redeemed_active'
  | 'price_changed';

export interface CheckoutDeps {
  config?: PaddleConfig;
  create?: typeof createCheckoutTransaction;
  cancel?: typeof cancelCheckoutTransaction;
  now?: Date;
}

/**
 * `POST /api/billing/checkout`: checks the order and creates the Paddle
 * transaction the browser's overlay opens. A Pack needs an active Plan
 * (2.3). A Plan is refused while another subscription is still alive in
 * Paddle -- paying, or `past_due` / `paused` (stored as `expired`), which
 * Paddle may yet collect -- and a Plan checkout opened in the last hour is
 * reopened instead of created again, so two tabs cannot start two
 * subscriptions. A per-user advisory lock serialises the check and the create.
 */
export async function startCheckout(
  userId: string,
  input: { kind?: unknown; quantity?: unknown; consent?: unknown; quoteKey?: unknown },
  deps: CheckoutDeps = {},
): Promise<{ ok: true; transactionId: string; order: CheckoutOrder } | { ok: false; error: CheckoutRefusal }> {
  const order = parseOrder(input);
  if ('error' in order) return { ok: false, error: order.error };
  if (input.consent !== true) return { ok: false, error: 'consent_required' };
  const now = deps.now ?? new Date();
  /*
   * Replacing a stale Plan checkout commits its cancellation and supersede on
   * their own, then starts over under the lock: a later Paddle or DB failure
   * can no longer roll back our record of a cancellation Paddle already made.
   */
  for (let attempt = 0; ; attempt += 1) {
    const result = await checkoutAttempt(userId, input, order, now, deps);
    if (result !== 'superseded') return result;
    if (attempt >= 2) throw new Error('plan checkout kept changing while it was replaced');
  }
}

async function checkoutAttempt(
  userId: string,
  input: { quoteKey?: unknown },
  order: CheckoutOrder,
  now: Date,
  deps: CheckoutDeps,
): Promise<{ ok: true; transactionId: string; order: CheckoutOrder } | { ok: false; error: CheckoutRefusal } | 'superseded'> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`checkout:${userId}`}))`);
    if (order.kind === 'pack' && !(await planStateOf(tx, userId, now)).active) return { ok: false as const, error: 'plan_required' as const };
    const config = deps.config ?? requirePaddle();
    const price = await checkoutPrice(tx, config, order.kind, now);
    if (input.quoteKey !== undefined && input.quoteKey !== price.quoteKey) return { ok: false as const, error: 'price_changed' as const };
    if (order.kind === 'plan') {
      const live = await tx
        .select({ status: schema.subscription.status })
        .from(schema.subscription)
        .where(and(eq(schema.subscription.userId, userId), inArray(schema.subscription.status, ['active', 'expired'])));
      if (live.some((row) => row.status === 'active')) return { ok: false as const, error: 'already_subscribed' as const };
      if (live.length > 0) return { ok: false as const, error: 'renewal_pending' as const };
      /* A redeemed Plan, in force or waiting: subscribing now would pay for months already given. */
      if ((await redeemedPlansOf(tx, userId, now)).length > 0) return { ok: false as const, error: 'plan_redeemed_active' as const };
      const [open] = await tx
        .select({ id: schema.paddleCheckout.paddleTransactionId, priceKey: schema.paddleCheckout.priceKey })
        .from(schema.paddleCheckout)
        .where(
          and(
            eq(schema.paddleCheckout.userId, userId),
            eq(schema.paddleCheckout.kind, 'plan'),
            isNull(schema.paddleCheckout.supersededAt),
            gt(schema.paddleCheckout.createdAt, new Date(now.getTime() - CHECKOUT_REUSE_MS)),
          ),
        )
        .orderBy(desc(schema.paddleCheckout.createdAt))
        .limit(1);
      if (open?.priceKey === price.quoteKey) return { ok: true as const, transactionId: open.id, order };
      if (open) {
        // Cancel before replacing: a failed cancellation must never start a second subscription.
        await (deps.cancel ?? cancelCheckoutTransaction)(config, open.id);
        await tx.update(schema.paddleCheckout).set({ supersededAt: now }).where(eq(schema.paddleCheckout.paddleTransactionId, open.id));
        return 'superseded' as const;
      }
    }
    const transaction = await (deps.create ?? createCheckoutTransaction)(config, order, userId, price);
    await tx.insert(schema.paddleCheckout).values({
      paddleTransactionId: transaction.id, userId, kind: order.kind, quantity: order.quantity,
      priceKey: price.quoteKey, unitPriceMinor: price.priceMinor, unitCredits: price.credits, paddlePriceId: price.priceId, createdAt: now,
    });
    return { ok: true as const, transactionId: transaction.id, order };
  });
}

/** `GET /api/billing/checkout?transaction=`: has this checkout's payment been credited to this user yet? */
export async function checkoutState(userId: string, transactionId: string): Promise<{ credited: boolean; kind: PurchaseKind | null; credits: number }> {
  const [row] = await db()
    .select({ kind: schema.purchase.kind, credits: schema.purchase.credits })
    .from(schema.purchase)
    .where(and(eq(schema.purchase.userId, userId), eq(schema.purchase.paddleTransactionId, transactionId)))
    .limit(1);
  return row ? { credited: true, kind: row.kind, credits: row.credits } : { credited: false, kind: null, credits: 0 };
}

/* ----------------------------------------------------------------- webhook */

/** `POST /api/billing/paddle`: the signature over the exact bytes, then the event, once. */
export async function receivePaddleWebhook(
  rawBody: string,
  signature: string | null,
  config: PaddleConfig | null = paddleConfig(),
  now = new Date(),
): Promise<string> {
  if (!config) throw new PaddleNotConfigured();
  if (!signature || !verifyPaddleSignature(rawBody, signature, config.webhookSecret)) {
    throw new WebhookRejected('the Paddle signature does not verify');
  }
  const event = parsePaddleEvent(rawBody);
  if (!event) throw new WebhookRejected('the signed body is not a Paddle event');
  return applyPaddleEvent(event, config, now);
}

type Prices = Pick<PaddleConfig, 'planPriceId' | 'packPriceId'> & Partial<Pick<PaddleConfig, 'environment'>>;

/**
 * Applies one notification. The `billing_event` row and the effects commit
 * together: a re-delivered event finds its row and changes nothing; one
 * that failed left no row and is applied in full on Paddle's retry.
 */
export async function applyPaddleEvent(event: PaddleEvent, prices: Prices, now = new Date()): Promise<string> {
  return db().transaction(async (tx) => {
    const [fresh] = await tx
      .insert(schema.billingEvent)
      .values({
        id: event.event_id,
        eventType: event.event_type,
        occurredAt: paddleDate(event.occurred_at),
        outcome: 'pending',
        payload: event,
        receivedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.billingEvent.id });
    if (!fresh) return 'duplicate';
    const outcome = await dispatch(tx, event, prices, now);
    await tx.update(schema.billingEvent).set({ outcome }).where(eq(schema.billingEvent.id, event.event_id));
    return outcome;
  });
}

async function dispatch(tx: Tx, event: PaddleEvent, prices: Prices, now: Date): Promise<string> {
  const [entity] = event.event_type.split('.');
  if (event.event_type === 'transaction.paid' || event.event_type === 'transaction.completed') {
    return creditTransaction(tx, event.data as unknown as PaddleTransaction, prices, now);
  }
  if (entity === 'subscription') return mirrorSubscription(tx, event.data as unknown as PaddleSubscription, prices, now);
  if (event.event_type === 'adjustment.created' || event.event_type === 'adjustment.updated') {
    return applyAdjustment(tx, event.data as unknown as PaddleAdjustment, now);
  }
  return 'ignored';
}

function priceIdsOf(transaction: { items: { price: { id: string } | null; price_id?: string }[] }): string[] {
  return transaction.items.map((item) => item.price?.id ?? item.price_id).filter((id): id is string => Boolean(id));
}

async function kindOf(tx: Tx, transaction: { items: { price: { id: string } | null; price_id?: string }[] }, prices: Prices): Promise<PurchaseKind | null> {
  const priceIds = priceIdsOf(transaction);
  if (priceIds.includes(prices.planPriceId)) return 'plan';
  if (priceIds.includes(prices.packPriceId)) return 'pack';
  if (!priceIds.length) return null;
  const [known] = await tx.select({ kind: schema.billingPrice.kind }).from(schema.billingPrice).where(and(inArray(schema.billingPrice.paddlePriceId, priceIds), prices.environment ? eq(schema.billingPrice.environment, prices.environment) : undefined)).limit(1);
  return known?.kind ?? null;
}

async function subscriptionByPaddleId(tx: Tx, paddleId: string | null | undefined): Promise<SubscriptionRow | null> {
  if (!paddleId) return null;
  const [row] = await tx.select().from(schema.subscription).where(eq(schema.subscription.paddleSubscriptionId, paddleId)).limit(1);
  return row ?? null;
}

function addMonth(date: Date): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

type CheckoutRow = typeof schema.paddleCheckout.$inferSelect;

/**
 * Whose payment a transaction is, from our own records only (review M5):
 * `custom_data` is whatever the client that opened the checkout put there.
 * A checkout we created names its buyer, kind and price; a renewal belongs
 * to the subscription we hold. Anything else -- a transaction opened outside
 * our checkout, for someone else, another product or a price we did not
 * quote -- is refused, recorded and logged, never credited.
 */
async function buyerOf(
  tx: Tx,
  transaction: PaddleTransaction,
  kind: PurchaseKind,
  checkout: CheckoutRow | undefined,
  subscription: SubscriptionRow | null,
): Promise<{ userId: string } | { refused: string }> {
  const named = customUserId(transaction.custom_data);
  if (checkout) {
    const priceIds = priceIdsOf(transaction);
    if (checkout.supersededAt) return { refused: 'checkout superseded' };
    if (named && named !== checkout.userId) return { refused: `custom_data names ${named}, the checkout ${checkout.userId}` };
    if (checkout.kind !== kind) return { refused: `checkout is a ${checkout.kind}, the price a ${kind}` };
    if (checkout.paddlePriceId && !priceIds.includes(checkout.paddlePriceId)) return { refused: `price ${priceIds.join(',')} is not the quoted ${checkout.paddlePriceId}` };
    const paid = minorUnits(transaction.details?.totals?.grand_total);
    const quantity = transaction.items[0]?.quantity ?? 1;
    if (checkout.unitPriceMinor !== null && Number.isFinite(paid) && paid < checkout.unitPriceMinor * quantity) {
      return { refused: `paid ${paid} for ${quantity} at the quoted ${checkout.unitPriceMinor}` };
    }
    return { userId: checkout.userId };
  }
  /* A renewal: Paddle bills a subscription we hold; historical Plan prices stay valid for it. */
  if (kind === 'plan' && transaction.subscription_id && transaction.origin !== 'web') {
    if (!subscription) throw new RetryLater(`renewal ${transaction.id} for subscription ${transaction.subscription_id} we do not hold yet`);
    if (named && named !== subscription.userId) console.warn(`renewal ${transaction.id}: custom_data names ${named}, the subscription ${subscription.userId}`);
    return { userId: subscription.userId };
  }
  return { refused: 'no checkout of ours' };
}

/**
 * A paid transaction: one purchase, one grant. A checkout grants the quoted
 * credits. Renewals grant the current allowance through the new period's end.
 * Pack credits do not expire.
 */
async function creditTransaction(tx: Tx, transaction: PaddleTransaction, prices: Prices, now: Date): Promise<string> {
  const kind = await kindOf(tx, transaction, prices);
  if (!kind) return 'ignored';
  const [existing] = await tx
    .select({ id: schema.purchase.id })
    .from(schema.purchase)
    .where(eq(schema.purchase.paddleTransactionId, transaction.id))
    .limit(1);
  if (existing) return 'already_credited';
  const subscription = await subscriptionByPaddleId(tx, transaction.subscription_id);
  const [checkout] = await tx.select().from(schema.paddleCheckout).where(eq(schema.paddleCheckout.paddleTransactionId, transaction.id)).limit(1);
  const buyer = await buyerOf(tx, transaction, kind, checkout, subscription);
  if ('refused' in buyer) {
    console.error(`paddle transaction ${transaction.id} (${kind}) not credited: ${buyer.refused}`);
    return 'unmatched';
  }
  const { userId } = buyer;
  /*
   * Credited as paid. Checkout only sells 1–10 Packs and the Paddle price
   * caps the overlay's quantity at 10, so anything else means the price was
   * changed in Paddle: the buyer still gets what they paid for, and we hear about it.
   */
  const quantity = kind === 'plan' ? 1 : (transaction.items[0]?.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`transaction ${transaction.id} has quantity ${quantity}`);
  if (quantity > PACK.maxQuantity) console.warn(`transaction ${transaction.id}: ${quantity} packs, beyond the checkout's ${PACK.maxQuantity}`);
  const order: CheckoutOrder = { kind, quantity };
  const snapshot = checkout ? { amount: checkout.unitPriceMinor, credits: checkout.unitCredits } : undefined;
  const credits = creditsFor(order, snapshot?.credits ?? await currentUnitCredits(tx, kind, prices.environment));
  let amount = minorUnits(transaction.details?.totals?.grand_total);
  if (!Number.isFinite(amount)) {
    /* Never 0: a zero would make every later refund read as a full one. */
    console.warn(`transaction ${transaction.id} has no readable total; recording the list price`);
    const priceId = transaction.items[0]?.price?.id ?? transaction.items[0]?.price_id;
    const [catalogue] = priceId ? await tx.select({ amount: schema.billingPrice.priceMinor }).from(schema.billingPrice).where(eq(schema.billingPrice.paddlePriceId, priceId)).limit(1) : [];
    amount = (snapshot?.amount ?? catalogue?.amount ?? priceMinorFor({ kind, quantity: 1 })) * quantity;
  }

  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  if (kind === 'plan') {
    periodStart = paddleDate(transaction.billing_period?.starts_at) ?? subscription?.currentPeriodStart ?? now;
    periodEnd = paddleDate(transaction.billing_period?.ends_at) ?? subscription?.currentPeriodEnd ?? addMonth(periodStart);
  }
  const [purchase] = await tx
    .insert(schema.purchase)
    .values({
      userId,
      kind,
      quantity: order.quantity,
      paddleTransactionId: transaction.id,
      paddleSubscriptionId: transaction.subscription_id,
      amountMinor: amount,
      currency: transaction.currency_code ?? 'USD',
      credits,
      periodStart,
      periodEnd,
      createdAt: now,
    })
    .returning({ id: schema.purchase.id });

  if (kind === 'plan') {
    if (subscription === null && transaction.subscription_id) {
      const [other] = await tx
        .select({ id: schema.subscription.paddleSubscriptionId })
        .from(schema.subscription)
        .where(and(eq(schema.subscription.userId, userId), eq(schema.subscription.status, 'active'), gt(schema.subscription.currentPeriodEnd, now)))
        .limit(1);
      if (other) console.warn(`user ${userId} paid for a second Plan ${transaction.subscription_id} beside ${other.id}`);
    }
    const cutoff = periodStart!.getTime() > now.getTime() ? periodStart! : now;
    await expirePlanGrants(tx, { userId, cutoff }, now);
    /*
     * The subscription event usually lands first; when the payment beats
     * it, a provisional row lets Packs and the meter work at once. Any
     * subscription event overwrites it (no `paddle_updated_at` yet).
     */
    if (transaction.subscription_id && !subscription) {
      await tx
        .insert(schema.subscription)
        .values({
          userId,
          paddleSubscriptionId: transaction.subscription_id,
          paddleCustomerId: transaction.customer_id,
          status: 'active',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
  }
  await addGrant(
    tx,
    {
      userId,
      source: kind,
      amount: credits,
      reason: 'purchase',
      refId: purchase!.id,
      purchaseId: purchase!.id,
      expiresAt: periodEnd,
      periodStart,
      note: kind === 'plan' ? `plan ${transaction.id}` : `pack x${order.quantity} ${transaction.id}`,
    },
    now,
  );
  return 'credited';
}

/** A subscription event: the Plan's state as Paddle holds it, unless we already hold a newer one. */
async function mirrorSubscription(tx: Tx, entity: PaddleSubscription, prices: Prices, now: Date): Promise<string> {
  if (entity.items?.length && await kindOf(tx, { items: entity.items }, prices) !== 'plan') return 'ignored';
  const existing = await subscriptionByPaddleId(tx, entity.id);
  /*
   * A subscription we do not hold yet must come from a checkout we created
   * (review M5); `custom_data` alone never makes one. Without the checkout's
   * transaction (a later event that beat `subscription.created`), wait for
   * the event or the payment that does carry it.
   */
  let userId = existing?.userId ?? null;
  if (!userId) {
    if (!entity.transaction_id) throw new RetryLater(`subscription ${entity.id} names no checkout yet`);
    const [origin] = await tx
      .select({ userId: schema.paddleCheckout.userId, kind: schema.paddleCheckout.kind })
      .from(schema.paddleCheckout)
      .where(eq(schema.paddleCheckout.paddleTransactionId, entity.transaction_id))
      .limit(1);
    if (!origin || origin.kind !== 'plan') {
      console.error(`paddle subscription ${entity.id} not mirrored: transaction ${entity.transaction_id} is no Plan checkout of ours`);
      return 'unmatched';
    }
    const named = customUserId(entity.custom_data);
    if (named && named !== origin.userId) {
      console.error(`paddle subscription ${entity.id} not mirrored: custom_data names ${named}, the checkout ${origin.userId}`);
      return 'unmatched';
    }
    userId = origin.userId;
  }
  return writeSubscription(tx, userId, existing, entity, now);
}

async function writeSubscription(tx: Tx, userId: string, existing: SubscriptionRow | null, entity: PaddleSubscription, now: Date): Promise<string> {
  const updatedAt = paddleDate(entity.updated_at);
  if (existing?.paddleUpdatedAt && updatedAt && updatedAt.getTime() < existing.paddleUpdatedAt.getTime()) return 'stale';
  const status = subscriptionStatusFrom(entity.status);
  const values = {
    status,
    paddleCustomerId: entity.customer_id,
    cancelAtPeriodEnd: status === 'active' && entity.scheduled_change?.action === 'cancel',
    currentPeriodStart: paddleDate(entity.current_billing_period?.starts_at) ?? existing?.currentPeriodStart ?? null,
    currentPeriodEnd: paddleDate(entity.current_billing_period?.ends_at) ?? existing?.currentPeriodEnd ?? null,
    paddleUpdatedAt: updatedAt,
    updatedAt: now,
  };
  if (existing) {
    await tx.update(schema.subscription).set(values).where(eq(schema.subscription.id, existing.id));
  } else {
    await tx.insert(schema.subscription).values({ userId, paddleSubscriptionId: entity.id, createdAt: now, ...values });
  }
  /* A Plan that stopped: periods that are over are written off now rather than at the next cron. */
  if (status !== 'active') await expirePlanGrants(tx, { userId, cutoff: now }, now);
  return 'subscription';
}

/**
 * An approved refund or chargeback takes back the refunded share of the
 * purchase's credits (terms s5): first from what is left of the purchase's
 * own grant, then from the user's other spendable credits in the spending
 * order (current Plan → welcome → Pack → earned; within earned, what can
 * never be withdrawn first and what is already withdrawable last), and what
 * nothing covers becomes a debt the next credits pay off first (2.3). The
 * balance never goes negative. Credits held for a payout or anything else
 * are not spendable, so they are never taken.
 *
 * One exception: a Plan period that has ended. What of it expired unused
 * was written off and is not owed, so it is taken from nowhere; only what
 * was really spent from it counts, less what earlier refunds already took.
 *
 * The spent part of the purchase may have paid query fees: whatever of the
 * earned credits it funded has not matured yet is voided from those owners
 * (review H2), independently of how the buyer pays the refund back.
 *
 * An approved `chargeback_reverse` (a chargeback the merchant won) gives
 * back what was taken: this purchase's open debt is cancelled first, then
 * the credits go back to the grants the chargeback took them from, as long
 * as each can still be spent (an ended Plan period is not revived). Owners'
 * voided earned credits are not restored.
 */
async function applyAdjustment(tx: Tx, adjustment: PaddleAdjustment, now: Date): Promise<string> {
  if (adjustment.status !== 'approved') return 'ignored';
  if (adjustment.action !== 'refund' && adjustment.action !== 'chargeback' && adjustment.action !== 'chargeback_reverse') return 'ignored';
  const [purchase] = await tx
    .select()
    .from(schema.purchase)
    .where(eq(schema.purchase.paddleTransactionId, adjustment.transaction_id))
    .for('update');
  if (!purchase) {
    /*
     * A transaction we saw and did not credit (not ours, unmatched) has
     * nothing to take back. One we have not seen yet: the refund beat the
     * payment, so ask Paddle to send it again rather than drop it.
     */
    const [seen] = await tx
      .select({ id: schema.billingEvent.id })
      .from(schema.billingEvent)
      .where(and(inArray(schema.billingEvent.eventType, ['transaction.paid', 'transaction.completed']), sql`${schema.billingEvent.payload}->'data'->>'id' = ${adjustment.transaction_id}`))
      .limit(1);
    if (seen) return 'ignored';
    throw new RetryLater(`adjustment ${adjustment.id} for transaction ${adjustment.transaction_id} we have not seen yet`);
  }
  if (purchase.adjustmentIds.includes(adjustment.id)) return 'already_reversed';
  if (adjustment.action === 'chargeback_reverse') return reverseChargeback(tx, purchase, adjustment, now);
  const credits = reversalCredits(purchase, minorUnits(adjustment.totals?.total));
  const chargeback = adjustment.action === 'chargeback';
  if (credits > 0) {
    const [own] = await tx.select().from(schema.creditGrant).where(eq(schema.creditGrant.purchaseId, purchase.id)).for('update');
    /* A Plan period that ended: what expired unused (or is left but no longer spendable) was never spent, so it is not owed. */
    let due = credits;
    if (own && own.source === 'plan' && own.expiresAt && own.expiresAt.getTime() <= now.getTime()) {
      const expired = await expiredFrom(tx, own.id);
      due = Math.min(credits, Math.max(0, own.amount - expired - own.remaining - purchase.reversedCredits));
    }
    const unowed = credits - due;
    /* The purchase's own grant first (an ended Plan's is not spendable, so it is skipped), then the rest in the spending order. */
    const { allocations, shortfall } = due > 0 ? takeBack(await grantsOf(tx, purchase.userId, true), own?.id ?? null, due, now) : { allocations: [], shortfall: 0 };
    await moveGrants(tx, allocations, -1);
    const taken = due - shortfall;
    const fromOwn = allocations.filter((entry) => entry.grantId === own?.id).reduce((sum, entry) => sum + entry.amount, 0);
    /* What of the purchase was already spent when it was refunded: what may have paid owners' query fees. */
    const spent = due - fromOwn;
    const voided = spent > 0 ? await voidFundedEarned(tx, purchase.id, spent, `${adjustment.action} ${adjustment.id}`, now) : { voided: 0, unrecovered: 0 };
    const notes = [
      `${adjustment.action} ${adjustment.id}: ${credits} credits`,
      fromOwn ? `${fromOwn} from the purchase` : '',
      taken - fromOwn ? `${taken - fromOwn} from other credits` : '',
      shortfall ? `${shortfall} owed` : '',
      unowed ? `${unowed} expired unused, not owed` : '',
      voided.voided ? `${voided.voided} of owners' unmatured earnings voided` : '',
      voided.unrecovered ? `${voided.unrecovered} of owners' earnings already matured or spent, not recovered` : '',
    ].filter(Boolean);
    await tx.insert(schema.creditEntry).values({
      userId: purchase.userId,
      delta: -taken,
      reason: chargeback ? 'chargeback' : 'refund',
      refId: purchase.id,
      note: notes.join(', '),
      allocations,
      createdAt: now,
    });
    if (shortfall > 0) {
      await tx.insert(schema.creditDebt).values({ userId: purchase.userId, amount: shortfall, remaining: shortfall, purchaseId: purchase.id, createdAt: now });
    }
  }
  await tx
    .update(schema.purchase)
    .set({
      status: chargeback ? 'chargeback' : 'refunded',
      reversedCredits: sql`${schema.purchase.reversedCredits} + ${credits}`,
      adjustmentIds: sql`array_append(${schema.purchase.adjustmentIds}, ${adjustment.id})`,
    })
    .where(eq(schema.purchase.id, purchase.id));
  return chargeback ? 'charged_back' : 'refunded';
}

/** What of a grant the expiry wrote off. */
async function expiredFrom(tx: Tx, grantId: string): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum((a->>'amount')::bigint), 0)` })
    .from(sql`${schema.creditEntry}, jsonb_array_elements(${schema.creditEntry.allocations}) a`)
    .where(and(eq(schema.creditEntry.reason, 'expire'), sql`a->>'grantId' = ${grantId}`));
  return Number(row?.total ?? 0);
}

/**
 * Voids up to `wanted` of the earned credits a refunded purchase paid for,
 * from grants that have not matured yet, newest first; never what matured,
 * is held for a payout or already spent. One `earned_void` entry per owner
 * says what was voided and what could not be (review H2).
 */
async function voidFundedEarned(tx: Tx, purchaseId: string, wanted: number, label: string, now: Date): Promise<{ voided: number; unrecovered: number }> {
  const funded = await tx
    .select()
    .from(schema.creditGrant)
    .where(eq(schema.creditGrant.fundingPurchaseId, purchaseId))
    .orderBy(desc(schema.creditGrant.createdAt))
    .for('update');
  if (funded.length === 0) return { voided: 0, unrecovered: 0 };
  const [already] = await tx
    .select({ total: sql<string>`coalesce(sum(-${schema.creditEntry.delta}), 0)` })
    .from(schema.creditEntry)
    .where(and(eq(schema.creditEntry.reason, 'earned_void'), eq(schema.creditEntry.refId, purchaseId)));
  /* What these owners were paid from this purchase that is not voided yet: the most a refund could reach. */
  const outstanding = Math.max(0, funded.reduce((sum, grant) => sum + grant.amount, 0) - Number(already?.total ?? 0));
  const target = Math.min(wanted, outstanding);
  let left = target;
  const byOwner = new Map<string, Allocation[]>();
  for (const grant of funded) {
    if (left === 0) break;
    if (!grant.withdrawableAt || grant.withdrawableAt.getTime() <= now.getTime() || grant.remaining <= 0) continue;
    const take = Math.min(left, grant.remaining);
    byOwner.set(grant.userId, [...(byOwner.get(grant.userId) ?? []), { grantId: grant.id, source: grant.source, amount: take }]);
    left -= take;
  }
  const voided = target - left;
  /* The ledger of every owner touched; what could not be recovered is noted on the newest grant's owner, for the console. */
  const noted = funded[0]!.userId;
  const owners = new Set([...byOwner.keys(), ...(left > 0 ? [noted] : [])]);
  for (const userId of owners) {
    const allocations = byOwner.get(userId) ?? [];
    await moveGrants(tx, allocations, -1);
    const amount = allocations.reduce((sum, entry) => sum + entry.amount, 0);
    await tx.insert(schema.creditEntry).values({
      userId,
      delta: -amount,
      reason: 'earned_void',
      refId: purchaseId,
      note: `${label}: the asker's purchase was refunded; ${amount} unmatured earned credits voided${left && userId === noted ? `, ${left} could not be recovered (matured, held or spent)` : ''}`,
      allocations,
      createdAt: now,
    });
  }
  if (left > 0) console.warn(`purchase ${purchaseId}: ${left} earned credits it paid for could not be voided (matured, held or spent)`);
  return { voided, unrecovered: left };
}

/** A chargeback the merchant won: this purchase's debt cancelled first, then the rest back to its grant. */
async function reverseChargeback(tx: Tx, purchase: typeof schema.purchase.$inferSelect, adjustment: PaddleAdjustment, now: Date): Promise<string> {
  const total = minorUnits(adjustment.totals?.total);
  const share = purchase.amountMinor > 0 && Number.isFinite(total) && total > 0 && total < purchase.amountMinor
    ? Math.round((purchase.credits * total) / purchase.amountMinor)
    : purchase.reversedCredits;
  const restore = Math.min(purchase.reversedCredits, Math.max(0, share));
  let left = restore;
  const debts = await tx
    .select()
    .from(schema.creditDebt)
    .where(and(eq(schema.creditDebt.purchaseId, purchase.id), gt(schema.creditDebt.remaining, 0)))
    .orderBy(desc(schema.creditDebt.createdAt))
    .for('update');
  let cancelled = 0;
  for (const debt of debts) {
    if (left === 0) break;
    const cancel = Math.min(left, debt.remaining);
    await tx
      .update(schema.creditDebt)
      .set({ remaining: debt.remaining - cancel, clearedAt: debt.remaining === cancel ? now : null })
      .where(eq(schema.creditDebt.id, debt.id));
    cancelled += cancel;
    left -= cancel;
  }
  /* The credits the chargebacks of this purchase took, per grant, less what reversals already gave back. */
  const takenRows = await tx
    .select({ reason: schema.creditEntry.reason, allocations: schema.creditEntry.allocations })
    .from(schema.creditEntry)
    .where(and(eq(schema.creditEntry.refId, purchase.id), inArray(schema.creditEntry.reason, ['chargeback', 'chargeback_reverse'])))
    .orderBy(asc(schema.creditEntry.createdAt));
  const owed = new Map<string, number>();
  for (const row of takenRows) for (const entry of row.allocations) owed.set(entry.grantId, (owed.get(entry.grantId) ?? 0) + (row.reason === 'chargeback' ? entry.amount : -entry.amount));
  const ids = [...owed].filter(([, amount]) => amount > 0).map(([grantId]) => grantId);
  const grants = ids.length ? await tx.select().from(schema.creditGrant).where(inArray(schema.creditGrant.id, ids)).for('update') : [];
  /* The purchase's own grant first, then the others; a grant that can no longer be spent (an ended Plan period) is not revived. */
  grants.sort((x, y) => Number(y.purchaseId === purchase.id) - Number(x.purchaseId === purchase.id));
  const allocations: Allocation[] = [];
  for (const grant of grants) {
    if (left === 0) break;
    if (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime()) continue;
    const give = Math.min(left, owed.get(grant.id) ?? 0, grant.amount - grant.remaining);
    if (give <= 0) continue;
    allocations.push({ grantId: grant.id, source: grant.source, amount: give });
    left -= give;
  }
  const back = allocations.reduce((sum, entry) => sum + entry.amount, 0);
  await moveGrants(tx, allocations, 1);
  await tx.insert(schema.creditEntry).values({
    userId: purchase.userId,
    delta: back,
    reason: 'chargeback_reverse',
    refId: purchase.id,
    note: [`chargeback_reverse ${adjustment.id}: ${restore} credits`, cancelled ? `${cancelled} of debt cancelled` : '', back ? `${back} back to the grants it was taken from` : '', left ? `${left} not restored (its grant can no longer be spent)` : '']
      .filter(Boolean)
      .join(', '),
    allocations,
    createdAt: now,
  });
  const reversed = purchase.reversedCredits - restore;
  await tx
    .update(schema.purchase)
    .set({
      status: purchase.status === 'chargeback' && reversed === 0 ? 'paid' : purchase.status,
      reversedCredits: reversed,
      adjustmentIds: sql`array_append(${schema.purchase.adjustmentIds}, ${adjustment.id})`,
    })
    .where(eq(schema.purchase.id, purchase.id));
  return 'chargeback_reversed';
}

/**
 * Paddle notifications recorded but not credited because they matched no
 * checkout or subscription of ours (review M5), newest first, with the
 * total: what the console's purchase review should show and act on.
 */
export async function unmatchedBillingEvents(limit = 50): Promise<{
  total: number;
  items: { id: string; eventType: string; receivedAt: Date; transactionId: string | null; userId: string | null; priceIds: string[] }[];
}> {
  const where = eq(schema.billingEvent.outcome, 'unmatched');
  const [counted] = await db().select({ n: count() }).from(schema.billingEvent).where(where);
  const rows = await db()
    .select({ id: schema.billingEvent.id, eventType: schema.billingEvent.eventType, receivedAt: schema.billingEvent.receivedAt, payload: schema.billingEvent.payload })
    .from(schema.billingEvent)
    .where(where)
    .orderBy(desc(schema.billingEvent.receivedAt))
    .limit(Math.min(Math.max(1, limit), 200));
  return {
    total: counted?.n ?? 0,
    items: rows.map((row) => {
      const data = ((row.payload ?? {}) as { data?: { id?: unknown; custom_data?: Record<string, unknown> | null; items?: { price?: { id?: unknown } | null; price_id?: unknown }[]; transaction_id?: unknown } }).data ?? {};
      const transactionId = row.eventType.startsWith('subscription.') ? data.transaction_id : data.id;
      return {
        id: row.id,
        eventType: row.eventType,
        receivedAt: row.receivedAt,
        transactionId: typeof transactionId === 'string' ? transactionId : null,
        userId: customUserId(data.custom_data),
        priceIds: (data.items ?? []).map((item) => item.price?.id ?? item.price_id).filter((id): id is string => typeof id === 'string'),
      };
    }),
  };
}

/* ----------------------------------------------------------------- renewal */

export type RenewalRefusal = 'no_subscription' | 'invalid_action' | 'plan_redeemed_queued';

/**
 * `POST /api/billing/subscription`: turn renewal off (the Plan runs to the
 * end of the period) or back on. Paddle is told first; its answer is
 * mirrored at once, and its webhook will say the same thing again.
 */
export async function setRenewal(
  userId: string,
  action: unknown,
  deps: { config?: PaddleConfig; cancel?: typeof cancelAtPeriodEnd; resume?: typeof resumeRenewal; now?: Date } = {},
): Promise<{ ok: true; cancelAtPeriodEnd: boolean; periodEnd: string | null } | { ok: false; error: RenewalRefusal }> {
  if (action !== 'cancel' && action !== 'resume') return { ok: false, error: 'invalid_action' };
  const now = deps.now ?? new Date();
  const current = await subscriptionOf(db(), userId);
  if (!current || !planIsActive(current, now)) return { ok: false, error: 'no_subscription' };
  const wantCancel = action === 'cancel';
  if (current.cancelAtPeriodEnd === wantCancel) {
    return { ok: true, cancelAtPeriodEnd: wantCancel, periodEnd: current.currentPeriodEnd?.toISOString() ?? null };
  }
  /* A redeemed Plan waits for this period's end; renewing too would charge for a second Plan over the same months. */
  if (!wantCancel && (await redeemedPlansOf(db(), userId, now)).length > 0) return { ok: false, error: 'plan_redeemed_queued' };
  const config = deps.config ?? requirePaddle();
  const entity = wantCancel
    ? await (deps.cancel ?? cancelAtPeriodEnd)(config, current.paddleSubscriptionId)
    : await (deps.resume ?? resumeRenewal)(config, current.paddleSubscriptionId);
  await db().transaction(async (tx) => {
    const [locked] = await tx.select().from(schema.subscription).where(eq(schema.subscription.id, current.id)).for('update');
    await writeSubscription(tx, userId, locked ?? current, entity, now);
  });
  const after = await subscriptionOf(db(), userId);
  return { ok: true, cancelAtPeriodEnd: after?.cancelAtPeriodEnd ?? wantCancel, periodEnd: after?.currentPeriodEnd?.toISOString() ?? null };
}

/* -------------------------------------------------------------------- cron */

/**
 * `GET /api/cron/expire-plan`: the backstop. Writes off Plan credits whose
 * period has ended (a cancelled Plan gets no renewal to do it), and closes
 * cancelled subscriptions whose period is over if Paddle's own `canceled`
 * notification has not arrived. Bounded batches, idempotent.
 */
export async function expireDuePlans(now = new Date(), budgetMs = 240_000): Promise<{ grants: number; subscriptions: number }> {
  const started = Date.now();
  let grants = 0;
  for (;;) {
    const batch = await db().transaction((tx) => expirePlanGrants(tx, { cutoff: now, limit: PLAN_EXPIRY_BATCH }, now));
    grants += batch;
    if (batch < PLAN_EXPIRY_BATCH || Date.now() - started > budgetMs) break;
  }
  const closed = await db()
    .update(schema.subscription)
    .set({ status: 'cancelled', updatedAt: now })
    .where(
      and(
        eq(schema.subscription.status, 'active'),
        eq(schema.subscription.cancelAtPeriodEnd, true),
        lte(schema.subscription.currentPeriodEnd, now),
      ),
    )
    .returning({ id: schema.subscription.id });
  return { grants, subscriptions: closed.length };
}

/* ------------------------------------------------------------ billing page */

export interface BillingSummary {
  total: number;
  buckets: { plan: number; welcome: number; pack: number; earned: number };
  debt: number;
  plan: PlanUsage;
  /** Official accounts see no user-side query income: no earned card, no 收入 tab or rows. */
  official: boolean;
}

/**
 * What the sidebar and the billing tab both read, loaded once per request
 * (React `cache`): spendable grants, the subscription, and the latest Plan
 * grants -- spent to zero or not -- from which the current period's is picked.
 */
const billingRows = cache(async (userId: string) => {
  const executor = db();
  const [grants, subscription, redeemed, planGrants] = await Promise.all([
    grantsOf(executor, userId, false),
    subscriptionOf(executor, userId),
    /* Unfiltered by time: the summary is read at the caller's `now`, and a user holds a handful at most. */
    redeemedPlansOf(executor, userId, null),
    executor
      .select({
        amount: schema.creditGrant.amount,
        remaining: schema.creditGrant.remaining,
        periodStart: schema.creditGrant.periodStart,
        expiresAt: schema.creditGrant.expiresAt,
        createdAt: schema.creditGrant.createdAt,
      })
      .from(schema.creditGrant)
      .where(and(eq(schema.creditGrant.userId, userId), eq(schema.creditGrant.source, 'plan')))
      .orderBy(desc(schema.creditGrant.expiresAt), desc(schema.creditGrant.createdAt))
      .limit(3),
  ]);
  return { grants, subscription, redeemed, planGrants };
});

type PlanGrantRow = Awaited<ReturnType<typeof billingRows>>['planGrants'][number];

/** This period's Plan grant: begun, not yet ended. */
function currentPlanGrant(planGrants: PlanGrantRow[], now: Date): { amount: number; remaining: number } | null {
  return planGrants.find((grant) => (grant.periodStart ?? grant.createdAt).getTime() <= now.getTime() && grant.expiresAt!.getTime() > now.getTime()) ?? null;
}

async function currentPlanUsage(subscription: SubscriptionRow | null, redeemed: RedeemedPlan[], planGrants: PlanGrantRow[], now: Date) {
  const state = planStateFrom(subscription, redeemed, now);
  const grant = currentPlanGrant(planGrants, now);
  /* Before this month's grant arrives: a redeemed Plan's own snapshot, a paid one's current price. */
  const redeemedCredits = state.source === 'redeemed' ? redeemed.find((plan) => redeemedPeriodIndexAt(plan, now) !== null)?.credits : undefined;
  const allowance = !grant && state.active ? (redeemedCredits ?? (await currentUnitCredits(db(), 'plan'))) : undefined;
  return planUsage(state, grant, now, allowance);
}

/**
 * What every workspace page's sidebar shows: the total balance (the billing
 * tab's 总余额), the welcome credits it includes, any open debt, and the
 * Plan meter.
 */
export async function shellBilling(userId: string, now = new Date()): Promise<{ balance: number; welcome: number; debt: number; plan: PlanUsage }> {
  const [{ grants, subscription, redeemed, planGrants }, debt] = await Promise.all([billingRows(userId), openDebt(userId)]);
  return {
    balance: availableOf(grants, now),
    welcome: availableOf(
      grants.filter((grant) => grant.source === 'welcome'),
      now,
    ),
    debt,
    plan: await currentPlanUsage(subscription, redeemed, planGrants, now),
  };
}

/** Credits still owed: a failed run's costs the balance could not cover, a refund taken back after spending. */
async function openDebt(userId: string): Promise<number> {
  const [row] = await db()
    .select({ remaining: sql<number>`coalesce(sum(${schema.creditDebt.remaining}), 0)::bigint` })
    .from(schema.creditDebt)
    .where(and(eq(schema.creditDebt.userId, userId), gt(schema.creditDebt.remaining, 0)));
  return Number(row?.remaining ?? 0);
}

export async function billingSummary(userId: string, now = new Date()): Promise<BillingSummary> {
  const [{ grants, subscription, redeemed, planGrants }, debt, official] = await Promise.all([
    billingRows(userId),
    db()
      .select({ remaining: sql<number>`coalesce(sum(${schema.creditDebt.remaining}), 0)::bigint` })
      .from(schema.creditDebt)
      .where(and(eq(schema.creditDebt.userId, userId), gt(schema.creditDebt.remaining, 0))),
    isOfficial(userId),
  ]);
  const bucket = (source: 'plan' | 'welcome' | 'pack' | 'earned') => availableOf(grants.filter((grant) => grant.source === source), now);
  const buckets = { plan: bucket('plan'), welcome: bucket('welcome'), pack: bucket('pack'), earned: bucket('earned') };
  return {
    total: buckets.plan + buckets.welcome + buckets.pack + buckets.earned,
    buckets,
    debt: Number(debt[0]?.remaining ?? 0),
    plan: await currentPlanUsage(subscription, redeemed, planGrants, now),
    official,
  };
}

/** Whether the account holds the official role, once per request. */
const isOfficial = cache(async (userId: string): Promise<boolean> => {
  const [account] = await db().select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  return account?.role === 'official';
});

export interface EntryRow {
  id: string;
  reason: (typeof schema.creditEntry.$inferSelect)['reason'];
  delta: number;
  note: string | null;
  reeId: string | null;
  refId: string | null;
  /** Credits per source this row moved: what makes every row traceable to its grants. */
  sources: { source: string; amount: number }[];
  createdAt: string;
  reeName: string | null;
}

export interface ActivitySummary {
  spend: number;
  income: number;
  purchases: number;
}

/**
 * `GET /api/billing/entries`: the user's ledger, newest first, filtered by
 * activity, paged on the server. An official account's income rows (query
 * fees earned, payouts) are left out here, so totals and pages stay right,
 * and its `income` filter falls back to `all`.
 */
export async function listEntries(
  userId: string,
  query: { activity: Activity; page: number; size: number; q?: string } & Partial<PeriodFilter>,
): Promise<{ items: EntryRow[]; total: number; page: number; size: number; activity: Activity; summary: ActivitySummary }> {
  const official = await isOfficial(userId);
  const activity = official && query.activity === 'income' ? 'all' : query.activity;
  const range = periodRange({ ...query, period: query.period ?? 'all', date: query.date ?? reportingDate() });
  const pattern = query.q ? likePattern(query.q) : null;
  const scope = and(
    eq(schema.creditEntry.userId, userId),
    official ? notInArray(schema.creditEntry.reason, [...ACTIVITY_REASONS.income]) : undefined,
    range ? gte(schema.creditEntry.createdAt, new Date(range.start)) : undefined,
    range ? lt(schema.creditEntry.createdAt, new Date(range.end)) : undefined,
    pattern ? or(ilike(schema.creditEntry.note, pattern), ilike(schema.ree.name, pattern)) : undefined,
  );
  const where = and(scope, activity === 'all' ? undefined : inArray(schema.creditEntry.reason, [...ACTIVITY_REASONS[activity]]));
  const database = db();
  // Count actual charges at settlement time. Reservations and returns can
  // cross midnight and must never inflate a day's spending.
  const charged = sql`case
    when ${schema.creditEntry.reason} in ('knowledge_settle', 'query_base', 'verify_settle', 'synthesis_settle', 'video_script', 'video_export')
      then coalesce(substring(${schema.creditEntry.note} from 'charged ([0-9]+) of [0-9]+$')::bigint, 0)
    when ${schema.creditEntry.reason} in ('query_fee_paid', 'storage_charge') then greatest(-${schema.creditEntry.delta}, 0)
    else 0 end`;
  const [[counted], [summary]] = await Promise.all([
    database.select({ total: count() }).from(schema.creditEntry).leftJoin(schema.ree, eq(schema.ree.id, schema.creditEntry.reeId)).where(where),
    database.select({
      spend: sql<number>`coalesce(sum(${charged}), 0)::bigint`,
      income: sql<number>`coalesce(sum(case when ${schema.creditEntry.reason} = 'query_fee_earned' then ${schema.creditEntry.delta} else 0 end), 0)::bigint`,
      purchases: sql<number>`coalesce(sum(case when ${schema.creditEntry.reason} = 'purchase' then ${schema.creditEntry.delta} else 0 end), 0)::bigint`,
    }).from(schema.creditEntry).leftJoin(schema.ree, eq(schema.ree.id, schema.creditEntry.reeId)).where(scope),
  ]);
  const total = counted?.total ?? 0;
  const page = clampPage(query.page, total, query.size);
  const rows = await database
    .select({ entry: schema.creditEntry, reeName: schema.ree.name })
    .from(schema.creditEntry)
    .leftJoin(schema.ree, eq(schema.ree.id, schema.creditEntry.reeId))
    .where(where)
    .orderBy(desc(schema.creditEntry.createdAt), desc(schema.creditEntry.id))
    .limit(query.size)
    .offset((page - 1) * query.size);
  return {
    items: rows.map(({ entry: row, reeName }) => {
      const sources = new Map<string, number>();
      for (const allocation of row.allocations) sources.set(allocation.source, (sources.get(allocation.source) ?? 0) + allocation.amount);
      return {
        id: row.id,
        reason: row.reason,
        delta: row.delta,
        note: row.note,
        reeId: row.reeId,
        refId: row.refId,
        sources: [...sources].map(([source, amount]) => ({ source, amount })),
        createdAt: row.createdAt.toISOString(),
        reeName,
      };
    }),
    total,
    page,
    size: query.size,
    activity,
    summary: { spend: Number(summary?.spend ?? 0), income: Number(summary?.income ?? 0), purchases: Number(summary?.purchases ?? 0) },
  };
}

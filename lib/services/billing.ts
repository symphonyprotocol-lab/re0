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
import { and, count, desc, eq, gt, inArray, lte, notInArray, sql } from 'drizzle-orm';
import { CHECKOUT_REUSE_MS, PACK, PLAN_EXPIRY_BATCH } from '@/lib/constants';
import {
  ACTIVITY_REASONS,
  creditsFor,
  parseOrder,
  planIsActive,
  priceMinorFor,
  planUsage,
  reversalCredits,
  subscriptionStatusFrom,
  takeBack,
  type Activity,
  type CheckoutOrder,
  type PlanUsage,
  type PurchaseKind,
} from '@/lib/domain/billing';
import { availableOf } from '@/lib/domain/credits';
import { clampPage } from '@/lib/domain/list';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import {
  cancelAtPeriodEnd,
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

export async function hasActivePlan(executor: Executor, userId: string, now = new Date()): Promise<boolean> {
  return planIsActive(await subscriptionOf(executor, userId), now);
}

/* ---------------------------------------------------------------- checkout */

export type CheckoutRefusal =
  | 'invalid_kind'
  | 'invalid_quantity'
  | 'consent_required'
  | 'plan_required'
  | 'already_subscribed'
  | 'renewal_pending';

export interface CheckoutDeps {
  config?: PaddleConfig;
  create?: typeof createCheckoutTransaction;
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
  input: { kind?: unknown; quantity?: unknown; consent?: unknown },
  deps: CheckoutDeps = {},
): Promise<{ ok: true; transactionId: string; order: CheckoutOrder } | { ok: false; error: CheckoutRefusal }> {
  const order = parseOrder(input);
  if ('error' in order) return { ok: false, error: order.error };
  if (input.consent !== true) return { ok: false, error: 'consent_required' };
  const now = deps.now ?? new Date();
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`checkout:${userId}`}))`);
    if (order.kind === 'pack' && !planIsActive(await subscriptionOf(tx, userId), now)) return { ok: false as const, error: 'plan_required' as const };
    if (order.kind === 'plan') {
      const live = await tx
        .select({ status: schema.subscription.status })
        .from(schema.subscription)
        .where(and(eq(schema.subscription.userId, userId), inArray(schema.subscription.status, ['active', 'expired'])));
      if (live.some((row) => row.status === 'active')) return { ok: false as const, error: 'already_subscribed' as const };
      if (live.length > 0) return { ok: false as const, error: 'renewal_pending' as const };
      const [open] = await tx
        .select({ id: schema.paddleCheckout.paddleTransactionId })
        .from(schema.paddleCheckout)
        .where(
          and(
            eq(schema.paddleCheckout.userId, userId),
            eq(schema.paddleCheckout.kind, 'plan'),
            gt(schema.paddleCheckout.createdAt, new Date(now.getTime() - CHECKOUT_REUSE_MS)),
          ),
        )
        .orderBy(desc(schema.paddleCheckout.createdAt))
        .limit(1);
      if (open) return { ok: true as const, transactionId: open.id, order };
    }
    const config = deps.config ?? requirePaddle();
    const transaction = await (deps.create ?? createCheckoutTransaction)(config, order, userId);
    await tx.insert(schema.paddleCheckout).values({ paddleTransactionId: transaction.id, userId, kind: order.kind, quantity: order.quantity, createdAt: now });
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

type Prices = Pick<PaddleConfig, 'planPriceId' | 'packPriceId'>;

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

function kindOf(transaction: PaddleTransaction, prices: Prices): PurchaseKind | null {
  const priceIds = transaction.items.map((item) => item.price?.id ?? item.price_id);
  if (priceIds.includes(prices.planPriceId)) return 'plan';
  if (priceIds.includes(prices.packPriceId)) return 'pack';
  return null;
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

/**
 * A paid transaction: one purchase, one grant. A Plan payment -- the first
 * or a renewal -- grants the period's 100,000 credits expiring at the
 * period's end, and writes off what is left of earlier periods (the renewal
 * is when a period ends, 8.3). A Pack grants 100,000 per pack, no expiry.
 */
async function creditTransaction(tx: Tx, transaction: PaddleTransaction, prices: Prices, now: Date): Promise<string> {
  const kind = kindOf(transaction, prices);
  if (!kind) return 'ignored';
  const [existing] = await tx
    .select({ id: schema.purchase.id })
    .from(schema.purchase)
    .where(eq(schema.purchase.paddleTransactionId, transaction.id))
    .limit(1);
  if (existing) return 'already_credited';
  const subscription = await subscriptionByPaddleId(tx, transaction.subscription_id);
  const userId = customUserId(transaction.custom_data) ?? subscription?.userId ?? null;
  if (!userId) throw new RetryLater(`transaction ${transaction.id} names no buyer yet`);
  /*
   * Credited as paid. Checkout only sells 1–10 Packs and the Paddle price
   * caps the overlay's quantity at 10, so anything else means the price was
   * changed in Paddle: the buyer still gets what they paid for, and we hear about it.
   */
  const quantity = kind === 'plan' ? 1 : (transaction.items[0]?.quantity ?? 1);
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`transaction ${transaction.id} has quantity ${quantity}`);
  if (quantity > PACK.maxQuantity) console.warn(`transaction ${transaction.id}: ${quantity} packs, beyond the checkout's ${PACK.maxQuantity}`);
  const order: CheckoutOrder = { kind, quantity };
  const credits = creditsFor(order);
  let amount = minorUnits(transaction.details?.totals?.grand_total);
  if (!Number.isFinite(amount)) {
    /* Never 0: a zero would make every later refund read as a full one. */
    console.warn(`transaction ${transaction.id} has no readable total; recording the list price`);
    amount = priceMinorFor(order);
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
  if (entity.items?.length && !entity.items.some((item) => item.price?.id === prices.planPriceId)) return 'ignored';
  const existing = await subscriptionByPaddleId(tx, entity.id);
  let userId = existing?.userId ?? customUserId(entity.custom_data);
  if (!userId && entity.transaction_id) {
    const [origin] = await tx
      .select({ userId: schema.purchase.userId })
      .from(schema.purchase)
      .where(eq(schema.purchase.paddleTransactionId, entity.transaction_id))
      .limit(1);
    userId = origin?.userId ?? null;
  }
  if (!userId) throw new RetryLater(`subscription ${entity.id} names no buyer yet`);
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
 * purchase's credits: from what is left of that purchase first, then the
 * rest of the balance in spending order; what is already spent becomes a
 * debt the next credits pay off (2.3). The balance never goes negative.
 */
async function applyAdjustment(tx: Tx, adjustment: PaddleAdjustment, now: Date): Promise<string> {
  if (adjustment.status !== 'approved') return 'ignored';
  if (adjustment.action !== 'refund' && adjustment.action !== 'chargeback') return 'ignored';
  const [purchase] = await tx
    .select()
    .from(schema.purchase)
    .where(eq(schema.purchase.paddleTransactionId, adjustment.transaction_id))
    .for('update');
  if (!purchase) return 'ignored';
  if (purchase.adjustmentIds.includes(adjustment.id)) return 'already_reversed';
  const credits = reversalCredits(purchase, minorUnits(adjustment.totals?.total));
  const chargeback = adjustment.action === 'chargeback';
  if (credits > 0) {
    const [own] = await tx
      .select({ id: schema.creditGrant.id })
      .from(schema.creditGrant)
      .where(eq(schema.creditGrant.purchaseId, purchase.id))
      .limit(1);
    const grants = await grantsOf(tx, purchase.userId, true);
    const { allocations, shortfall } = takeBack(grants, own?.id ?? null, credits, now);
    await moveGrants(tx, allocations, -1);
    await tx.insert(schema.creditEntry).values({
      userId: purchase.userId,
      delta: -(credits - shortfall),
      reason: chargeback ? 'chargeback' : 'refund',
      refId: purchase.id,
      note: `${adjustment.action} ${adjustment.id}: ${credits} credits${shortfall ? `, ${shortfall} owed` : ''}`,
      allocations,
      createdAt: now,
    });
    if (shortfall > 0) {
      await tx.insert(schema.creditDebt).values({
        userId: purchase.userId,
        amount: shortfall,
        remaining: shortfall,
        purchaseId: purchase.id,
        createdAt: now,
      });
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

/* ----------------------------------------------------------------- renewal */

export type RenewalRefusal = 'no_subscription' | 'invalid_action';

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
  const [grants, subscription, planGrants] = await Promise.all([
    grantsOf(executor, userId, false),
    subscriptionOf(executor, userId),
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
  return { grants, subscription, planGrants };
});

type PlanGrantRow = Awaited<ReturnType<typeof billingRows>>['planGrants'][number];

/** This period's Plan grant: begun, not yet ended. */
function currentPlanGrant(planGrants: PlanGrantRow[], now: Date): { amount: number; remaining: number } | null {
  return planGrants.find((grant) => (grant.periodStart ?? grant.createdAt).getTime() <= now.getTime() && grant.expiresAt!.getTime() > now.getTime()) ?? null;
}

/** What every workspace page's sidebar shows: the balance and the Plan meter. */
export async function shellBilling(userId: string, now = new Date()): Promise<{ balance: number; plan: PlanUsage }> {
  const { grants, subscription, planGrants } = await billingRows(userId);
  return { balance: availableOf(grants, now), plan: planUsage(subscription, currentPlanGrant(planGrants, now), now) };
}

export async function billingSummary(userId: string, now = new Date()): Promise<BillingSummary> {
  const [{ grants, subscription, planGrants }, debt, official] = await Promise.all([
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
    plan: planUsage(subscription, currentPlanGrant(planGrants, now), now),
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
}

/**
 * `GET /api/billing/entries`: the user's ledger, newest first, filtered by
 * activity, paged on the server. An official account's income rows (query
 * fees earned, payouts) are left out here, so totals and pages stay right,
 * and its `income` filter falls back to `all`.
 */
export async function listEntries(
  userId: string,
  query: { activity: Activity; page: number; size: number },
): Promise<{ items: EntryRow[]; total: number; page: number; size: number; activity: Activity }> {
  const official = await isOfficial(userId);
  const activity = official && query.activity === 'income' ? 'all' : query.activity;
  const where = and(
    eq(schema.creditEntry.userId, userId),
    activity === 'all' ? undefined : inArray(schema.creditEntry.reason, [...ACTIVITY_REASONS[activity]]),
    official ? notInArray(schema.creditEntry.reason, [...ACTIVITY_REASONS.income]) : undefined,
  );
  const [{ total }] = (await db().select({ total: count() }).from(schema.creditEntry).where(where)) as [{ total: number }];
  const page = clampPage(query.page, total, query.size);
  const rows = await db()
    .select()
    .from(schema.creditEntry)
    .where(where)
    .orderBy(desc(schema.creditEntry.createdAt), desc(schema.creditEntry.id))
    .limit(query.size)
    .offset((page - 1) * query.size);
  return {
    items: rows.map((row) => {
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
      };
    }),
    total,
    page,
    size: query.size,
    activity,
  };
}

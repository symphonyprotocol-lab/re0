/**
 * Channel subscriptions: plans, access, checkout, and the ledger the
 * provider's notifications write. agent-first-proposal.md 6.9-6.11, 8.1.
 *
 * - A channel sells nothing until its owner switches subscriptions on,
 *   which needs the paid-distribution rights confirmation (6.11), and only
 *   a public, active, workspace-owned channel can.
 * - Plans are immutable versions: setting a price mints a version and
 *   retires the previous one of that interval, so it affects new
 *   subscriptions only. The fee rate is the console's at that moment and is
 *   frozen on the version. Any one transaction is at least the console's
 *   minimum, monthly or yearly -- checked when the plan is set and again at
 *   checkout, so a raised minimum stops a cheaper old plan selling.
 * - A negative creator balance blocks new paid plans (6.9).
 * - A subscription is the user's; their personal workspace reads `paid`
 *   assets while it grants access (`grantsAccess`, `subscribedPaid`).
 * - The provider is Paddle, sold through re0's own account as a recurring
 *   non-catalogue price (architecture.md 11.3). A collected transaction
 *   writes the creator's share of the ex-tax subtotal to `earning_event`;
 *   a refund or chargeback writes the negative and, for the current
 *   period, revokes access at once. The first subscription raises the
 *   subscriber to the extended storage tier (8.1).
 */
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { isAssetAccess } from '@/lib/domain/asset-kind';
import {
  ACCESS_STATUSES,
  assertSellablePrice,
  CHANNEL_CURRENCY,
  ChannelCommerceRefused,
  channelSaleMismatch,
  creatorShareBps,
  creatorShareMinor,
  grantsAccess,
  isPlanInterval,
  planPriceMinor,
  type ChannelSubscriptionStatus,
  type PlanInterval,
} from '@/lib/domain/channel-commerce';
import { uuidv7 } from '@/lib/domain/id';
import {
  paymentAdapter,
  PaymentNotConfigured,
  PaymentProviderError,
  type ChannelSubscriptionNotice,
  type ChannelTransactionNotice,
  type PaymentAdapter,
} from '@/lib/infrastructure/payment/provider';
import { db, schema, type Database } from '@/lib/infrastructure/postgres/client';
import { activeCommerceSettings } from '@/lib/application/administration/manage-commerce-config';
import { canManageAssets, type WorkspaceRole } from '@/lib/application/assets/delete';
import type { Tx } from '@/lib/application/plans/quota';
import { extendUserStorageTier } from '@/lib/application/plans/storage';
import { hasNegativeBalance, openPeriodId } from '@/lib/application/revenue/balance';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Executor = Tx | Database;

/* ------------------------------------------------------------------ access */

/** Whether this workspace reads the channel's `paid` assets right now. */
export async function subscribesTo(
  workspaceId: string | null,
  channelId: string,
  executor: Executor = db(),
): Promise<boolean> {
  if (!workspaceId) return false;
  const rows = await executor
    .select({ status: schema.channelSubscription.status, currentPeriodEnd: schema.channelSubscription.currentPeriodEnd })
    .from(schema.channelSubscription)
    .where(and(eq(schema.channelSubscription.workspaceId, workspaceId), eq(schema.channelSubscription.channelId, channelId)));
  const now = new Date();
  return rows.some((row) => grantsAccess(row, now));
}

/**
 * A subscription that is not over: it still reads (`grantsAccess`), or the
 * provider may still bill it -- not canceled there and not set to end with
 * its period. A past-due one whose period has run out reads nothing but may
 * still be collected; a refunded one may still renew until its provider
 * subscription is canceled. A new checkout for the same channel would bill
 * twice, and deleting the channel would leave it billing for nothing.
 */
export function liveSubscription(now: Date) {
  return or(
    and(
      inArray(schema.channelSubscription.status, [...ACCESS_STATUSES]),
      gt(schema.channelSubscription.currentPeriodEnd, now),
    ),
    and(ne(schema.channelSubscription.status, 'canceled'), eq(schema.channelSubscription.cancelAtPeriodEnd, false)),
  )!;
}

/**
 * The creator's per-subscriber daily cap (proposal 6.10), when they set one:
 * a subscriber's workspace may read the channel this many times per UTC day
 * -- every billed retrieval, `search_context`, `ask` or the twin, counted by
 * its usage events on the channel's assets. Off by default; the owner and
 * non-subscribers are not capped by it (a non-subscriber reads free assets
 * only, metered on their own workspace like any read). Soft under a race:
 * two reads at the cap's edge may both pass, never more.
 */
export async function assertUnderSubscriberCap(workspaceId: string, channelId: string): Promise<void> {
  const database = db();
  const [channel] = await database
    .select({ limit: schema.channel.subscriberDailyLimit, owner: schema.channel.workspaceId })
    .from(schema.channel)
    .where(eq(schema.channel.id, channelId));
  if (!channel?.limit || channel.owner === workspaceId) return;
  if (!(await subscribesTo(workspaceId, channelId, database))) return;
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [used] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.usageEvent)
    .where(
      and(
        eq(schema.usageEvent.workspaceId, workspaceId),
        sql`${schema.usageEvent.createdAt} >= ${dayStart}`,
        inArray(
          schema.usageEvent.assetId,
          database.select({ id: schema.channelAsset.assetId }).from(schema.channelAsset).where(eq(schema.channelAsset.channelId, channelId)),
        ),
      ),
    );
  if ((used?.n ?? 0) >= channel.limit) {
    throw new AppError('quota_exceeded', `this channel allows ${channel.limit} reads per subscriber per day (UTC); retry tomorrow`);
  }
}

/* ------------------------------------------------------------------- plans */

export interface ChannelPlan {
  id: string;
  interval: PlanInterval;
  priceMinor: number;
  currency: string;
  feeRateBps: number;
  effectiveFrom: Date;
}

export interface ChannelCommerce {
  subscriptionsEnabled: boolean;
  rightsConfirmedAt: Date | null;
  subscriberDailyLimit: number | null;
  plans: ChannelPlan[];
  activeSubscribers: number;
}

/** The plans on sale: the newest unretired version of each interval. */
export async function channelPlans(channelId: string, executor: Executor = db()): Promise<ChannelPlan[]> {
  const rows = await executor
    .select({
      id: schema.channelPlanVersion.id,
      interval: schema.channelPlanVersion.interval,
      priceMinor: schema.channelPlanVersion.priceMinor,
      currency: schema.channelPlanVersion.currency,
      feeRateBps: schema.channelPlanVersion.feeRateBps,
      effectiveFrom: schema.channelPlanVersion.effectiveFrom,
    })
    .from(schema.channelPlanVersion)
    .where(and(eq(schema.channelPlanVersion.channelId, channelId), isNull(schema.channelPlanVersion.retiredAt)))
    .orderBy(desc(schema.channelPlanVersion.effectiveFrom), desc(schema.channelPlanVersion.id));
  const byInterval = new Map<PlanInterval, ChannelPlan>();
  for (const row of rows) if (!byInterval.has(row.interval)) byInterval.set(row.interval, row);
  return (['month', 'year'] as const).flatMap((interval) => (byInterval.has(interval) ? [byInterval.get(interval)!] : []));
}

export async function channelCommerce(channelId: string): Promise<ChannelCommerce> {
  const database = db();
  const [[channel], plans, [subscribers]] = await Promise.all([
    database
      .select({
        enabledAt: schema.channel.subscriptionsEnabledAt,
        rightsConfirmedAt: schema.channel.paidRightsConfirmedAt,
        subscriberDailyLimit: schema.channel.subscriberDailyLimit,
      })
      .from(schema.channel)
      .where(eq(schema.channel.id, channelId)),
    channelPlans(channelId),
    database
      .select({ n: sql<number>`count(distinct ${schema.channelSubscription.userId})::int` })
      .from(schema.channelSubscription)
      .where(
        and(
          eq(schema.channelSubscription.channelId, channelId),
          inArray(schema.channelSubscription.status, ['active', 'past_due', 'canceled']),
          sql`${schema.channelSubscription.currentPeriodEnd} > now()`,
        ),
      ),
  ]);
  return {
    subscriptionsEnabled: channel?.enabledAt != null,
    rightsConfirmedAt: channel?.rightsConfirmedAt ?? null,
    subscriberDailyLimit: channel?.subscriberDailyLimit ?? null,
    plans,
    activeSubscribers: subscribers?.n ?? 0,
  };
}

interface OwnerInput {
  workspaceId: string;
  role: WorkspaceRole;
  channelId: string;
}

async function lockOwnedChannel(tx: Tx, input: OwnerInput) {
  if (!canManageAssets(input.role)) throw new ChannelCommerceRefused('not_owner', 'only a workspace owner or admin can sell a channel');
  if (!UUID.test(input.channelId)) throw new ChannelCommerceRefused('not_found', 'no such channel');
  const [channel] = await tx
    .select({
      id: schema.channel.id,
      title: schema.channel.title,
      workspaceId: schema.channel.workspaceId,
      visibility: schema.channel.visibility,
      status: schema.channel.status,
      enabledAt: schema.channel.subscriptionsEnabledAt,
    })
    .from(schema.channel)
    .where(and(eq(schema.channel.id, input.channelId), eq(schema.channel.workspaceId, input.workspaceId)))
    .for('update');
  if (!channel) throw new ChannelCommerceRefused('not_found', 'no such channel');
  return channel;
}

/**
 * Switches subscriptions on. The owner confirms they own, or are licensed to
 * distribute for payment, what the channel holds (proposal 6.11); without
 * that confirmation nothing changes. Idempotent.
 */
export async function enableSubscriptions(input: OwnerInput & { userId: string; confirmRights: boolean }): Promise<void> {
  if (!input.confirmRights) {
    throw new ChannelCommerceRefused('rights_confirmation_required', 'confirm that you may distribute this content for payment');
  }
  await db().transaction(async (tx) => {
    const channel = await lockOwnedChannel(tx, input);
    if (channel.visibility !== 'public' || channel.status !== 'active') {
      throw new ChannelCommerceRefused('not_sellable', 'only a public, active channel can sell subscriptions');
    }
    if (channel.enabledAt) return;
    const now = new Date();
    await tx
      .update(schema.channel)
      .set({ subscriptionsEnabledAt: now, paidRightsConfirmedAt: now, paidRightsConfirmedBy: input.userId, updatedAt: now })
      .where(eq(schema.channel.id, channel.id));
    /*
     * The creator's account in the income ledger: the monthly close writes
     * statements only for workspaces that have one. Accepting the channel
     * seller terms here is what entering the programme now means.
     */
    await tx
      .insert(schema.publisherAccount)
      .values({ id: uuidv7(), workspaceId: input.workspaceId, agreementVersion: CHANNEL_SELLER_AGREEMENT })
      .onConflictDoNothing({ target: schema.publisherAccount.workspaceId });
  });
}

/** The terms a creator accepts by switching subscriptions on: the 6.11 confirmation and the 6.9 payout rules. */
export const CHANNEL_SELLER_AGREEMENT = 'channel-subscriptions-2026-10';

/**
 * Sets the price of one interval: a new immutable version, the previous one
 * of that interval retired. Existing subscriptions stay on the version they
 * bought. Refused below the minimum for any one transaction, and while the
 * creator's balance is negative.
 */
export async function setChannelPlan(
  input: OwnerInput & { userId: string; interval: unknown; price: unknown },
): Promise<ChannelPlan> {
  if (!isPlanInterval(input.interval)) throw new ChannelCommerceRefused('invalid_interval', 'a plan is monthly or yearly');
  const interval = input.interval;
  const settings = await activeCommerceSettings();
  const priceMinor = typeof input.price === 'number' && Number.isInteger(input.price)
    ? assertSellablePrice(input.price, settings.minPriceMinor)
    : planPriceMinor(input.price, settings.minPriceMinor);

  return db().transaction(async (tx) => {
    const channel = await lockOwnedChannel(tx, input);
    if (!channel.enabledAt) throw new ChannelCommerceRefused('subscriptions_disabled', 'switch subscriptions on first');
    if (channel.visibility !== 'public' || channel.status !== 'active') {
      throw new ChannelCommerceRefused('not_sellable', 'only a public, active channel can sell subscriptions');
    }
    if (await hasNegativeBalance(input.workspaceId, tx)) {
      throw new ChannelCommerceRefused('negative_balance', 'the balance is negative; no new paid plan until it clears');
    }
    const now = new Date();
    await tx
      .update(schema.channelPlanVersion)
      .set({ retiredAt: now })
      .where(
        and(
          eq(schema.channelPlanVersion.channelId, channel.id),
          eq(schema.channelPlanVersion.interval, interval),
          isNull(schema.channelPlanVersion.retiredAt),
        ),
      );
    const plan = {
      id: uuidv7(),
      interval,
      priceMinor,
      currency: CHANNEL_CURRENCY,
      feeRateBps: settings.feeRateBps,
      effectiveFrom: now,
    };
    await tx.insert(schema.channelPlanVersion).values({ ...plan, channelId: channel.id, createdBy: input.userId });
    return plan;
  });
}

/** Stops selling one interval; its subscribers keep what they bought. */
export async function retireChannelPlan(input: OwnerInput & { interval: unknown }): Promise<void> {
  if (!isPlanInterval(input.interval)) throw new ChannelCommerceRefused('invalid_interval', 'a plan is monthly or yearly');
  const interval = input.interval;
  await db().transaction(async (tx) => {
    const channel = await lockOwnedChannel(tx, input);
    await tx
      .update(schema.channelPlanVersion)
      .set({ retiredAt: new Date() })
      .where(
        and(
          eq(schema.channelPlanVersion.channelId, channel.id),
          eq(schema.channelPlanVersion.interval, interval),
          isNull(schema.channelPlanVersion.retiredAt),
        ),
      );
  });
}

/**
 * The creator's per-subscriber daily retrieval cap (proposal 6.10): off by
 * default; a positive whole number turns it on, null turns it off.
 */
export async function setSubscriberDailyLimit(input: OwnerInput & { limit: number | null }): Promise<void> {
  const limit = input.limit;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100_000)) {
    throw new AppError('invalid_request', 'a daily limit is a whole number from 1 to 100000, or none');
  }
  await db().transaction(async (tx) => {
    const channel = await lockOwnedChannel(tx, input);
    await tx.update(schema.channel).set({ subscriberDailyLimit: limit, updatedAt: new Date() }).where(eq(schema.channel.id, channel.id));
  });
}

/**
 * Marks one asset of the channel `free` or `paid` (proposal 6.2). `paid`
 * needs subscriptions switched on: a paid asset in a channel that sells
 * nothing would be readable by its owner alone.
 */
export async function setAssetAccess(input: {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
  access: unknown;
}): Promise<void> {
  if (!canManageAssets(input.role)) throw new ChannelCommerceRefused('not_owner', 'only a workspace owner or admin can change access');
  if (!isAssetAccess(input.access)) throw new AppError('invalid_request', 'access is free or paid');
  const access = input.access;
  if (!UUID.test(input.assetId)) throw new ChannelCommerceRefused('not_found', 'no such asset');
  await db().transaction(async (tx) => {
    const [row] = await tx
      .select({ channelId: schema.channelAsset.channelId, enabledAt: schema.channel.subscriptionsEnabledAt })
      .from(schema.channelAsset)
      .innerJoin(schema.asset, eq(schema.asset.id, schema.channelAsset.assetId))
      .innerJoin(schema.channel, eq(schema.channel.id, schema.channelAsset.channelId))
      .where(
        and(
          eq(schema.channelAsset.assetId, input.assetId),
          eq(schema.asset.ownerWorkspaceId, input.workspaceId),
          isNull(schema.asset.deletedAt),
        ),
      )
      .for('update', { of: schema.channelAsset });
    if (!row) throw new ChannelCommerceRefused('not_found', 'the asset is in none of your channels');
    if (access === 'paid' && !row.enabledAt) {
      throw new ChannelCommerceRefused('subscriptions_disabled', 'switch subscriptions on for this channel first');
    }
    await tx.update(schema.asset).set({ access }).where(eq(schema.asset.id, input.assetId));
  });
}

/* ---------------------------------------------------------------- checkout */

export interface SubscriberInput {
  userId: string;
  /** The subscriber's personal workspace, which the subscription lets read. */
  workspaceId: string;
}

/**
 * Opens a checkout for one plan of a channel. Refuses the owner's own
 * channel, a channel that does not sell (any more), a plan below today's
 * minimum, and a reader who already holds a live subscription -- one that
 * reads, or one the provider may still renew (`liveSubscription`).
 */
export async function startChannelCheckout(
  input: SubscriberInput & { channelId: string; interval: unknown },
  adapter?: PaymentAdapter,
): Promise<string> {
  if (!isPlanInterval(input.interval)) throw new ChannelCommerceRefused('invalid_interval', 'a plan is monthly or yearly');
  if (!UUID.test(input.channelId)) throw new ChannelCommerceRefused('not_found', 'no such channel');
  const database = db();
  const [channel] = await database
    .select({
      id: schema.channel.id,
      title: schema.channel.title,
      workspaceId: schema.channel.workspaceId,
      visibility: schema.channel.visibility,
      status: schema.channel.status,
      enabledAt: schema.channel.subscriptionsEnabledAt,
    })
    .from(schema.channel)
    .where(eq(schema.channel.id, input.channelId));
  if (!channel || channel.visibility !== 'public' || channel.status !== 'active') {
    throw new ChannelCommerceRefused('not_found', 'no such channel');
  }
  if (!channel.enabledAt || !channel.workspaceId) throw new ChannelCommerceRefused('subscriptions_disabled', 'this channel does not sell subscriptions');
  if (channel.workspaceId === input.workspaceId) throw new ChannelCommerceRefused('own_channel', 'this is your own channel');
  const plan = (await channelPlans(channel.id)).find((candidate) => candidate.interval === input.interval);
  if (!plan) throw new ChannelCommerceRefused('no_plan', 'this channel has no such plan');
  /* The floor holds at the moment of sale too: a minimum raised since the plan was set stops it selling. */
  const settings = await activeCommerceSettings();
  assertSellablePrice(plan.priceMinor, settings.minPriceMinor);
  const [live] = await database
    .select({ id: schema.channelSubscription.id })
    .from(schema.channelSubscription)
    .where(
      and(
        eq(schema.channelSubscription.userId, input.userId),
        eq(schema.channelSubscription.channelId, channel.id),
        liveSubscription(new Date()),
      ),
    )
    .limit(1);
  if (live) {
    throw new ChannelCommerceRefused('already_subscribed', 'you already subscribe to this channel, or a subscription of yours may still renew');
  }

  let provider: PaymentAdapter;
  try {
    provider = adapter ?? paymentAdapter();
  } catch {
    throw new ChannelCommerceRefused('not_connected', 'payments are not connected');
  }
  try {
    const created = await provider.createChannelCheckout({
      channelPlanVersionId: plan.id,
      channelId: channel.id,
      userId: input.userId,
      workspaceId: input.workspaceId,
      interval: plan.interval,
      priceMinor: plan.priceMinor,
      currency: plan.currency,
      name: `${channel.title} (re0 channel)`,
      customerId: await subscriberCustomer(input.userId),
    });
    return created.url;
  } catch (error) {
    if (error instanceof PaymentNotConfigured) throw new ChannelCommerceRefused('not_connected', 'channel checkout is not connected');
    throw error;
  }
}

async function subscriberCustomer(userId: string): Promise<string | null> {
  const [row] = await db()
    .select({ customerId: schema.channelSubscription.providerCustomerId })
    .from(schema.channelSubscription)
    .where(and(eq(schema.channelSubscription.userId, userId), sql`${schema.channelSubscription.providerCustomerId} is not null`))
    .orderBy(desc(schema.channelSubscription.createdAt))
    .limit(1);
  return row?.customerId ?? null;
}

/**
 * Cancels at the end of the period: the provider stops renewing and access
 * runs until `current_period_end` (proposal 6.9). Only the subscriber may.
 */
export async function cancelChannelSubscription(
  input: { userId: string; subscriptionId: string },
  adapter?: PaymentAdapter,
): Promise<void> {
  if (!UUID.test(input.subscriptionId)) throw new ChannelCommerceRefused('not_subscribed', 'no such subscription');
  const [row] = await db()
    .select({ id: schema.channelSubscription.id, providerSubscriptionId: schema.channelSubscription.providerSubscriptionId })
    .from(schema.channelSubscription)
    .where(and(eq(schema.channelSubscription.id, input.subscriptionId), eq(schema.channelSubscription.userId, input.userId)));
  if (!row) throw new ChannelCommerceRefused('not_subscribed', 'no such subscription');
  if (row.providerSubscriptionId) {
    let provider: PaymentAdapter;
    try {
      provider = adapter ?? paymentAdapter();
    } catch {
      throw new ChannelCommerceRefused('not_connected', 'payments are not connected');
    }
    await provider.cancelSubscription(row.providerSubscriptionId);
  }
  await db()
    .update(schema.channelSubscription)
    .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
    .where(eq(schema.channelSubscription.id, row.id));
}

/* ------------------------------------------------------------------- reads */

export interface MySubscription {
  id: string;
  channel: { id: string; slug: string; title: string };
  interval: PlanInterval;
  priceMinor: number;
  currency: string;
  status: ChannelSubscriptionStatus;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  grantsAccess: boolean;
}

/** The subscriber's view: every channel this user subscribes or subscribed to. */
export async function mySubscriptions(userId: string): Promise<MySubscription[]> {
  const rows = await db()
    .select({
      id: schema.channelSubscription.id,
      channelId: schema.channel.id,
      slug: schema.channel.slug,
      title: schema.channel.title,
      interval: schema.channelPlanVersion.interval,
      priceMinor: schema.channelPlanVersion.priceMinor,
      currency: schema.channelPlanVersion.currency,
      status: schema.channelSubscription.status,
      currentPeriodEnd: schema.channelSubscription.currentPeriodEnd,
      cancelAtPeriodEnd: schema.channelSubscription.cancelAtPeriodEnd,
    })
    .from(schema.channelSubscription)
    .innerJoin(schema.channel, eq(schema.channel.id, schema.channelSubscription.channelId))
    .innerJoin(schema.channelPlanVersion, eq(schema.channelPlanVersion.id, schema.channelSubscription.planVersionId))
    .where(eq(schema.channelSubscription.userId, userId))
    .orderBy(desc(schema.channelSubscription.currentPeriodEnd));
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    channel: { id: row.channelId, slug: row.slug, title: row.title },
    interval: row.interval,
    priceMinor: row.priceMinor,
    currency: row.currency,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    grantsAccess: grantsAccess(row, now),
  }));
}

/** The users who read a channel's paid assets right now: whom a new post notifies. */
export async function activeSubscriberUsers(channelId: string, executor: Executor = db()): Promise<string[]> {
  const rows = await executor
    .selectDistinct({ userId: schema.channelSubscription.userId })
    .from(schema.channelSubscription)
    .where(
      and(
        eq(schema.channelSubscription.channelId, channelId),
        inArray(schema.channelSubscription.status, ['active', 'past_due', 'canceled']),
        sql`${schema.channelSubscription.currentPeriodEnd} > now()`,
      ),
    );
  return rows.map((row) => row.userId);
}

/* ----------------------------------------------------------------- webhook */

export type ChannelWebhookOutcome = 'applied' | 'stale' | 'unresolved' | 'refused';

/** What booking a channel sale or its reversal needs: whose income, from which channel, at what share. */
interface LedgerFacts {
  ownerWorkspaceId: string;
  channelId: string;
  shareBps: number;
}

interface PlanFacts {
  id: string;
  channelId: string;
  feeRateBps: number;
  priceMinor: number;
  currency: string;
  ownerWorkspaceId: string;
}

async function planFacts(tx: Tx, planVersionId: string): Promise<PlanFacts | null> {
  const [row] = await tx
    .select({
      id: schema.channelPlanVersion.id,
      channelId: schema.channelPlanVersion.channelId,
      feeRateBps: schema.channelPlanVersion.feeRateBps,
      priceMinor: schema.channelPlanVersion.priceMinor,
      currency: schema.channelPlanVersion.currency,
      ownerWorkspaceId: schema.channel.workspaceId,
    })
    .from(schema.channelPlanVersion)
    .innerJoin(schema.channel, eq(schema.channel.id, schema.channelPlanVersion.channelId))
    .where(eq(schema.channelPlanVersion.id, planVersionId));
  if (!row || !row.ownerWorkspaceId) return null;
  return { ...row, ownerWorkspaceId: row.ownerWorkspaceId };
}

/**
 * The ledger facts of a transaction whose plan version is gone with its
 * channel, read from the collection it booked. `deleteChannel` lets a
 * channel go only once no subscription can be billed again, but a refund
 * or chargeback of a payment already made can still arrive, and it must
 * still take the creator's share back. `earning_event` has no foreign key
 * to the channel, so the collection outlives it.
 */
async function bookedSaleFacts(tx: Tx, transactionId: string): Promise<LedgerFacts | null> {
  const [row] = await tx
    .select({
      ownerWorkspaceId: schema.earningEvent.ownerWorkspaceId,
      channelId: schema.earningEvent.channelId,
      shareBps: schema.earningEvent.shareBps,
    })
    .from(schema.earningEvent)
    .where(and(eq(schema.earningEvent.source, 'channel_subscription'), eq(schema.earningEvent.reference, transactionId)));
  if (!row || row.channelId === null || row.shareBps === null) return null;
  return { ownerWorkspaceId: row.ownerWorkspaceId, channelId: row.channelId, shareBps: row.shareBps };
}

type SubscriptionRow = typeof schema.channelSubscription.$inferSelect;

async function subscriptionByProvider(tx: Tx, externalId: string): Promise<SubscriptionRow | null> {
  const [row] = await tx
    .select()
    .from(schema.channelSubscription)
    .where(
      and(eq(schema.channelSubscription.provider, 'paddle'), eq(schema.channelSubscription.providerSubscriptionId, externalId)),
    )
    .for('update');
  return row ?? null;
}

/**
 * The row a transaction's notice belongs to. One provider subscription is
 * one row, whichever of its transaction's notices names the subscription
 * first: Paddle creates the subscription only once the first payment
 * clears, so the first notice may carry no subscription id -- the row is
 * then keyed `txn:<transaction>` -- and a later one does.
 *
 * - The subscription the notice names, when a row has it.
 * - Otherwise the row this transaction already made: keyed by it, or the
 *   one its collection was booked against. A `txn:` key is re-keyed to the
 *   subscription the notice now names, so a refund, a subscription event
 *   and a cancellation all find this one row. A second row would keep
 *   granting access after a refund revoked the first.
 */
async function subscriptionForNotice(tx: Tx, notice: ChannelTransactionNotice): Promise<SubscriptionRow | null> {
  if (notice.subscriptionExternalId) {
    const named = await subscriptionByProvider(tx, notice.subscriptionExternalId);
    if (named) return named;
  }
  let row = await subscriptionByProvider(tx, `txn:${notice.transactionId}`);
  if (!row) {
    const [booked] = await tx
      .select({ id: schema.earningEvent.channelSubscriptionId })
      .from(schema.earningEvent)
      .where(and(eq(schema.earningEvent.source, 'channel_subscription'), eq(schema.earningEvent.reference, notice.transactionId)));
    if (booked?.id) {
      const [first] = await tx.select().from(schema.channelSubscription).where(eq(schema.channelSubscription.id, booked.id)).for('update');
      row = first ?? null;
    }
  }
  if (!row) return null;
  if (notice.subscriptionExternalId && row.providerSubscriptionId?.startsWith('txn:')) {
    await tx
      .update(schema.channelSubscription)
      .set({ providerSubscriptionId: notice.subscriptionExternalId, updatedAt: new Date() })
      .where(eq(schema.channelSubscription.id, row.id));
    return { ...row, providerSubscriptionId: notice.subscriptionExternalId };
  }
  return row;
}

/**
 * One channel transaction, re-read in full at the provider: its collection
 * and its adjustments. Every write is keyed on a provider id, so a
 * redelivered or out-of-order notification adds nothing twice. `adapter`
 * is the provider a revoking refund cancels the subscription at; the
 * deployment's when not given.
 */
export async function applyChannelTransaction(
  tx: Tx,
  notice: ChannelTransactionNotice,
  adapter?: PaymentAdapter,
): Promise<ChannelWebhookOutcome> {
  /*
   * One transaction's notices are applied one at a time: `paid` and
   * `completed` arrive together, and two that both found no row would both
   * insert one.
   */
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`channel_transaction:${notice.transactionId}`}))`);
  let subscription = await subscriptionForNotice(tx, notice);
  const planVersionId = notice.channelPlanVersionId ?? subscription?.planVersionId ?? null;
  const plan = planVersionId ? await planFacts(tx, planVersionId) : null;
  const userId = notice.userId ?? subscription?.userId ?? null;
  const workspaceId = notice.workspaceId ?? subscription?.workspaceId ?? null;
  if (!plan) {
    /* The channel is gone: what its sales booked can still be taken back, nothing else moves. */
    const booked = await bookedSaleFacts(tx, notice.transactionId);
    if (booked) {
      await bookAdjustments(tx, notice, booked, null, adapter);
      return 'applied';
    }
  }
  if (!plan || !userId || !workspaceId) {
    console.error(`channel webhook: transaction ${notice.transactionId} names no known plan or subscriber`);
    return 'unresolved';
  }
  /*
   * The tag names the plan; what was paid must pay for it. A transaction
   * that does not is recorded with its payload (`payment_event`) for an
   * operator and grants nothing.
   */
  const mismatch = channelSaleMismatch(notice, plan);
  if (mismatch) {
    console.error(`channel webhook: transaction ${notice.transactionId} does not pay for plan version ${plan.id} (${mismatch})`);
    return 'refused';
  }
  const facts: LedgerFacts = { ownerWorkspaceId: plan.ownerWorkspaceId, channelId: plan.channelId, shareBps: creatorShareBps(plan.feeRateBps) };

  /*
   * A transaction already refunded or charged back -- in this notice, or by
   * an adjustment an earlier one booked -- never extends access again: the
   * provider re-sends the whole transaction with every adjustment event, and
   * a re-read of its collection must not undo the revocation.
   */
  const reversedHere = notice.adjustments.some(
    (adjustment) => adjustment.status === 'approved' && (adjustment.action === 'refund' || adjustment.action === 'chargeback'),
  );
  const [reversedBefore] = reversedHere
    ? [{ n: 1 }]
    : await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.earningEvent)
        .where(
          and(
            eq(schema.earningEvent.providerTransactionId, notice.transactionId),
            inArray(schema.earningEvent.source, ['refund', 'chargeback']),
          ),
        );
  const reversed = (reversedBefore?.n ?? 0) > 0;

  if (notice.state === 'collected') {
    if (!Number.isFinite(notice.exTaxMinor) || notice.exTaxMinor < 0) {
      console.error(`channel webhook: transaction ${notice.transactionId} has no usable subtotal`);
      return 'unresolved';
    }
    const periodEnd = notice.periodEnd ?? new Date((notice.collectedAt ?? notice.observedAt).getTime() + 31 * 86_400_000);
    if (!subscription) {
      /* Keyed by the subscription, or -- for a first payment that does not name one yet -- by the transaction. */
      const providerKey = notice.subscriptionExternalId ?? `txn:${notice.transactionId}`;
      await tx
        .insert(schema.channelSubscription)
        .values({
          id: uuidv7(),
          channelId: plan.channelId,
          userId,
          workspaceId,
          planVersionId: plan.id,
          status: 'active',
          currentPeriodEnd: periodEnd,
          providerSubscriptionId: providerKey,
          providerCustomerId: notice.customerId,
          observedAt: notice.observedAt,
        })
        .onConflictDoNothing();
      subscription = (await subscriptionByProvider(tx, providerKey)) ?? null;
    } else if (!reversed && periodEnd > subscription.currentPeriodEnd) {
      /* A renewal moves the period forward and restores access; an older transaction never moves it back. */
      await tx
        .update(schema.channelSubscription)
        .set({ status: 'active', currentPeriodEnd: periodEnd, updatedAt: new Date() })
        .where(eq(schema.channelSubscription.id, subscription.id));
    }
    /* Proposal 8.1: a first channel subscription raises the subscriber to 2 GB, for good. */
    await extendUserStorageTier(tx, userId);

    const collectedAt = notice.collectedAt ?? notice.observedAt;
    await tx
      .insert(schema.earningEvent)
      .values({
        id: uuidv7(),
        ownerWorkspaceId: facts.ownerWorkspaceId,
        amountMinor: creatorShareMinor(notice.exTaxMinor, facts.shareBps),
        source: 'channel_subscription',
        reference: notice.transactionId,
        periodId: await openPeriodId(tx, collectedAt),
        channelId: facts.channelId,
        channelSubscriptionId: subscription?.id ?? null,
        providerTransactionId: notice.transactionId,
        grossMinor: notice.exTaxMinor,
        shareBps: facts.shareBps,
        createdAt: collectedAt,
      })
      .onConflictDoNothing();
  }

  await bookAdjustments(tx, notice, facts, subscription, adapter);
  return 'applied';
}

/**
 * A transaction's refunds, chargebacks and reversals, each booked once on
 * its adjustment id. A refund or chargeback of the period now running
 * revokes access at once (proposal 6.9) and stops the provider
 * subscription; one of an earlier period leaves the current one alone:
 * that period was paid for separately.
 */
async function bookAdjustments(
  tx: Tx,
  notice: ChannelTransactionNotice,
  facts: LedgerFacts,
  subscription: SubscriptionRow | null,
  adapter: PaymentAdapter | undefined,
): Promise<void> {
  let revoked = false;
  for (const adjustment of notice.adjustments) {
    if (adjustment.status !== 'approved' || adjustment.action === 'other') continue;
    if (!Number.isFinite(adjustment.exTaxMinor) || adjustment.exTaxMinor <= 0) continue;
    const sign = adjustment.action === 'chargeback_reverse' ? 1 : -1;
    const inserted = await tx
      .insert(schema.earningEvent)
      .values({
        id: uuidv7(),
        ownerWorkspaceId: facts.ownerWorkspaceId,
        amountMinor: creatorShareMinor(sign * adjustment.exTaxMinor, facts.shareBps),
        source: adjustment.action,
        reference: adjustment.id,
        periodId: await openPeriodId(tx, adjustment.observedAt),
        channelId: facts.channelId,
        channelSubscriptionId: subscription?.id ?? null,
        providerTransactionId: notice.transactionId,
        grossMinor: sign * adjustment.exTaxMinor,
        shareBps: facts.shareBps,
        createdAt: adjustment.observedAt,
      })
      .onConflictDoNothing()
      .returning({ id: schema.earningEvent.id });
    if (inserted.length > 0 && sign < 0 && subscription) {
      const covers = !notice.periodEnd || notice.periodEnd.getTime() >= subscription.currentPeriodEnd.getTime();
      if (covers) {
        await tx
          .update(schema.channelSubscription)
          .set({ status: 'refunded', currentPeriodEnd: adjustment.observedAt, updatedAt: new Date() })
          .where(eq(schema.channelSubscription.id, subscription.id));
        revoked = true;
      }
    }
  }
  if (revoked && subscription) await stopAtProvider(tx, subscription, adapter);
}

/**
 * Cancels the provider subscription now, once a refund or chargeback has
 * revoked its running period. A refund does not cancel a Paddle
 * subscription: left alone it renews next cycle, charges the buyer again and
 * restores access, and a buyer who re-subscribed in between is billed twice
 * from then on.
 *
 * Called inside the webhook's transaction, so an outage throws, the event
 * rolls back with the refund it carried, and the provider's retry does both
 * again -- the retry is the queue. A refusal (already canceled, unknown id)
 * is the same on every retry, so it is logged and the refund stands; the row
 * then still reads as one that may renew, and checkout stays closed to it.
 */
async function stopAtProvider(tx: Tx, subscription: SubscriptionRow, adapter: PaymentAdapter | undefined): Promise<void> {
  const externalId = subscription.providerSubscriptionId;
  /* Already ending at the provider: nothing will renew. */
  if (subscription.status === 'canceled' || subscription.cancelAtPeriodEnd) return;
  if (!externalId || externalId.startsWith('txn:')) {
    console.error(`channel webhook: subscription row ${subscription.id} was refunded before its provider subscription was known; cancel it at the provider`);
    return;
  }
  try {
    await (adapter ?? paymentAdapter()).cancelSubscription(externalId, { immediately: true });
  } catch (error) {
    const refused = error instanceof PaymentProviderError && error.status !== null && error.status >= 400 && error.status < 500 && error.status !== 429;
    if (!refused) throw error;
    console.error(`channel webhook: the provider would not cancel ${externalId}: ${(error as Error).message}`);
    return;
  }
  await tx
    .update(schema.channelSubscription)
    .set({ cancelAtPeriodEnd: true, updatedAt: new Date() })
    .where(eq(schema.channelSubscription.id, subscription.id));
}

/** A subscription's own state: cancellation scheduled or done, past due, paused. */
export async function applyChannelSubscription(tx: Tx, notice: ChannelSubscriptionNotice): Promise<ChannelWebhookOutcome> {
  const subscription = await subscriptionByProvider(tx, notice.subscriptionExternalId);
  /* The first collected transaction creates the row; a subscription event that outruns it waits for it. */
  if (!subscription) return 'unresolved';
  if (subscription.observedAt && subscription.observedAt > notice.observedAt) return 'stale';
  /*
   * A refund's revocation is final for the period; nothing but a new payment
   * restores it. Once the provider subscription is known to end -- canceled
   * by the refund (`stopAtProvider`) or here -- that stays known: a canceled
   * provider subscription never resumes, and an older event delivered late
   * must not make it look live again (`startChannelCheckout` reads it).
   */
  if (subscription.status === 'refunded') {
    await tx
      .update(schema.channelSubscription)
      .set({
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd || notice.cancelAtPeriodEnd || notice.status === 'canceled',
        observedAt: notice.observedAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.channelSubscription.id, subscription.id));
    return 'applied';
  }
  const status: ChannelSubscriptionStatus = notice.status === 'other' ? subscription.status : notice.status;
  await tx
    .update(schema.channelSubscription)
    .set({
      status,
      cancelAtPeriodEnd: notice.cancelAtPeriodEnd || status === 'canceled',
      /*
       * The period end is not taken from here: only a collected transaction
       * moves it, so a renewal still in dunning grants nothing past what was
       * paid for, and a cancellation never shortens it.
       */
      providerCustomerId: subscription.providerCustomerId ?? notice.customerId,
      observedAt: notice.observedAt,
      updatedAt: new Date(),
    })
    .where(eq(schema.channelSubscription.id, subscription.id));
  return 'applied';
}

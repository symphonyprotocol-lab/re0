/**
 * What a workspace reads about its own bill: the Plan Version it is on, and
 * what this period would cost at that version's price.
 *
 * "Would", because re0 never charges anyone itself (requirement.md 4.3): the
 * amount is the plan's monthly price plus the Additional Calls packs bought
 * inside the period, and it becomes an invoice only once a Payment Provider
 * is connected. Until then the dashboard prints the figure with a note that
 * nothing has been charged, which is more honest than hiding a number the
 * user can work out from the pricing page anyway.
 *
 * The arithmetic is a pure function so it can be tested without a database.
 */
import { and, eq, gte, isNull, lt } from 'drizzle-orm';
import { PLAN_CURRENCY } from '@/lib/domain/plans';
import { paymentAdapter } from '@/lib/infrastructure/payment/provider';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { IN_FORCE_FIRST, subscriptionInForce, windowInForce } from '@/lib/application/plans/in-force';
import { PLAN_VERSION_NEWEST_FIRST } from './configuration';

export interface WorkspacePlanVersion {
  /** Null only when the catalogue has no Free version at all. */
  planVersionId: string | null;
  planId: string;
  /** The tier's display name from `plan`, as the session prints it. */
  planName: string;
  priceMinor: number;
  currency: string;
  monthlyCalls: number;
  libraryLimit: number;
  librarySizeBytesLimit: number;
  apiKeyLimit: number;
  /** True when an active subscription sets the window, false on the Free default. */
  subscribed: boolean;
  periodStart: Date;
  periodEnd: Date;
  /**
   * What happens at the end of a provider-billed subscription's period: it
   * renews, or a cancellation the subscriber asked for takes effect. Null on
   * the Free default and the Free row, which nothing bills or renews.
   */
  renewal: { kind: 'renews' | 'cancels'; at: Date } | null;
}

/**
 * The version a workspace bills against right now, and the period it covers:
 * the active subscription's frozen version and provider-defined period, or the
 * newest Free version over a UTC calendar month. The same rule the quota
 * transaction applies (`planWindow` in ./quota), read-only.
 */
export async function workspacePlanVersion(workspaceId: string): Promise<WorkspacePlanVersion> {
  const database = db();
  const [active] = await database
    .select({
      planVersionId: schema.subscription.planVersionId,
      periodStart: schema.subscription.periodStart,
      periodEnd: schema.subscription.periodEnd,
      providerSubscriptionId: schema.subscription.providerSubscriptionId,
      cancelAt: schema.subscription.cancelAt,
    })
    .from(schema.subscription)
    .where(
      and(eq(schema.subscription.workspaceId, workspaceId), subscriptionInForce()),
    )
    .orderBy(...IN_FORCE_FIRST)
    .limit(1);

  const columns = {
    id: schema.planVersion.id,
    planId: schema.planVersion.planId,
    planName: schema.plan.name,
    priceMinor: schema.planVersion.priceMinor,
    currency: schema.planVersion.currency,
    monthlyCalls: schema.planVersion.monthlyCalls,
    libraryLimit: schema.planVersion.libraryLimit,
    librarySizeBytesLimit: schema.planVersion.librarySizeBytesLimit,
    apiKeyLimit: schema.planVersion.apiKeyLimit,
  };

  if (active) {
    const [version] = await database
      .select(columns)
      .from(schema.planVersion)
      .innerJoin(schema.plan, eq(schema.plan.id, schema.planVersion.planId))
      .where(eq(schema.planVersion.id, active.planVersionId));
    if (version) {
      return {
        planVersionId: version.id,
        planId: version.planId,
        planName: version.planName,
        priceMinor: version.priceMinor,
        currency: version.currency,
        monthlyCalls: version.monthlyCalls,
        libraryLimit: version.libraryLimit,
        librarySizeBytesLimit: version.librarySizeBytesLimit,
        apiKeyLimit: version.apiKeyLimit,
        subscribed: true,
        ...windowInForce(active),
        renewal: subscriptionRenewal(active),
      };
    }
  }

  const [free] = await database
    .select(columns)
    .from(schema.planVersion)
    .innerJoin(schema.plan, eq(schema.plan.id, schema.planVersion.planId))
    .where(eq(schema.planVersion.planId, 'free'))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);

  const { periodStart, periodEnd } = calendarMonth(new Date());
  return {
    planVersionId: free?.id ?? null,
    planId: 'free',
    planName: free?.planName ?? 'Free',
    priceMinor: free?.priceMinor ?? 0,
    currency: free?.currency ?? PLAN_CURRENCY,
    monthlyCalls: free?.monthlyCalls ?? 0,
    libraryLimit: free?.libraryLimit ?? 0,
    librarySizeBytesLimit: free?.librarySizeBytesLimit ?? 0,
    apiKeyLimit: free?.apiKeyLimit ?? 0,
    subscribed: false,
    periodStart,
    periodEnd,
    renewal: null,
  };
}

/**
 * Renews or cancels, and when. The row's own period end, not the in-force
 * window: during the renewal grace that window has already moved on, but the
 * date the provider charges, or stops, is still the one it reported.
 */
export function subscriptionRenewal(row: {
  providerSubscriptionId: string | null;
  periodEnd: Date;
  cancelAt: Date | null;
}): WorkspacePlanVersion['renewal'] {
  if (!row.providerSubscriptionId) return null;
  return row.cancelAt
    ? { kind: 'cancels', at: row.cancelAt }
    : { kind: 'renews', at: row.periodEnd };
}

/** The UTC calendar month around `now`: the Free tier's period. */
export function calendarMonth(now: Date): { periodStart: Date; periodEnd: Date } {
  return {
    periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/* -------------------------------------------------------------- cost */

export interface PeriodCostInput {
  /** The plan version's monthly price. Zero on Free. */
  planPriceMinor: number;
  /** What one Additional Calls pack costs on the newest `addon` version. */
  packPriceMinor: number;
  /** Every pack the workspace has ever bought; the window is applied here. */
  packs: { createdAt: Date }[];
  periodStart: Date;
  periodEnd: Date;
}

export interface PeriodCost {
  planMinor: number;
  /** Packs bought inside [periodStart, periodEnd). */
  packsBought: number;
  packsMinor: number;
  totalMinor: number;
}

/**
 * This period's cost: the plan's price once, plus each pack bought inside the
 * period at the current pack price.
 *
 * The window is half-open, like every other period on the ledger: a pack
 * bought at the exact instant the next period starts belongs to that period.
 * Packs bought earlier are not this period's money even though their balance
 * carries over (requirement.md 4.3) -- they were paid for when they were
 * bought, and counting them again would bill the same pack every month.
 */
export function periodCost(input: PeriodCostInput): PeriodCost {
  const planMinor = Math.max(0, input.planPriceMinor);
  const packPrice = Math.max(0, input.packPriceMinor);
  const packsBought = input.packs.filter(
    (pack) => pack.createdAt >= input.periodStart && pack.createdAt < input.periodEnd,
  ).length;
  const packsMinor = packsBought * packPrice;
  return { planMinor, packsBought, packsMinor, totalMinor: planMinor + packsMinor };
}

export interface WorkspaceBilling {
  plan: WorkspacePlanVersion;
  cost: PeriodCost;
  /**
   * Whether a Payment Provider is configured. Until it is, no document is
   * issued and no card is charged, so the cost is an estimate to label as one.
   */
  paymentConnected: boolean;
}

/** The plan and this period's cost, as the overview prints them. */
export async function workspaceBilling(workspaceId: string): Promise<WorkspaceBilling> {
  const database = db();
  const plan = await workspacePlanVersion(workspaceId);

  const [packs, [addon]] = await Promise.all([
    database
      .select({ createdAt: schema.addonGrant.createdAt })
      .from(schema.addonGrant)
      .where(
        and(
          eq(schema.addonGrant.workspaceId, workspaceId),
          gte(schema.addonGrant.createdAt, plan.periodStart),
          lt(schema.addonGrant.createdAt, plan.periodEnd),
          /* Bought, not redeemed: a grant made of settled earnings cost the
             workspace nothing this period (publisher-revenue-share.md 3.4). */
          isNull(schema.addonGrant.publisherAccountId),
        ),
      ),
    database
      .select({ priceMinor: schema.planVersion.priceMinor })
      .from(schema.planVersion)
      .where(eq(schema.planVersion.planId, 'addon'))
      .orderBy(...PLAN_VERSION_NEWEST_FIRST)
      .limit(1),
  ]);

  return {
    plan,
    cost: periodCost({
      planPriceMinor: plan.priceMinor,
      packPriceMinor: addon?.priceMinor ?? 0,
      packs,
      periodStart: plan.periodStart,
      periodEnd: plan.periodEnd,
    }),
    paymentConnected: isPaymentConnected(),
  };
}

/**
 * The provider module throws when the deployment has no Paddle settings, and
 * that throw is the only signal there is. Caught here so a missing provider
 * reads as "not connected" on a dashboard rather than as a 500.
 */
export function isPaymentConnected(): boolean {
  try {
    paymentAdapter();
    return true;
  } catch {
    return false;
  }
}

/**
 * The last day inside a billing period, for printing.
 *
 * Periods are half-open on the ledger and stored in UTC, so `periodEnd` is
 * the first instant *after* the period: a September period ends at
 * 2026-10-01T00:00:00Z. A person calls that period "1 - 30 September", so
 * the printed end is one day back.
 *
 * The two screens that print it had each invented their own arithmetic --
 * the overview subtracted a millisecond, settings subtracted a day -- and
 * they disagreed by a whole day whenever the server's timezone was not UTC,
 * because both then formatted the result in local time. Callers pair this
 * with a UTC formatter, and the period reads the same wherever it renders.
 */
export function periodLastDay(periodEnd: Date): Date {
  return new Date(periodEnd.getTime() - 86_400_000);
}

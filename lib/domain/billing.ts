/**
 * Plan and Pack rules (rebuild-proposal.md 2.3; 8.2 "扣费顺序", "Pack 数量"),
 * free of the database and of Paddle: what a checkout may buy, what a
 * payment grants, what a refund takes back and from where, and what the
 * billing page shows.
 */
import type { CreditEntryReason } from '@/db/schema';
import { PACK, PLAN, PLAN_USAGE_WARN_PERCENT } from '@/lib/constants';
import { spendOrder, type Allocation, type SpendableGrant } from '@/lib/domain/credits';

export type PurchaseKind = 'plan' | 'pack';

export interface CheckoutOrder {
  kind: PurchaseKind;
  quantity: number;
}

/** A checkout request as an order, or the code it is refused with. Pack quantity is a whole number from 1 to 10. */
export function parseOrder(input: { kind?: unknown; quantity?: unknown }): CheckoutOrder | { error: 'invalid_kind' | 'invalid_quantity' } {
  if (input.kind !== 'plan' && input.kind !== 'pack') return { error: 'invalid_kind' };
  if (input.kind === 'plan') return { kind: 'plan', quantity: 1 };
  const quantity = typeof input.quantity === 'string' ? Number(input.quantity) : input.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < PACK.minQuantity || quantity > PACK.maxQuantity) {
    return { error: 'invalid_quantity' };
  }
  return { kind: 'pack', quantity };
}

/** The checkout page's `?quantity=`, pulled into 1–10 the way the prototype does. */
export function pageQuantity(raw: string | undefined): number {
  const value = Math.trunc(Number(raw));
  return Number.isFinite(value) ? Math.min(PACK.maxQuantity, Math.max(PACK.minQuantity, value)) : PACK.minQuantity;
}

export function creditsFor(order: CheckoutOrder, unitCredits: number): number {
  return order.kind === 'plan' ? unitCredits : unitCredits * order.quantity;
}

/** Before tax: Paddle adds tax at checkout. */
export function priceMinorFor(order: CheckoutOrder): number {
  return order.kind === 'plan' ? PLAN.priceMinor : PACK.priceMinor * order.quantity;
}

/* ---------------------------------------------------------------- the Plan */

export type SubscriptionStatus = 'active' | 'cancelled' | 'expired';

export interface PlanSubscription {
  status: SubscriptionStatus;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

/**
 * Paddle's subscription states onto ours. `active` and `trialing` are paying;
 * `canceled` has ended. `past_due` (a renewal that failed and is being
 * retried) and `paused` are read as `expired`: no Plan is in force, but the
 * row comes back to `active` if Paddle collects. Anything new is not paying.
 */
export function subscriptionStatusFrom(paddleStatus: string): SubscriptionStatus {
  if (paddleStatus === 'active' || paddleStatus === 'trialing') return 'active';
  if (paddleStatus === 'canceled') return 'cancelled';
  return 'expired';
}

/** "Plan 订阅在有效期内": paying, inside its current period. Cancelled renewal still counts until the period ends. */
export function planIsActive(subscription: PlanSubscription | null, now: Date): boolean {
  if (!subscription || subscription.status !== 'active') return false;
  return subscription.currentPeriodEnd !== null && subscription.currentPeriodEnd.getTime() > now.getTime();
}

/* ------------------------------------------- redeemed Plans and Plan state */

/**
 * `months` calendar months after `date` (UTC), the day clamped to the
 * target month's last: 31 Jan + 1 month is 28 (or 29) Feb, not 3 Mar.
 */
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDay);
  return new Date(Date.UTC(year, month, day, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

/** Month `index` (from 0) of a redeemed Plan starting at `startsAt`; always counted from the start, so months never drift. */
export function redeemedPeriod(startsAt: Date, index: number): { start: Date; end: Date } {
  return { start: addMonths(startsAt, index), end: addMonths(startsAt, index + 1) };
}

/** The month of a redeemed Plan `at` falls in, or null outside it. */
export function redeemedPeriodIndexAt(plan: RedeemedPlan, at: Date): number | null {
  if (at.getTime() < plan.startsAt.getTime() || at.getTime() >= plan.endsAt.getTime()) return null;
  for (let index = 0; index < plan.months; index += 1) {
    if (at.getTime() < redeemedPeriod(plan.startsAt, index).end.getTime()) return index;
  }
  return plan.months - 1;
}

/** A redeemed Plan: [startsAt, endsAt), `months` monthly grants (docs/design/redeem-codes.md 4.2). */
export interface RedeemedPlan {
  startsAt: Date;
  endsAt: Date;
  months: number;
  /** Credits per month, snapshotted when the code was redeemed. */
  credits?: number;
}

/**
 * Whether the user's Plan is in force and where it comes from: a paying
 * Paddle subscription, else a redeemed Plan covering now. `redeemedUntil`
 * is how far redeemed Plans reach without a gap; `redeemedNext` a redeemed
 * Plan waiting for a Paddle period to end.
 */
export interface PlanState {
  active: boolean;
  source: 'paddle' | 'redeemed' | null;
  cancelAtPeriodEnd: boolean;
  periodStart: Date | null;
  periodEnd: Date | null;
  redeemedUntil: Date | null;
  redeemedNext: Date | null;
}

export function planStateFrom(subscription: PlanSubscription | null, redeemed: readonly RedeemedPlan[], now: Date): PlanState {
  const plans = [...redeemed].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  /* How far redeemed Plans reach from `from` without a gap. */
  const reach = (from: Date): Date => {
    let end = from;
    for (let moved = true; moved; ) {
      moved = false;
      for (const plan of plans) {
        if (plan.startsAt.getTime() <= end.getTime() && plan.endsAt.getTime() > end.getTime()) {
          end = plan.endsAt;
          moved = true;
        }
      }
    }
    return end;
  };
  const queued = plans.find((plan) => plan.startsAt.getTime() > now.getTime()) ?? null;
  if (planIsActive(subscription, now)) {
    return {
      active: true,
      source: 'paddle',
      cancelAtPeriodEnd: subscription!.cancelAtPeriodEnd,
      periodStart: subscription!.currentPeriodStart,
      periodEnd: subscription!.currentPeriodEnd,
      redeemedUntil: queued ? reach(queued.startsAt) : null,
      redeemedNext: queued?.startsAt ?? null,
    };
  }
  const current = plans.find((plan) => redeemedPeriodIndexAt(plan, now) !== null);
  if (current) {
    const period = redeemedPeriod(current.startsAt, redeemedPeriodIndexAt(current, now)!);
    return { active: true, source: 'redeemed', cancelAtPeriodEnd: false, periodStart: period.start, periodEnd: period.end, redeemedUntil: reach(now), redeemedNext: null };
  }
  return {
    active: false,
    source: null,
    cancelAtPeriodEnd: false,
    periodStart: null,
    periodEnd: null,
    redeemedUntil: queued ? reach(queued.startsAt) : null,
    redeemedNext: queued?.startsAt ?? null,
  };
}

export interface PlanUsage {
  active: boolean;
  /** `redeemed`: a redeem code's Plan, with no renewal to turn on or off. */
  source: 'paddle' | 'redeemed' | null;
  cancelAtPeriodEnd: boolean;
  periodEnd: string | null;
  /** How far redeemed Plans reach, and when one waiting behind a Paddle period begins. */
  redeemedUntil: string | null;
  redeemedNext: string | null;
  allowance: number;
  used: number;
  remaining: number;
  percent: number;
  warn: boolean;
}

/**
 * The sidebar's meter (prototype usage.js `creditUsage`): this period's Plan
 * credits used. Pack, welcome and earned credits are not part
 * of it. A Plan whose period's payment has not arrived yet reads as unused.
 */
export function planUsage(
  plan: PlanState | PlanSubscription | null,
  currentGrant: { amount: number; remaining: number } | null,
  now: Date,
  currentAllowance: number = PLAN.credits,
): PlanUsage {
  const state = plan && 'source' in plan ? plan : planStateFrom(plan, [], now);
  const redeemed = { redeemedUntil: state.redeemedUntil?.toISOString() ?? null, redeemedNext: state.redeemedNext?.toISOString() ?? null };
  if (!state.active) {
    return { active: false, source: null, cancelAtPeriodEnd: false, periodEnd: null, ...redeemed, allowance: 0, used: 0, remaining: 0, percent: 0, warn: false };
  }
  const allowance = currentGrant?.amount ?? currentAllowance;
  const remaining = currentGrant ? currentGrant.remaining : allowance;
  const used = Math.max(0, allowance - remaining);
  const percent = allowance ? Math.min(100, Math.round((used / allowance) * 10_000) / 100) : 0;
  return {
    active: true,
    source: state.source,
    cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    periodEnd: state.periodEnd?.toISOString() ?? null,
    ...redeemed,
    allowance,
    used,
    remaining,
    percent,
    /* On the exact ratio: 89,999 of 100,000 shows as 90% but is not yet the red line. */
    warn: allowance > 0 && used * 100 >= allowance * PLAN_USAGE_WARN_PERCENT,
  };
}

/* ------------------------------------------------- refunds and chargebacks */

/**
 * Credits a refund of `adjustmentMinor` takes back: the refunded share of
 * what the purchase granted, rounded, never past what is still unreversed.
 * A full refund takes back everything that is left to take.
 */
export function reversalCredits(
  purchase: { credits: number; amountMinor: number; reversedCredits: number },
  adjustmentMinor: number,
): number {
  const open = purchase.credits - purchase.reversedCredits;
  if (open <= 0 || !Number.isSafeInteger(adjustmentMinor) || adjustmentMinor <= 0) return 0;
  if (purchase.amountMinor <= 0 || adjustmentMinor >= purchase.amountMinor) return open;
  const total = BigInt(purchase.amountMinor);
  const refunded = (BigInt(purchase.credits) * BigInt(adjustmentMinor) + total / 2n) / total;
  return Math.min(open, Number(refunded));
}

/**
 * Where a reversal comes from: the purchase's own grant first (what is left
 * of what was bought), then whatever else the user holds in the spending
 * order. What still cannot be covered is the shortfall -- recorded as a debt,
 * never as a negative balance (2.3).
 */
export function takeBack(
  grants: readonly SpendableGrant[],
  purchaseGrantId: string | null,
  amount: number,
  now: Date,
): { allocations: Allocation[]; shortfall: number } {
  const ordered = spendOrder(grants, now);
  const own = ordered.filter((grant) => grant.id === purchaseGrantId);
  const rest = ordered.filter((grant) => grant.id !== purchaseGrantId);
  const allocations: Allocation[] = [];
  let left = amount;
  for (const grant of [...own, ...rest]) {
    if (left === 0) break;
    const take = Math.min(grant.remaining, left);
    allocations.push({ grantId: grant.id, source: grant.source, amount: take });
    left -= take;
  }
  return { allocations, shortfall: left };
}

/** Open debts, oldest first, paid off from `amount` arriving credits. */
export function offsetDebts(debts: readonly { id: string; remaining: number }[], amount: number): { debtId: string; amount: number }[] {
  const offsets: { debtId: string; amount: number }[] = [];
  let left = amount;
  for (const debt of debts) {
    if (left === 0) break;
    const pay = Math.min(debt.remaining, left);
    if (pay > 0) offsets.push({ debtId: debt.id, amount: pay });
    left -= pay;
  }
  return offsets;
}

/* -------------------------------------------------------------- the ledger */

/** The billing tab's activity filter (prototype `?activity=all|spend|income`). */
export const ACTIVITIES = ['all', 'spend', 'income'] as const;
export type Activity = (typeof ACTIVITIES)[number];

/**
 * "消耗" is everything a use of the product moved: holds and their
 * settlements and refunds, so a hold and what came back sit side by side.
 * "收入" is earned credits arriving (step 4's query fees). Purchases,
 * refunds, expiry and the rest appear under "全部".
 */
export const ACTIVITY_REASONS: Record<Exclude<Activity, 'all'>, readonly CreditEntryReason[]> = {
  spend: [
    'knowledge_hold',
    'knowledge_settle',
    'knowledge_refund',
    'query_hold',
    'query_base',
    'query_refund',
    'query_fee_paid',
    'verify_hold',
    'verify_settle',
    'verify_refund',
    'synthesis_hold',
    'synthesis_settle',
    'synthesis_refund',
    'video_script',
    'video_export',
    'video_refund',
    'storage_charge',
  ],
  income: ['query_fee_earned', 'invite_reward', 'invite_reward_gift', 'payout_hold', 'payout_release', 'payout_paid'],
};

/**
 * Channel subscriptions and the creator's share, as pure rules.
 * agent-first-proposal.md 6.9, 6.11, 8.1.
 *
 * A channel sells at most one monthly and one yearly plan at a time. Each is
 * an immutable plan version carrying its price and the platform fee rate, so
 * a price change -- or a new fee rate -- affects new subscriptions only. Any
 * one transaction costs at least the configured minimum, the yearly plan
 * included: the platform's break-even is per transaction, not per month.
 *
 * The creator is credited `(10000 - fee) / 10000` of each collection's
 * ex-tax subtotal; a refund or chargeback takes back the same share of what
 * it returned. Paddle's own fee comes out of the platform's part.
 *
 * Pure TypeScript -- domain layer rules apply.
 */

export const PLAN_INTERVALS = ['month', 'year'] as const;
export type PlanInterval = (typeof PLAN_INTERVALS)[number];

export function isPlanInterval(value: unknown): value is PlanInterval {
  return value === 'month' || value === 'year';
}

/** What a channel subscription may be in; which of them read `paid` assets is `grantsAccess`. */
export const CHANNEL_SUBSCRIPTION_STATUSES = ['active', 'past_due', 'canceled', 'refunded', 'paused'] as const;
export type ChannelSubscriptionStatus = (typeof CHANNEL_SUBSCRIPTION_STATUSES)[number];

/** The statuses that still read `paid` assets while the period runs. */
export const ACCESS_STATUSES: readonly ChannelSubscriptionStatus[] = ['active', 'past_due', 'canceled'];

/**
 * Whether a subscription reads the channel's `paid` assets right now.
 * A cancellation keeps access to the period's end; a refund revokes it at
 * once; an expiry needs no event -- the period end alone decides, so the
 * next call after it is refused.
 */
export function grantsAccess(
  subscription: { status: string; currentPeriodEnd: Date },
  now: Date = new Date(),
): boolean {
  return (
    (ACCESS_STATUSES as readonly string[]).includes(subscription.status) &&
    subscription.currentPeriodEnd.getTime() > now.getTime()
  );
}

export type ChannelCommerceError =
  /** Only the channel's owner (owner or admin role) sets plans. */
  | 'not_owner'
  | 'not_found'
  /** The private, suspended and platform channels sell nothing. */
  | 'not_sellable'
  /** Switching subscriptions on needs the paid-distribution rights confirmation (6.11). */
  | 'rights_confirmation_required'
  | 'subscriptions_disabled'
  | 'invalid_interval'
  | 'invalid_price'
  /** Below the configured minimum for any one transaction. */
  | 'below_minimum'
  /** The creator's balance is negative: no new paid plan, no payout (6.9). */
  | 'negative_balance'
  /** A subscriber already holds a live subscription to this channel. */
  | 'already_subscribed'
  | 'own_channel'
  | 'no_plan'
  | 'not_connected'
  | 'not_subscribed';

export class ChannelCommerceRefused extends Error {
  constructor(
    readonly code: ChannelCommerceError,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelCommerceRefused';
  }
}

/** Prices are whole cents in USD, the one currency payouts are made in. */
export const CHANNEL_CURRENCY = 'USD';
/** $10,000 a transaction is more than any channel plan, and less than any adapter unit mistake. */
export const MAX_PLAN_PRICE_MINOR = 1_000_000;

/**
 * A plan price as the owner typed it in dollars ("5", "4.99"), in cents;
 * refused below the minimum for any one transaction, monthly or yearly.
 */
export function planPriceMinor(input: unknown, minPriceMinor: number): number {
  const text = typeof input === 'number' ? String(input) : typeof input === 'string' ? input.trim() : '';
  if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(text)) {
    throw new ChannelCommerceRefused('invalid_price', 'a price is a dollar amount such as 5 or 4.99');
  }
  const [dollars, cents = ''] = text.split('.');
  const minor = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  return assertSellablePrice(minor, minPriceMinor);
}

/** The same floor on a price in cents: at plan creation and again at checkout. */
export function assertSellablePrice(priceMinor: number, minPriceMinor: number): number {
  if (!Number.isInteger(priceMinor) || priceMinor <= 0 || priceMinor > MAX_PLAN_PRICE_MINOR) {
    throw new ChannelCommerceRefused('invalid_price', 'the price is not a valid amount');
  }
  if (priceMinor < minPriceMinor) {
    throw new ChannelCommerceRefused(
      'below_minimum',
      `any one transaction is at least ${(minPriceMinor / 100).toFixed(2)} ${CHANNEL_CURRENCY}`,
    );
  }
  return priceMinor;
}

/** The creator's share of a plan version, in basis points: everything the fee leaves. */
export function creatorShareBps(feeRateBps: number): number {
  return 10_000 - Math.min(10_000, Math.max(0, feeRateBps));
}

/**
 * The creator's share of an ex-tax amount, rounded half away from zero to
 * the cent, so a refund of the whole amount takes back exactly what the
 * collection credited.
 */
export function creatorShareMinor(exTaxMinor: number, shareBps: number): number {
  const raw = (Math.abs(exTaxMinor) * shareBps) / 10_000;
  const rounded = Math.round(raw);
  return exTaxMinor < 0 ? -rounded : rounded;
}

/**
 * The creator's balance: everything credited and taken back, less what has
 * left the books as cash or calls (and what is on its way out in an open
 * payout request). Negative after a chargeback reverses income already paid
 * out -- and while it is, no payout and no new paid plan (6.9). It is never
 * collected from the creator; account deletion writes it off.
 */
export function creatorBalanceMinor(input: { earnedMinor: number; dischargedMinor: number }): number {
  return input.earnedMinor - input.dischargedMinor;
}

/** The paid-distribution confirmation the owner gives when switching subscriptions on (6.11). */
export const PAID_RIGHTS_STATEMENT =
  'I own, or am licensed to distribute for payment on re0, the content in this channel.';

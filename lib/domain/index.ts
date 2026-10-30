/**
 * Domain layer. Pure TypeScript.
 *
 * Must not import Next.js, Vercel, Neon, Drizzle, Payment, AI SDK or chain SDK.
 * See architecture.md 4.
 */

export type LifecycleStatus =
  | 'draft'
  | 'submitted'
  | 'reviewing'
  | 'changes_requested'
  | 'published'
  | 'suspended'
  | 'archived';

export type IndexStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'stale'
  | 'deleting';

export type ClaimStatus = 'pending' | 'verified' | 'failed' | 'expired' | 'revoked';

export type ClaimMethod = 'github_permission' | 'dns_txt' | 'well_known';

export type SourceType =
  | 'github'
  | 'website'
  | 'markdown'
  | 'pdf'
  | 'notion'
  /** Written in re0's own editor: an article or a Q&A (agent-first-proposal.md 3.2). */
  | 'editor'
  /** An uploaded episode, indexed by its title and show notes (6.6). */
  | 'audio';

/** requirement.md 7.3.2: these source types have no claim flow; the creator owns them. */
export const SELF_OWNED_SOURCE_TYPES: readonly SourceType[] = [
  'markdown',
  'pdf',
  'notion',
  'editor',
  'audio',
];

/**
 * The mirror of `SELF_OWNED_SOURCE_TYPES`: the source types a claim may name.
 * A query that has to exclude the rest asks for this list rather than
 * restating which three have no claim flow. It must stay in step with
 * `claimMethodsFor` -- a type advertising a method it cannot be claimed
 * through, or the reverse, is a dead end on the claim form.
 */
export const CLAIMABLE_SOURCE_TYPES: readonly SourceType[] = ['github', 'website'];

export function claimMethodsFor(type: SourceType): readonly ClaimMethod[] {
  switch (type) {
    case 'github':
      return ['github_permission', 'dns_txt', 'well_known'];
    /* A website is fetched from a host, and its creation is gated on the
       domain challenge (lib/domain/domain-verification.ts). */
    case 'website':
      return ['dns_txt', 'well_known'];
    default:
      return [];
  }
}

export function requiresClaim(type: SourceType): boolean {
  return claimMethodsFor(type).length > 0;
}

/**
 * requirement.md 6.2: an asset is queryable only when published, its current
 * version is ready, and the caller passed workspace plus policy checks.
 * Visibility, lifecycle and index status are independent and never merged.
 */
export function isQueryable(input: {
  lifecycleStatus: LifecycleStatus;
  indexStatus: IndexStatus;
}): boolean {
  return input.lifecycleStatus === 'published' && input.indexStatus === 'ready';
}

/**
 * agent-first-proposal.md 6.9: the least a cash payout request may carry;
 * below it a creator's earnings keep accumulating.
 *
 * $20, back up from $5 on 2026-10-24 ($5 had replaced $20 on 2026-10-05).
 * Cash is paid by hand over PayPal and the default exit is credit, which has
 * no threshold at all -- so the long tail redeems as calls, and the cash rail
 * pays out in amounts its per-transfer fee does not swallow.
 *
 * The default only: the console's commerce settings own the value
 * (`commerce-config.ts`).
 */
export const PAYOUT_THRESHOLD_MINOR = 2_000;
/**
 * The refund/chargeback window before a statement can be redeemed or paid:
 * 120 days since channel subscriptions (agent-first-proposal.md 6.9), the
 * reach of a card chargeback; 45 covered the refund window only. The
 * default, like the threshold; the console's commerce settings own it.
 */
export const PAYOUT_HOLD_DAYS = 120;

export {
  creditCallsFor,
  EarningCreditRefused,
  type EarningCreditError,
  type PackRate,
} from './credit';
export {
  normalizePayeeEmail,
  PAYOUT_METHOD,
  PAYOUT_REFERENCE_MAX_LENGTH,
  PAYOUT_STATUSES,
  PayoutRefused,
  PayoutResolveRefused,
  type PayoutError,
  type PayoutResolveError,
  type PayoutStatus,
} from './payout';

/**
 * The earning period an event lands in: the platform's revenue period, a UTC
 * calendar month (revenue_period rows key settlement by it). Not the
 * subscriber's billing period -- statements close for everyone at once.
 */
export function revenuePeriodId(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The `count` periods ending with the one `at` falls in, oldest first. */
export function recentPeriodIds(at: Date, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    revenuePeriodId(
      new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - (count - 1 - index), 1)),
    ),
  );
}

/**
 * requirement.md 4.2: plan allowance first, then the non-expiring pack balance.
 * Returns null when both are exhausted, which the caller maps to quota_exceeded.
 */
export type DebitSource = 'plan' | 'addon';

export function nextDebitSource(input: {
  planAllowanceRemaining: number;
  addonBalanceRemaining: number;
}): DebitSource | null {
  if (input.planAllowanceRemaining > 0) return 'plan';
  if (input.addonBalanceRemaining > 0) return 'addon';
  return null;
}

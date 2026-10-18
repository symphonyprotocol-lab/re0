/**
 * Domain layer. Pure TypeScript.
 *
 * Must not import Next.js, Vercel, Neon, Drizzle, Payment, AI SDK or chain SDK.
 * See architecture.md 4.
 */

export type Visibility = 'public' | 'private';

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
  | 'llms_txt'
  | 'markdown'
  | 'pdf'
  | 'openapi'
  | 'notion';

/** requirement.md 7.3.2: these source types have no claim flow; the creator owns them. */
export const SELF_OWNED_SOURCE_TYPES: readonly SourceType[] = [
  'markdown',
  'pdf',
  'notion',
];

/**
 * The mirror of `SELF_OWNED_SOURCE_TYPES`: the source types a claim may name.
 * A query that has to exclude the rest asks for this list rather than
 * restating which three have no claim flow. It must stay in step with
 * `claimMethodsFor` -- a type advertising a method it cannot be claimed
 * through, or the reverse, is a dead end on the claim form.
 */
export const CLAIMABLE_SOURCE_TYPES: readonly SourceType[] = [
  'github',
  'website',
  'llms_txt',
  'openapi',
];

export function claimMethodsFor(type: SourceType): readonly ClaimMethod[] {
  switch (type) {
    case 'github':
      return ['github_permission', 'dns_txt', 'well_known'];
    /* An OpenAPI document is fetched from a host like a website is, and its
       creation is gated on the same domain challenge (lib/domain/domain-verification.ts). */
    case 'website':
    case 'llms_txt':
    case 'openapi':
      return ['dns_txt', 'well_known'];
    default:
      return [];
  }
}

export function requiresClaim(type: SourceType): boolean {
  return claimMethodsFor(type).length > 0;
}

/**
 * requirement.md 6.2: a library is queryable only when published, its current
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
 * requirement.md 4.4 and 7.3.6: only claimed public user libraries earn.
 * Platform libraries, private libraries and unclaimed libraries do not,
 * and unclaimed traffic must not dilute other publishers either.
 */
/**
 * publisher-revenue-share.md 5: a caller workspace's attributable calls to
 * one library are capped per day; calls past the cap bill normally but earn
 * nothing, so buying traffic to one's own catalogue stops paying at the cap.
 * The share doc leaves the number open until real distributions exist and
 * says to launch conservative -- this is that conservative value.
 */
export const DAILY_ATTRIBUTABLE_CALL_CAP = 200;

/**
 * publisher-revenue-share.md 3.4: below this a period's earnings roll over.
 *
 * $5, down from $20 on 2026-10-05. At Pro's price an attributable call earns
 * at most $0.0002, so $20 was on the order of a hundred thousand calls to one
 * library -- a threshold the long tail the share exists for would never reach.
 */
export const PAYOUT_THRESHOLD_MINOR = 500;
/** publisher-revenue-share.md 3.4: the refund/chargeback window before payout. */
export const PAYOUT_HOLD_DAYS = 45;

export {
  creditCallsFor,
  EarningCreditRefused,
  type EarningCreditError,
  type PackRate,
} from './credit';

/**
 * The earning period an event lands in: the platform's revenue period, a UTC
 * calendar month (revenue_period rows key settlement by it). Not the
 * caller's subscription period -- the pool is computed platform-wide.
 */
export function revenuePeriodId(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * requirement.md 4.4 and expert-library-prd.md 4.4: a served call earns only
 * for a claimed, published public user library that carries the expert tag
 * and whose owner is on a paid plan right now. The tag is the console's
 * judgment that the content is worth paying for; the subscription is the
 * owner's standing in the programme. Both are read at call time, so a lapsed
 * subscription or a library made private stops earning at once and resumes
 * by itself -- the tag is not withdrawn for either.
 */
export function isRevenueEligible(input: {
  visibility: Visibility;
  lifecycleStatus: LifecycleStatus;
  ownerWorkspaceId: string | null;
  isPlatformLibrary: boolean;
  expertTaggedAt: Date | null;
  ownerSubscribed: boolean;
}): boolean {
  return (
    input.visibility === 'public' &&
    input.lifecycleStatus === 'published' &&
    input.ownerWorkspaceId !== null &&
    !input.isPlatformLibrary &&
    input.expertTaggedAt !== null &&
    input.ownerSubscribed
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

/** requirement.md 4.4: pool = net revenue * share rate * attributable share. */
export function allocatablePoolMinor(input: {
  netRevenueMinor: number;
  shareRateBps: number;
  totalAttributableCalls: number;
  totalBilledCalls: number;
}): number {
  if (input.totalBilledCalls <= 0) return 0;
  const attributableShare = input.totalAttributableCalls / input.totalBilledCalls;
  return Math.floor(
    (input.netRevenueMinor * input.shareRateBps * attributableShare) / 10_000,
  );
}

/**
 * requirement.md 4.4: linear in attributable calls. Never weighted by Trust Score --
 * scores decide eligibility, not amount.
 */
export function settlementAmountMinor(input: {
  poolMinor: number;
  libraryAttributableCalls: number;
  totalAttributableCalls: number;
}): number {
  if (input.totalAttributableCalls <= 0) return 0;
  return Math.floor(
    (input.poolMinor * input.libraryAttributableCalls) / input.totalAttributableCalls,
  );
}

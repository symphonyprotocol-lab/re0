import { allocatablePoolMinor, isRevenueEligible, settlementAmountMinor } from '@/lib/domain';

/**
 * Publisher revenue share. publisher-revenue-share.md, architecture.md 11.4.
 *
 * Invariants that must survive any refactor:
 * - the earning event is written in the same transaction as the usage event
 * - only query-docs is attributable; resolve-library-id and anonymous trials are not
 * - the library must have an owner, so unclaimed libraries earn nothing and do
 *   not dilute anyone else
 * - allocation is linear in attributable calls, never weighted by Trust Score
 * - retrieval must never read any earnings field
 */

export { allocatablePoolMinor, settlementAmountMinor, isRevenueEligible };

export function isAttributableCall(input: {
  operation: string;
  anonymous: boolean;
  callerWorkspaceId: string | null;
  library: {
    visibility: 'public' | 'private';
    lifecycleStatus: string;
    ownerWorkspaceId: string | null;
    isPlatformLibrary: boolean;
    /** expert-library-prd.md 4.4: the tag, and the owner's paid plan, at call time. */
    expertTaggedAt: Date | null;
    ownerSubscribed: boolean;
  };
  returnedChunks: number;
  flagged: boolean;
}): boolean {
  if (input.operation !== 'query-docs') return false;
  if (input.anonymous) return false;
  if (input.returnedChunks <= 0) return false;
  if (input.flagged) return false;
  if (
    !isRevenueEligible({
      visibility: input.library.visibility,
      lifecycleStatus: input.library.lifecycleStatus as never,
      ownerWorkspaceId: input.library.ownerWorkspaceId,
      isPlatformLibrary: input.library.isPlatformLibrary,
      expertTaggedAt: input.library.expertTaggedAt,
      ownerSubscribed: input.library.ownerSubscribed,
    })
  ) {
    return false;
  }
  // Self-serving traffic does not earn.
  return input.callerWorkspaceId !== input.library.ownerWorkspaceId;
}

export {
  closePeriod,
  livePeriodPool,
  type ClosedPeriod,
  type PeriodAllocation,
  type PeriodPool,
} from './close-period';
export {
  acceptPublisherAgreement,
  publisherEarnings,
  type PublisherEarnings,
  type PublisherLibraryEarning,
  type PublisherPeriodEarning,
} from './publisher-earnings';
export {
  canRedeemEarnings,
  earningCredit,
  redeemEarningsAsCalls,
  redeemedByTag,
  type EarningCredit,
  type EarningRedemption,
  type RedeemActor,
  type RedeemedEarnings,
} from './redeem-credit';

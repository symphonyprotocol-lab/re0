/**
 * Creator earnings: the amount ledger, its monthly close, and the two ways a
 * statement leaves the books. agent-first-proposal.md 6.9, architecture.md
 * 11.4.
 *
 * Invariants that must survive any refactor:
 * - every `earning_event` carries its own amount; the close sums, it never
 *   allocates from a pool
 * - a locked period is frozen: a re-run returns the stored numbers
 * - a statement is discharged once, as calls or as cash, after the hold
 * - retrieval never reads any earnings field
 */

export { closePeriod, type ClosedPeriod, type PeriodAllocation } from './close-period';
export {
  acceptPublisherAgreement,
  publisherDailyEarnings,
  publisherEarnings,
  type PublisherDayEarning,
  type PublisherEarnings,
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
export {
  earningPayouts,
  requestPayout,
  type EarningPayouts,
  type PublisherPayout,
  type RequestedPayout,
} from './payout';
export {
  creatorBalance,
  hasNegativeBalance,
  periodIdOf,
  writeOffNegativeBalance,
  type CreatorBalance,
} from './balance';
export { pendingTaxDocuments, savePayoutProfile, submitTaxDocument, verifyTaxDocument, type TaxFormKind } from './payout-profile';

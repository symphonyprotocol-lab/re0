/**
 * Earnings redeemed as Additional Calls. publisher-revenue-share.md 3.4.
 *
 * The collection provider cannot pay a third party, so the first way a
 * publisher's settled statements leave the books is as calls on their own
 * workspace: the amount buys Additional Calls at the current pack rate, and
 * the resulting grant is spent like any bought pack. No money moves and the
 * platform holds no balance, which is why these rules are pure arithmetic
 * over figures the ledger already has.
 *
 * What this module does not decide: which statements are redeemable. That is
 * `holdEndsAt` in lib/domain/admin -- the hold window counted from the period
 * lock is the same whether a statement ends as cash or as calls, because it
 * exists to cover refunds, and a refunded call that was already spent as
 * credit is as gone as one paid out.
 */

export interface PackRate {
  /** What one Additional Calls pack costs on the version in force. */
  priceMinor: number;
  /** How many calls that pack grants. */
  calls: number;
}

/**
 * How many calls an amount buys at the pack rate, rounded down.
 *
 * The threshold the payout rail needs ($5, a channel-fee floor) does not
 * apply: redeeming costs nothing per transaction. The only floor is one whole
 * call, and below it nothing is redeemed -- the amount stays accrued rather
 * than being spent on zero calls.
 */
export function creditCallsFor(amountMinor: number, pack: PackRate): number {
  if (amountMinor <= 0 || pack.priceMinor <= 0 || pack.calls <= 0) return 0;
  return Math.floor((amountMinor * pack.calls) / pack.priceMinor);
}

export type EarningCreditError =
  /** The workspace has not accepted the publisher agreement. */
  | 'no_account'
  /** No Additional Calls version to price the conversion with. */
  | 'no_pack_rate'
  /** Nothing accrued is past its hold, or the total buys less than one call. */
  | 'nothing_redeemable';

export class EarningCreditRefused extends Error {
  constructor(
    readonly code: EarningCreditError,
    message: string,
  ) {
    super(message);
    this.name = 'EarningCreditRefused';
  }
}

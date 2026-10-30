/**
 * Cash payouts, paid by hand. agent-first-proposal.md 6.9.
 *
 * No payout service is connected, so cash leaves the books the slow way: the
 * creator asks for everything past its hold to be sent to a PayPal address,
 * an operator sends it from the platform's PayPal account and records the
 * transaction id. These are the rules both ends share; which statements a
 * request covers is the same hold test the credit path uses.
 *
 * The payee is a PayPal email and nothing else. An email moves no money on
 * its own, so storing it does not break the rule that the platform keeps no
 * card or bank details.
 */

import { EMAIL_SHAPE } from './showcase';

export const PAYOUT_STATUSES = ['requested', 'paid', 'failed'] as const;

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/** The rail. Manual PayPal is the only one. */
export const PAYOUT_METHOD = 'paypal';

const EMAIL_MAX_LENGTH = 254;

/** The PayPal address as stored, or null when it cannot be one. */
export function normalizePayeeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH || !EMAIL_SHAPE.test(email)) {
    return null;
  }
  return email;
}

/** The operator's PayPal transaction id: what makes a `paid` row checkable. */
export const PAYOUT_REFERENCE_MAX_LENGTH = 120;

export type PayoutError =
  /** The workspace has not accepted the publisher agreement. */
  | 'no_account'
  /** Not something PayPal could send to. */
  | 'invalid_email'
  /** What is past its hold on a library that still earns is under the threshold. */
  | 'below_threshold'
  /** A request is already waiting for an operator. */
  | 'payout_pending'
  /** A chargeback took back income already paid out; nothing leaves until it clears (6.9). */
  | 'negative_balance'
  /** No PayPal address, or the tax document is not verified yet: income accrues, nothing is paid (6.9). */
  | 'profile_incomplete';

export class PayoutRefused extends Error {
  constructor(
    readonly code: PayoutError,
    message: string,
  ) {
    super(message);
    this.name = 'PayoutRefused';
  }
}

/**
 * Why an operator could not resolve a payout. Kept apart from the console's
 * `AdminChangeError`, which every administrator form maps exhaustively.
 */
export type PayoutResolveError =
  | 'not_found'
  /** Already marked paid or failed; only a `requested` payout may be. */
  | 'payout_resolved'
  /** Marking it paid needs the PayPal transaction id. */
  | 'reference_required'
  | 'invalid_input';

export class PayoutResolveRefused extends Error {
  constructor(
    readonly code: PayoutResolveError,
    message: string,
  ) {
    super(message);
    this.name = 'PayoutResolveRefused';
  }
}

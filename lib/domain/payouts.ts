/**
 * Manual PayPal payouts (rebuild-proposal.md 2.3, 8.4 step 6, prototype
 * manual-kyc.js `recordPayoutResult`, workspace.js `creatorPayoutStatus`):
 * the PayPal address, who may request what, the status machine and the
 * payment an administrator records. No PayPal API is called anywhere: the
 * money moves outside the system and is written down here.
 *
 * pending ── approve ──▶ approved ── paid ──▶ paid
 *    │                      │
 *    └─ reject ─▶ rejected  └─ failed ─▶ failed
 *
 * `pending` and `approved` hold the credits; rejection and failure release
 * them once, payment settles them. Every other status is final.
 */
import { CREDIT_USD, PAYOUT_MIN_CREDITS, PAYOUT_TRANSFER_ID_MAX, PAYPAL_CHANGE_HOLD_DAYS, PAYPAL_EMAIL_MAX } from '@/lib/constants';
import type { PayoutStatus } from '@/db/schema';
import type { KycState } from '@/lib/domain/kyc';

export type { PayoutStatus };
export const OPEN_PAYOUT_STATUSES = ['pending', 'approved'] as const satisfies readonly PayoutStatus[];

const DAY = 24 * 60 * 60 * 1000;
/** Ported from the old `EMAIL_SHAPE`: something, an @, a dotted domain, no blanks. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isOpenPayout(status: PayoutStatus): boolean {
  return (OPEN_PAYOUT_STATUSES as readonly string[]).includes(status);
}

/** The PayPal address as stored (trimmed, lower case), or null when it cannot be one. */
export function normalizePaypalEmail(raw: unknown): string | null {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email || email.length > PAYPAL_EMAIL_MAX || !EMAIL_SHAPE.test(email)) return null;
  return email;
}

/**
 * Payouts wait seven days after the address changes; setting the first one
 * starts no wait (prototype `paypalModal`). `changedAt` is null until a
 * change.
 */
export function paypalHoldUntil(changedAt: Date | null | undefined): Date | null {
  return changedAt ? new Date(changedAt.getTime() + PAYPAL_CHANGE_HOLD_DAYS * DAY) : null;
}

export function paypalOnHold(changedAt: Date | null | undefined, now: Date): boolean {
  const until = paypalHoldUntil(changedAt);
  return until !== null && until.getTime() > now.getTime();
}

/**
 * Where a user stands (the dashboard guide and the billing card), in the
 * prototype's order: a payout in progress first, then identity, the PayPal
 * address, its seven-day hold, and the threshold.
 */
export type PayoutStage = 'official' | 'review' | 'payment' | 'identity_required' | 'identity_pending' | 'paypal' | 'hold' | 'threshold' | 'eligible';

export function payoutStage(input: {
  official: boolean;
  kyc: KycState;
  open: PayoutStatus | null;
  paypalEmail: string | null;
  paypalChangedAt: Date | null;
  withdrawable: number;
  now: Date;
}): PayoutStage {
  if (input.official) return 'official';
  if (input.open === 'approved') return 'payment';
  if (input.open === 'pending') return 'review';
  if (input.kyc === 'pending') return 'identity_pending';
  if (input.kyc !== 'verified') return 'identity_required';
  if (!input.paypalEmail) return 'paypal';
  if (paypalOnHold(input.paypalChangedAt, input.now)) return 'hold';
  return input.withdrawable >= PAYOUT_MIN_CREDITS ? 'eligible' : 'threshold';
}

/** What refuses a request at a given stage; `eligible` refuses nothing. */
export const STAGE_REFUSALS: Record<Exclude<PayoutStage, 'eligible'>, string> = {
  official: 'official',
  review: 'payout_open',
  payment: 'payout_open',
  identity_required: 'kyc_required',
  identity_pending: 'kyc_pending',
  paypal: 'paypal_required',
  hold: 'paypal_hold',
  threshold: 'below_minimum',
};

/** Whole credits, at least the minimum, at most what the earned grants hold (default: all of it). */
export function parsePayoutCredits(raw: unknown, withdrawable: number): number | { error: 'amount' | 'below_minimum' | 'over_balance' } {
  const value = raw === undefined || raw === null || raw === '' ? withdrawable : typeof raw === 'string' ? Number(raw.replaceAll(',', '')) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return { error: 'amount' };
  if (value < PAYOUT_MIN_CREDITS) return { error: 'below_minimum' };
  if (value > withdrawable) return { error: 'over_balance' };
  return value;
}

/** US cents for a number of credits (1 credit = USD 0.0001); may carry a fraction of a cent. */
export function creditsToCents(credits: number): number {
  return Math.round(credits * CREDIT_USD * 100 * 1e6) / 1e6;
}

/**
 * The amount that reached the user, typed in dollars with at most two
 * decimals: more than zero and not more than requested. The fee is the
 * rest, kept in credits so it is exact for any request.
 */
export function parsePaidAmount(raw: unknown, credits: number): { paidCents: number; feeCredits: number } | { error: 'paid_amount' } {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim().replaceAll(',', '') : '';
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return { error: 'paid_amount' };
  const paidCents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (paidCents <= 0 || paidCents * 100 > credits) return { error: 'paid_amount' };
  return { paidCents, feeCredits: credits - paidCents * 100 };
}

/** The fee shown live while the amount is typed: requested − paid, or null while the amount is invalid. */
export function liveFeeCents(raw: unknown, credits: number): number | null {
  const parsed = parsePaidAmount(raw, credits);
  return 'error' in parsed ? null : creditsToCents(parsed.feeCredits);
}

/** PayPal's transaction id, as the administrator copied it: printable, no blanks, ≤ 100. */
export function parseTransferId(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value.length > PAYOUT_TRANSFER_ID_MAX || !/^[\x21-\x7e]+$/.test(value)) return null;
  return value;
}

export type PayoutDecision = 'approved' | 'rejected' | 'paid' | 'failed';

const NEXT: Record<PayoutStatus, readonly PayoutDecision[]> = {
  pending: ['approved', 'rejected'],
  approved: ['paid', 'failed'],
  rejected: [],
  paid: [],
  failed: [],
};

export function canMove(from: PayoutStatus, to: PayoutDecision): boolean {
  return NEXT[from].includes(to);
}

/** Rejection and failure give the credits back; approval keeps them held; payment spends them. */
export function releasesHold(to: PayoutDecision): boolean {
  return to === 'rejected' || to === 'failed';
}

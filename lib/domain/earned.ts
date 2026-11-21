/**
 * Earned credits besides a payout (docs/design/earned-credits.md), free of
 * the database: the console's settings, a conversion into Pack credits, and
 * a deduction from the price of a Plan or Pack.
 *
 * Earned credits are never spent by using the product (SPENDABLE_SOURCES).
 * A conversion turns them into Pack credits at `convertRateBp` / 10,000,
 * rounded down; it cannot be undone. A deduction pays `deductCreditsPerCent`
 * earned credits for each US cent of the price, in whole cents, at most
 * `deductMaxPercent` of it, and leaves either nothing to pay (no Paddle at
 * all) or at least `deductMinChargeMinor` for Paddle to charge.
 */
import { EARNED_BOUNDS, EARNED_DEFAULTS } from '@/lib/constants';

export interface EarnedSettings {
  convertEnabled: boolean;
  convertRateBp: number;
  convertMinCredits: number;
  deductEnabled: boolean;
  deductCreditsPerCent: number;
  deductMaxPercent: number;
  deductMinChargeMinor: number;
}

export const DEFAULT_EARNED_SETTINGS: EarnedSettings = { ...EARNED_DEFAULTS };

const NUMERIC = ['convertRateBp', 'convertMinCredits', 'deductCreditsPerCent', 'deductMaxPercent', 'deductMinChargeMinor'] as const;

/** The console's form as settings, or null when anything is missing or out of bounds. */
export function parseEarnedSettings(raw: Record<string, unknown>): EarnedSettings | null {
  if (typeof raw.convertEnabled !== 'boolean' || typeof raw.deductEnabled !== 'boolean') return null;
  const out: Partial<EarnedSettings> = { convertEnabled: raw.convertEnabled, deductEnabled: raw.deductEnabled };
  for (const key of NUMERIC) {
    const value = raw[key];
    const bounds = EARNED_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max) return null;
    out[key] = value;
  }
  return out as EarnedSettings;
}

/** Pack credits a conversion of `earned` credits yields: rounded down, so a conversion never makes credits from rounding. */
export function convertedCredits(earned: number, rateBp: number): number {
  return Number((BigInt(earned) * BigInt(rateBp)) / 10_000n);
}

/**
 * Splits what a conversion yields between the parts converted from earned
 * credits a payout could draw on (paid for by askers; one part per funding
 * source, so each stays traceable) and the part from earnings paid with free
 * credits: each paid part is rounded down on its own and the free part takes
 * what is left of the rounded total, so paid parts never gain from rounding.
 */
export function splitConversion(paidEarned: readonly number[], freeEarned: number, rateBp: number): { paid: number[]; free: number } {
  const total = convertedCredits(paidEarned.reduce((sum, part) => sum + part, 0) + freeEarned, rateBp);
  const paid = paidEarned.map((part) => convertedCredits(part, rateBp));
  return { paid, free: total - paid.reduce((sum, part) => sum + part, 0) };
}

export type ConvertRefusal = 'convert_disabled' | 'invalid_amount' | 'below_minimum' | 'rate_changed' | 'insufficient_earned';

/** Whether `credits` may be converted under `settings`, before the balance is read. */
export function checkConversion(credits: unknown, settings: EarnedSettings, quotedRateBp: unknown): { ok: true; credits: number } | { ok: false; error: ConvertRefusal } {
  if (!settings.convertEnabled) return { ok: false, error: 'convert_disabled' };
  if (typeof credits !== 'number' || !Number.isSafeInteger(credits) || credits <= 0) return { ok: false, error: 'invalid_amount' };
  /* The rate the dialog showed is required: nobody converts at a rate they did not see (review S5). */
  if (quotedRateBp !== settings.convertRateBp) return { ok: false, error: 'rate_changed' };
  if (credits < settings.convertMinCredits) return { ok: false, error: 'below_minimum' };
  if (convertedCredits(credits, settings.convertRateBp) === 0) return { ok: false, error: 'below_minimum' };
  return { ok: true, credits };
}

/**
 * The most a checkout of `priceMinor` (before tax, after any promotion) may
 * take off with earned credits: the cap, what the deductible balance covers,
 * and never leaving less than Paddle's minimum to pay (then it takes off a
 * little less instead, or nothing if that is all it could).
 */
export function maxDeductionMinor(priceMinor: number, deductible: number, settings: EarnedSettings): number {
  if (!settings.deductEnabled || priceMinor <= 0) return 0;
  const cap = Math.floor((priceMinor * settings.deductMaxPercent) / 100);
  let most = Math.min(cap, Math.floor(deductible / settings.deductCreditsPerCent));
  const left = priceMinor - most;
  if (left > 0 && left < settings.deductMinChargeMinor) most = Math.max(0, priceMinor - settings.deductMinChargeMinor);
  return Math.max(0, most);
}

export type DeductionRefusal = 'deduction_disabled' | 'invalid_deduction' | 'deduction_too_large' | 'deduction_leaves_too_little' | 'insufficient_earned';

export interface Deduction {
  /** US cents taken off the price. */
  minor: number;
  /** Earned credits that pay for them. */
  credits: number;
  /** What is left for Paddle to charge, before tax; 0 means no Paddle at all. */
  payMinor: number;
}

/** A checkout's requested deduction (`earnedMinor`, US cents), checked against the price, the settings and the deductible balance. */
export function planDeduction(
  requested: unknown,
  priceMinor: number,
  deductible: number,
  settings: EarnedSettings,
): { ok: true; deduction: Deduction } | { ok: false; error: DeductionRefusal } {
  if (requested === undefined || requested === null || requested === 0) return { ok: true, deduction: { minor: 0, credits: 0, payMinor: priceMinor } };
  if (!settings.deductEnabled) return { ok: false, error: 'deduction_disabled' };
  if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 0) return { ok: false, error: 'invalid_deduction' };
  if (requested > Math.floor((priceMinor * settings.deductMaxPercent) / 100)) return { ok: false, error: 'deduction_too_large' };
  const payMinor = priceMinor - requested;
  if (payMinor > 0 && payMinor < settings.deductMinChargeMinor) return { ok: false, error: 'deduction_leaves_too_little' };
  const credits = requested * settings.deductCreditsPerCent;
  if (credits > deductible) return { ok: false, error: 'insufficient_earned' };
  return { ok: true, deduction: { minor: requested, credits, payMinor } };
}

/**
 * The earned credits a refund of `adjustmentMinor` (of the `amountMinor`
 * paid through Paddle) gives back: the same share of what the deduction
 * paid, never past what is still unreturned. A full refund returns the rest.
 */
export function returnedEarned(purchase: { amountMinor: number; earnedCredits: number; earnedReturned: number }, adjustmentMinor: number): number {
  const open = purchase.earnedCredits - purchase.earnedReturned;
  if (open <= 0 || !Number.isSafeInteger(adjustmentMinor) || adjustmentMinor <= 0) return 0;
  if (purchase.amountMinor <= 0 || adjustmentMinor >= purchase.amountMinor) return open;
  const total = BigInt(purchase.amountMinor);
  const share = (BigInt(purchase.earnedCredits) * BigInt(adjustmentMinor) + total / 2n) / total;
  return Math.min(open, Number(share));
}

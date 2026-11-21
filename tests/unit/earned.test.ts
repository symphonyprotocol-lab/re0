/** Earned credits besides a payout (docs/design/earned-credits.md): never spent, conversion, deductions, refunds. */
import { describe, expect, it } from 'vitest';
import { allocate, availableOf, InsufficientCredits, isDeductible, spendOrder, type SpendableGrant } from '@/lib/domain/credits';
import { takeBack } from '@/lib/domain/billing';
import {
  checkConversion,
  convertedCredits,
  DEFAULT_EARNED_SETTINGS,
  maxDeductionMinor,
  parseEarnedSettings,
  planDeduction,
  returnedEarned,
  splitConversion,
} from '@/lib/domain/earned';
import { checkoutTransactionBody, type PaddleConfig } from '@/lib/infra/paddle';

const now = new Date('2026-11-21T00:00:00Z');
const DAY = 86_400_000;
const grant = (id: string, source: SpendableGrant['source'], remaining: number, extra: Partial<SpendableGrant> = {}): SpendableGrant => ({
  id,
  source,
  remaining,
  expiresAt: source === 'plan' ? new Date('2026-12-01T00:00:00Z') : null,
  createdAt: new Date(now.getTime() - 1000),
  ...extra,
});

describe('earned credits are not spent', () => {
  const grants = [grant('earned', 'earned', 5_000, { withdrawableAt: now }), grant('pack', 'pack', 100), grant('welcome', 'welcome', 50)];

  it('leaves earned credits out of the balance and of every charge', () => {
    expect(availableOf(grants, now)).toBe(150);
    expect(allocate(grants, 150, now).map((entry) => entry.source)).toEqual(['welcome', 'pack']);
    expect(() => allocate(grants, 151, now)).toThrow(InsufficientCredits);
    expect(spendOrder(grants, now).some((entry) => entry.source === 'earned')).toBe(false);
  });

  it('takes earned credits only when the caller names them', () => {
    expect(availableOf(grants, now, ['earned'])).toBe(5_000);
    expect(allocate(grants, 4_000, now, ['earned'])).toEqual([{ grantId: 'earned', source: 'earned', amount: 4_000 }]);
  });

  it('a refund take-back still reaches earned credits, last', () => {
    const { allocations, shortfall } = takeBack(grants, null, 200, now);
    expect(allocations.map((entry) => [entry.source, entry.amount])).toEqual([['welcome', 50], ['pack', 100], ['earned', 50]]);
    expect(shortfall).toBe(0);
  });

  it('takes earned credits never withdrawable first, then the latest to mature, withdrawable ones last', () => {
    const earned = [
      grant('now', 'earned', 10, { withdrawableAt: new Date(now.getTime() - DAY) }),
      grant('later', 'earned', 10, { withdrawableAt: new Date(now.getTime() + 20 * DAY) }),
      grant('never', 'earned', 10, { withdrawableAt: null }),
    ];
    expect(allocate(earned, 30, now, ['earned']).map((entry) => entry.grantId)).toEqual(['never', 'later', 'now']);
    /* Only what a payout could draw on pays for a purchase (review B1). */
    expect(earned.filter((entry) => isDeductible(entry, now)).map((entry) => entry.id)).toEqual(['now']);
  });
});

describe('conversion', () => {
  it('rounds down, and the paid part never gains from rounding', () => {
    expect(convertedCredits(5_000, 10_000)).toBe(5_000);
    expect(convertedCredits(333, 5_000)).toBe(166);
    expect(splitConversion([333], 333, 5_000)).toEqual({ paid: [166], free: 167 });
    expect(splitConversion([111, 111, 111], 0, 5_000)).toEqual({ paid: [55, 55, 55], free: 1 });
    expect(splitConversion([], 101, 10_000)).toEqual({ paid: [], free: 101 });
  });

  it('checks the switch, the amount, the minimum and the rate the dialog showed', () => {
    const settings = DEFAULT_EARNED_SETTINGS;
    expect(checkConversion(500, settings, 10_000)).toEqual({ ok: true, credits: 500 });
    /* The rate is required (review S5). */
    expect(checkConversion(500, settings, undefined)).toEqual({ ok: false, error: 'rate_changed' });
    expect(checkConversion(99, settings, 10_000)).toEqual({ ok: false, error: 'below_minimum' });
    expect(checkConversion(1.5, settings, 10_000)).toEqual({ ok: false, error: 'invalid_amount' });
    expect(checkConversion('500', settings, 10_000)).toEqual({ ok: false, error: 'invalid_amount' });
    expect(checkConversion(500, settings, 5_000)).toEqual({ ok: false, error: 'rate_changed' });
    expect(checkConversion(500, { ...settings, convertEnabled: false }, 10_000)).toEqual({ ok: false, error: 'convert_disabled' });
    /* A rate so low the conversion would yield nothing is refused rather than eating the credits. */
    expect(checkConversion(100, { ...settings, convertRateBp: 1 }, 1)).toEqual({ ok: false, error: 'below_minimum' });
  });
});

describe('deductions', () => {
  const settings = DEFAULT_EARNED_SETTINGS;

  it('pays 100 earned credits per cent, in whole cents, within the balance', () => {
    expect(planDeduction(50, 1_000, 5_000, settings)).toEqual({ ok: true, deduction: { minor: 50, credits: 5_000, payMinor: 950 } });
    expect(planDeduction(51, 1_000, 5_000, settings)).toEqual({ ok: false, error: 'insufficient_earned' });
    expect(planDeduction(undefined, 1_000, 0, settings)).toEqual({ ok: true, deduction: { minor: 0, credits: 0, payMinor: 1_000 } });
    expect(planDeduction(-1, 1_000, 5_000, settings)).toEqual({ ok: false, error: 'invalid_deduction' });
    expect(planDeduction(0.5, 1_000, 5_000, settings)).toEqual({ ok: false, error: 'invalid_deduction' });
  });

  it('pays all of it, or leaves at least the Paddle minimum', () => {
    expect(planDeduction(1_000, 1_000, 100_000, settings)).toEqual({ ok: true, deduction: { minor: 1_000, credits: 100_000, payMinor: 0 } });
    expect(planDeduction(950, 1_000, 100_000, settings)).toEqual({ ok: false, error: 'deduction_leaves_too_little' });
    expect(planDeduction(900, 1_000, 100_000, settings)).toMatchObject({ ok: true });
    expect(planDeduction(1_001, 1_000, 200_000, settings)).toEqual({ ok: false, error: 'deduction_too_large' });
    expect(planDeduction(600, 1_000, 100_000, { ...settings, deductMaxPercent: 50 })).toEqual({ ok: false, error: 'deduction_too_large' });
    expect(planDeduction(10, 1_000, 100_000, { ...settings, deductEnabled: false })).toEqual({ ok: false, error: 'deduction_disabled' });
  });

  it('offers the most it may take', () => {
    expect(maxDeductionMinor(1_000, 5_000, settings)).toBe(50);
    expect(maxDeductionMinor(1_000, 1_000_000, settings)).toBe(1_000);
    /* 95,000 earned would leave 50 cents: it offers 9.00 instead. */
    expect(maxDeductionMinor(1_000, 95_000, settings)).toBe(900);
    /* An 80-cent price: 50 off would leave 30, below the minimum, so nothing is offered. */
    expect(maxDeductionMinor(80, 5_000, settings)).toBe(0);
    expect(maxDeductionMinor(1_000, 1_000_000, { ...settings, deductMaxPercent: 50 })).toBe(500);
    expect(maxDeductionMinor(1_000, 1_000_000, { ...settings, deductEnabled: false })).toBe(0);
  });

  it('gives earned credits back in the share of a refund', () => {
    const purchase = { amountMinor: 950, earnedCredits: 5_000, earnedReturned: 0 };
    expect(returnedEarned(purchase, 950)).toBe(5_000);
    expect(returnedEarned(purchase, 475)).toBe(2_500);
    expect(returnedEarned({ ...purchase, earnedReturned: 2_500 }, 950)).toBe(2_500);
    expect(returnedEarned({ ...purchase, earnedCredits: 0 }, 950)).toBe(0);
  });

  it('puts the deduction and any promotion into one non-recurring discount', () => {
    const config = { planPriceId: 'pri_plan', packPriceId: 'pri_pack', checkoutUrl: 'http://localhost/checkout' } as PaddleConfig;
    const price = { priceId: 'pri_pack', priceMinor: 700, regularPriceMinor: 1_000 };
    const body = checkoutTransactionBody(config, { kind: 'pack', quantity: 2 }, 'user', price, 150);
    expect(body).toMatchObject({ discount: { type: 'flat', amount: '750', recur: false }, custom_data: { re0_earned_minor: 150 } });
    expect(checkoutTransactionBody(config, { kind: 'pack', quantity: 2 }, 'user', price)).toMatchObject({ discount: { type: 'flat_per_seat', amount: '300' } });
    expect('discount' in checkoutTransactionBody(config, { kind: 'plan', quantity: 1 }, 'user', { priceId: 'pri_plan', priceMinor: 1_000, regularPriceMinor: 1_000 })).toBe(false);
  });
});

describe('the console settings', () => {
  it('accepts values within bounds only', () => {
    const ok = { convertEnabled: true, deductEnabled: false, convertRateBp: 5_000, convertMinCredits: 100, deductCreditsPerCent: 100, deductMaxPercent: 100, deductMinChargeMinor: 100 };
    expect(parseEarnedSettings(ok)).toEqual(ok);
    expect(parseEarnedSettings({ ...ok, deductMaxPercent: 101 })).toBeNull();
    expect(parseEarnedSettings({ ...ok, convertRateBp: 0 })).toBeNull();
    expect(parseEarnedSettings({ ...ok, convertEnabled: 'yes' })).toBeNull();
  });
});

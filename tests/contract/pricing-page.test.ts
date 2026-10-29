/**
 * The pricing page's figures come from the plan versions in force
 * (lib/domain/pricing-page.ts), so a price raised in the console is the price
 * the page prints -- the same one checkout charges. Storage comes from the
 * two tiers in lib/domain/plans.ts, which no version carries.
 */
import { describe, expect, it } from 'vitest';
import { FALLBACK_PRICING, formatCapacity, formatUsd, pricingFigures } from '@/lib/domain/pricing-page';
import { BYTES_PER_MB } from '@/lib/domain/plans';

const number = new Intl.NumberFormat('en');

describe('pricing figures', () => {
  it('prints the live price and allowance, not a copy of them', () => {
    const raised = {
      ...FALLBACK_PRICING,
      addon: { ...FALLBACK_PRICING.addon, priceMinor: 1_000, monthlyCalls: 8_000 },
      free: { ...FALLBACK_PRICING.free, monthlyCalls: 2_000 },
    };
    const figures = pricingFigures(raised, number);
    expect(figures.addon.price).toBe('$10');
    expect(figures.addon.calls).toBe('8,000');
    expect(figures.free.price).toBe('$0');
    expect(figures.free.calls).toBe('2,000');
  });

  it('formats cents only when there are some', () => {
    expect(formatUsd(950, number)).toBe('$9.50');
    expect(formatUsd(1_000_000, number)).toBe('$10,000');
  });

  it('carries the key ceiling and build rate the version sets', () => {
    const figures = pricingFigures(FALLBACK_PRICING, number);
    expect(figures.free.keys).toBe('20');
    expect(figures.free.tokens).toBe('20,000');
    expect(figures.free.base).toBe('1');
    expect(figures.free.pages).toBe('5');
  });

  it('prints the two storage tiers beside the plans', () => {
    const figures = pricingFigures(FALLBACK_PRICING, number);
    expect(figures.storage).toEqual({ base: '500 MB', extended: '2 GB' });
  });
});

describe('formatCapacity', () => {
  it('prints whole gigabytes as GB and everything else in MB', () => {
    expect(formatCapacity(500 * BYTES_PER_MB, number)).toBe('500 MB');
    expect(formatCapacity(1_024 * BYTES_PER_MB, number)).toBe('1 GB');
    expect(formatCapacity(1_536 * BYTES_PER_MB, number)).toBe('1,536 MB');
    expect(formatCapacity(0, number)).toBe('0 MB');
  });
});

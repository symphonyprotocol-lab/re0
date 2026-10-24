/**
 * The pricing page's figures come from the plan versions in force
 * (lib/domain/pricing-page.ts), so a price raised in the console is the price
 * the page prints -- the same one checkout charges.
 */
import { describe, expect, it } from 'vitest';
import { FALLBACK_PRICING, formatUsd, pricingFigures, surfacesLine } from '@/lib/domain/pricing-page';
import { en } from '@/lib/i18n/messages/en';

const number = new Intl.NumberFormat('en');
const words = en.pricing.surfaces;

describe('pricing figures', () => {
  it('prints the live price and allowance, not a copy of them', () => {
    const raised = { ...FALLBACK_PRICING, pro: { ...FALLBACK_PRICING.pro, priceMinor: 1_000, monthlyCalls: 8_000 } };
    const figures = pricingFigures(raised, number, words);
    expect(figures.pro.price).toBe('$10');
    expect(figures.pro.calls).toBe('8,000');
    expect(figures.free.price).toBe('$0');
    expect(figures.addon.calls).toBe('5,000');
  });

  it('formats cents only when there are some', () => {
    expect(formatUsd(950, number)).toBe('$9.50');
    expect(formatUsd(1_000_000, number)).toBe('$10,000');
  });

  it('reads the widget and shared-page caps, -1 as unlimited', () => {
    expect(surfacesLine(FALLBACK_PRICING.free, words, number)).toBe('1 website widget key and 1 shared page');
    expect(surfacesLine(FALLBACK_PRICING.pro, words, number)).toBe('Unlimited widget keys and unlimited shared pages');
    const three = { ...FALLBACK_PRICING.free, capabilities: { siteKeys: 3, showcasePages: -1 } };
    expect(surfacesLine(three, words, number)).toBe('3 website widget keys and unlimited shared pages');
  });

  it('carries the size, share and build rate the version sets', () => {
    const figures = pricingFigures(FALLBACK_PRICING, number, words);
    expect(figures.pro.size).toBe('100 MB');
    expect(figures.pro.share).toBe('20%');
    expect(figures.pro.tokens).toBe('20,000');
  });
});

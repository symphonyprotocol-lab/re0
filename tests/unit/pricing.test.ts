import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAN, PACK } from '@/lib/constants';
import { defaultPrice, parsePriceSettings, priceView } from '@/lib/domain/pricing';
import { checkoutTransactionBody, provisionPrice, type PaddleConfig } from '@/lib/infra/paddle';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ProductPrice, pricingFaqValues } from '@/components/site/product-price';
import { messages } from '@/i18n';
import { fill } from '@/i18n/format';

const config: PaddleConfig = {
  apiKey: 'test',
  webhookSecret: 'test',
  clientToken: 'test',
  planPriceId: 'pri_plan',
  packPriceId: 'pri_pack',
  environment: 'sandbox',
  checkoutUrl: 'http://localhost/checkout',
};
const settings = {
  priceMinor: 1500,
  credits: 65_000,
  promotion: { priceMinor: 799, startsAt: '2026-11-10T00:00:00+08:00', endsAt: '2026-11-12T00:00:00+08:00' },
};
afterEach(() => vi.unstubAllGlobals());
describe('scheduled pricing', () => {
  it('falls back to the PLAN and PACK constants', () => {
    expect(defaultPrice('plan').priceMinor).toBe(PLAN.priceMinor);
    expect(defaultPrice('pack').priceMinor).toBe(PACK.priceMinor);
    expect(defaultPrice('plan').credits).toBe(50_000);
    expect(defaultPrice('pack').credits).toBe(100_000);
  });
  it('includes the exact start and excludes the exact end, including UTC+8 offsets', () => {
    const start = Date.parse(settings.promotion.startsAt),
      end = Date.parse(settings.promotion.endsAt);
    expect(priceView(settings, 'v1', new Date(start - 1)).effectivePriceMinor).toBe(1500);
    expect(priceView(settings, 'v1', new Date(start)).effectivePriceMinor).toBe(799);
    expect(priceView(settings, 'v1', new Date(end - 1)).effectivePriceMinor).toBe(799);
    expect(priceView(settings, 'v1', new Date(end)).effectivePriceMinor).toBe(1500);
    expect(priceView(settings, 'v1', new Date(start)).quoteKey).not.toBe(priceView(settings, 'v1', new Date(end)).quoteKey);
  });
  it('rejects fractional cents, invalid intervals and a promotion that is not a discount', () => {
    expect(parsePriceSettings(settings)?.promotion?.startsAt).toBe('2026-11-09T16:00:00.000Z');
    for (const priceMinor of [0, -1, 1.5, NaN, Infinity, '1000', 100_000_001])
      expect(parsePriceSettings({ ...settings, priceMinor })).toBeNull();
    for (const credits of [0, -1, 1.5, NaN, Infinity, '50000', 100_000_001])
      expect(parsePriceSettings({ ...settings, credits })).toBeNull();
    expect(parsePriceSettings({ ...settings, promotion: { ...settings.promotion, priceMinor: 1500 } })).toBeNull();
    expect(parsePriceSettings({ ...settings, promotion: { ...settings.promotion, endsAt: settings.promotion.startsAt } })).toBeNull();
    expect(parsePriceSettings({ ...settings, promotion: { ...settings.promotion, startsAt: '2026-11-10T00:00' } })).toBeNull();
  });
  it('renders the dynamic amounts in both languages and in FAQ copy', () => {
    const price = priceView(settings, 'v1', new Date(settings.promotion.startsAt));
    for (const locale of ['zh', 'en'] as const) {
      const t = messages(locale);
      const html = renderToStaticMarkup(createElement(ProductPrice, { price, kind: 'plan', locale, labels: t.site.prices }));
      expect(html).toContain('7.99');
      expect(html).toContain('15.00');
      const faq = fill(t.site.faq.q3.a, pricingFaqValues({ plan: price, pack: defaultPrice('pack') }, locale, t.site.prices));
      expect(faq).toContain('7.99');
      expect(faq).toContain('15.00');
      expect(faq).toContain('65,000');
      expect(faq).toContain('100,000');
      expect(faq).not.toContain('{');
    }
  });
});
describe('Paddle price and discount construction', () => {
  it('applies a per-unit discount without discounting subsequent renewals', () => {
    const payload = checkoutTransactionBody(config, { kind: 'pack', quantity: 3 }, 'buyer', {
      priceId: 'pri_new',
      priceMinor: 799,
      regularPriceMinor: 1500,
    });
    expect(payload).toMatchObject({
      items: [{ price_id: 'pri_new', quantity: 3 }],
      discount: { type: 'flat_per_seat', amount: '701', currency_code: 'USD', recur: false },
    });
    expect(
      checkoutTransactionBody(config, { kind: 'plan', quantity: 1 }, 'buyer', {
        priceId: 'pri_new',
        priceMinor: 1500,
        regularPriceMinor: 1500,
      }),
    ).not.toHaveProperty('discount');
  });
  it('creates an immutable catalogue price preserving the product and tax mode', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: 'pri_old',
              product_id: 'pro_test',
              tax_mode: 'internal',
              unit_price: { amount: '1000', currency_code: 'USD' },
              billing_cycle: null,
              quantity: { minimum: 1, maximum: 10 },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: 'pri_new' } })));
    vi.stubGlobal('fetch', fetch);
    expect(await provisionPrice(config, 'pack', 1200, 'pri_old')).toBe('pri_new');
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({
      product_id: 'pro_test',
      tax_mode: 'internal',
      unit_price: { amount: '1200', currency_code: 'USD' },
      billing_cycle: null,
      quantity: { minimum: 1, maximum: 10 },
    });
    expect(fetch.mock.calls[1]![1].method).toBe('POST');
  });
});

describe('welcome credit display templates', () => {
  it('uses the configured welcome amount in both languages', () => {
    for (const locale of ['zh', 'en'] as const) {
      const t = messages(locale);
      const values = { welcomeCredits: '25,000' };
      for (const template of [t.site.home.trialCredits, t.site.home.finalNote, t.login.giftAmount, t.legal.terms.s2.body]) {
        expect(fill(template, values)).toContain('25,000');
        expect(fill(template, values)).not.toContain('{welcomeCredits}');
      }
    }
  });
});

/**
 * 价格 and the site's other pages in the shell (v6): the pricing table has
 * public posts' three rows with the numbers the code charges, the questions
 * include what posts cost, and every content page keeps the old site
 * footer's small print (Paddle as merchant of record, the legal pages).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { POST_DAILY_LIMIT, POST_MAX_ANSWERS, POST_SUMMARY_FEE } from '@/lib/domain/post';
import { defaultPrice } from '@/lib/domain/pricing';

vi.mock('next/navigation', () => ({ usePathname: () => '/pricing', useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/http/session', () => ({ currentUser: async () => null }));
vi.mock('@/i18n/server', async () => {
  const { messages: all } = await import('@/i18n');
  return { serverMessages: async () => ({ t: all('zh'), locale: 'zh' }) };
});
vi.mock('@/lib/services/pricing', async () => {
  const { defaultPrice: price } = await import('@/lib/domain/pricing');
  return { currentPricing: async () => ({ plan: price('plan'), pack: price('pack') }) };
});
vi.mock('@/lib/services/signup-reward', () => ({ welcomeCredits: async () => ({ credits: 100_000 }) }));
vi.mock('@/lib/services/video-pricing', () => ({ videoScriptPrice: async () => ({ credits: 5 }), videoExportPrice: async () => ({ credits: 50 }) }));
vi.mock('@/lib/services/public-copy', async () => {
  const { QUERY_BASE_FEE: fee } = await import('@/lib/constants');
  const p = await import('@/lib/domain/post');
  return {
    publicCopyValues: async () => ({
      postBaseFee: String(fee),
      postMaxAutoCost: String(p.POST_MAX_ANSWERS * fee),
      postDailyLimit: String(p.POST_DAILY_LIMIT),
      postSummaryFee: String(p.POST_SUMMARY_FEE),
      postMaxAnswers: String(p.POST_MAX_ANSWERS),
      payoutMinCredits: '500,000',
      payoutMinUsd: '$50.00',
      inviteFaq: '',
    }),
  };
});
vi.mock('@/lib/infra/db', () => ({ db: () => ({}) }));
vi.mock('@/lib/services/billing', () => ({ hasActivePlan: async () => false }));

const { default: PricingPage } = await import('@/app/(product)/(site)/pricing/page');

describe('价格 in the shell (v6)', () => {
  it('lists public posts: publishing, each answer and the summary, at the prices the code charges', async () => {
    const t = messages('zh');
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: await PricingPage() }));
    const costs = t.site.pricing.costs;
    for (const row of [costs.postPublish, costs.postAnswer, costs.postSummary]) expect(html).toContain(row.activity);
    for (const n of [QUERY_BASE_FEE, POST_DAILY_LIMIT, POST_SUMMARY_FEE, POST_MAX_ANSWERS]) expect(Number.isInteger(n) && n > 0).toBe(true);
    expect(html).not.toMatch(/undefined|NaN/);
    expect(html).toContain(`${QUERY_BASE_FEE} credits / 回答`);
    expect(html).toContain(`${POST_SUMMARY_FEE} credits / 次`);
    expect(html).toContain(`每天最多 ${POST_DAILY_LIMIT} 个`);
    expect(html).toContain(`一个帖子最多 ${POST_MAX_ANSWERS * QUERY_BASE_FEE} credits`);
    expect(html).toContain(t.site.faq.q7.q);
    expect(html).not.toMatch(/\{post[A-Za-z]+\}/);
    expect(html).toContain('xmain-grid is-wide');
  });

  it("keeps the cards' rows the same, the ribbon outside them, so the buttons line up (subgrid, content-page.css)", async () => {
    const t = messages('zh');
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: await PricingPage() }));
    const cards = html.split('<article class="xp-tier').slice(1).map((card) => card.slice(0, card.indexOf('</article>')));
    expect(cards).toHaveLength(3);
    /* The price and its promotion are one row; the button and the locked reason another. */
    for (const card of cards) expect(card).toMatch(/<div><p class="xp-price">[\s\S]*<\/div><p class="xp-credits">[\s\S]*<p class="xp-note">[^<]*<\/p><div class="xp-action">/);
    expect(cards.filter((card) => card.includes('xp-ribbon'))).toHaveLength(1);
  });

  it('keeps the old footer\'s small print: Paddle, the terms and the privacy policy', async () => {
    const t = messages('zh');
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: await PricingPage() }));
    expect(html).toContain(t.site.footer.paddle);
    expect(html).toMatch(/href="(\/zh)?\/legal\/terms"/);
    expect(html).toMatch(/href="(\/zh)?\/legal\/privacy"/);
    expect(defaultPrice('plan').credits).toBeGreaterThan(0);
  });
});

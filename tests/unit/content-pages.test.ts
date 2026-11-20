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
import { POST_DAILY_LIMIT, POST_MAX_ANSWERS, POST_SUMMARY_FEE, QUERY_BASE_FEE } from '@/lib/constants';
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
  const c = await import('@/lib/constants');
  return {
    publicCopyValues: async () => ({
      postBaseFee: String(c.QUERY_BASE_FEE),
      postMaxAutoCost: String(c.POST_MAX_ANSWERS * c.QUERY_BASE_FEE),
      postDailyLimit: String(c.POST_DAILY_LIMIT),
      postSummaryFee: String(c.POST_SUMMARY_FEE),
      postMaxAnswers: String(c.POST_MAX_ANSWERS),
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
    expect(html).toContain(`${QUERY_BASE_FEE} credits / 回答`);
    expect(html).toContain(`${POST_SUMMARY_FEE} credits / 次`);
    expect(html).toContain(`每天最多 ${POST_DAILY_LIMIT} 个`);
    expect(html).toContain(`一个帖子最多 ${POST_MAX_ANSWERS * QUERY_BASE_FEE} credits`);
    expect(html).toContain(t.site.faq.q7.q);
    expect(html).not.toMatch(/\{post[A-Za-z]+\}/);
    expect(html).toContain('xmain-grid is-wide');
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

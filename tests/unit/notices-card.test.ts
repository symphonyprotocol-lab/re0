/**
 * /notifications (v5): the page's own header says 通知, so the card does not
 * repeat it, and its button uses the site's button classes -- the old
 * settings-only `btn secondary sm` is unstyled outside settings.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';

vi.mock('next/navigation', () => ({ usePathname: () => '/notifications', useRouter: () => ({ refresh: () => {}, push: () => {} }), useSearchParams: () => new URLSearchParams() }));

const { NoticesTab } = await import('@/components/settings/notices-tab');
const t = messages('zh');

describe('the notices card', () => {
  it('has no heading of its own and a site-styled mark-all button', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: createElement(NoticesTab, { items: [], total: 0, page: 1, size: 20, unread: 0 }) }));
    expect(html).not.toMatch(/<h2[^>]*>/);
    expect(html).toMatch(/<button[^>]*class="btn-secondary btn-sm"/);
    expect(html).not.toContain('btn secondary sm');
  });

  it('tells an owner visitors could not ask, with links to top up and to the Ree\'s visitor-ask settings', () => {
    const reeId = '00000000-0000-4000-8000-0000000000b1';
    const item = { id: '00000000-0000-4000-8000-0000000000f1', kind: 'visitor_ask_paused', text: '', params: { ree: '退款顾问', reeId, fee: 20 }, refId: reeId, readAt: null, createdAt: '2026-11-24T08:00:00.000Z' };
    for (const locale of ['zh', 'en'] as const) {
      const m = messages(locale);
      const html = renderToStaticMarkup(createElement(I18nProvider, { locale, t: m, children: createElement(NoticesTab, { items: [item], total: 1, page: 1, size: 20, unread: 1 }) }));
      expect(html).toContain(locale === 'zh' ? '今天有访客没能在分享页向你的 Ree「退款顾问」免登录提问：你的余额不够支付一个回答 20 credits 的基本使用费。' : 'Visitors could not ask your Ree “退款顾问” on its share page today: your balance cannot cover the 20-credit base fee of one answer.');
      expect(html).toMatch(new RegExp(`href="[^"]*/settings\\?tab=balance"[^>]*>${m.notices.open.topUp}`));
      expect(html).toMatch(new RegExp(`href="[^"]*/rees/${reeId}/settings#visitor-asks"[^>]*>${m.notices.open.visitorAsks}`));
    }
  });
});

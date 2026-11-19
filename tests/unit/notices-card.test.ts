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
});

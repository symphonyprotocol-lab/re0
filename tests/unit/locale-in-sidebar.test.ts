/**
 * The language switch has one place on every user page (v6): the sidebar's
 * last line, 隐私 · 条款 · the language, signed in or not, as a quiet link
 * with no caret. The top bar has neither the language nor 返回官网; a
 * visitor's phone, which has no sidebar, has the globe in the column head.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, back: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams(),
}));

const { AppShell } = await import('@/components/shell/app-shell');
const { VisitorShell } = await import('@/components/shell/visitor-shell');
const { Topbar } = await import('@/components/shell/topbar');
const { FeedColumns } = await import('@/components/shell/feed-columns');

const plan = { active: false, cancelAtPeriodEnd: false, warn: false, used: 0, allowance: 0, remaining: 0, percent: 0 };
const user = { name: 'User', avatar: null, balance: 0, welcome: 0, debt: 0, plan: plan as never, reeCount: 0, unreadNotices: 0, activities: { visible: false, dot: false } };
const render = (locale: 'zh' | 'en', children: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { locale, t: messages(locale), children }));
const triggers = (html: string) => html.match(/<button[^>]*language-menu-trigger[^>]*>/g) ?? [];

describe('the language switch', () => {
  it('signed in: once, in the sidebar after the account row, quiet, beside 隐私 and 条款', () => {
    const html = render('zh', createElement(AppShell, { user, initialCollapsed: false, children: createElement(Topbar, { crumbs: [{ label: '设置' }] }) }));
    const found = triggers(html);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('xnav-language');
    expect(found[0]).toContain('is-quiet');
    expect(html).not.toContain('language-menu-caret');
    const links = html.slice(html.indexOf('class="xnav-links"'));
    expect(html.indexOf('class="xnav-links"')).toBeGreaterThan(html.indexOf('user-row'));
    expect(links).toMatch(/href="(\/zh)?\/legal\/privacy"[^>]*>隐私/);
    expect(links).toMatch(/href="(\/zh)?\/legal\/terms"[^>]*>条款/);
  });

  it('the top bar has no language and no 返回官网', () => {
    for (const locale of ['zh', 'en'] as const) {
      const html = render(locale, createElement(Topbar, { crumbs: [{ label: 'x' }] }));
      expect(triggers(html)).toHaveLength(0);
      expect(html).not.toContain('返回官网');
      expect(html).not.toContain('>Website<');
    }
  });

  it('a visitor: the sidebar line, and the column head for phones where there is no sidebar', () => {
    const html = render('en', createElement(VisitorShell, { children: createElement(FeedColumns, { title: 'Pricing', children: null }) }));
    const found = triggers(html);
    expect(found).toHaveLength(2);
    expect(found.filter((b) => b.includes('xnav-language'))).toHaveLength(1);
    expect(found.filter((b) => b.includes('xtop-language'))).toHaveLength(1);
    expect(html).not.toContain('language-menu-caret');
    expect(html).toContain('aria-label="Interface language: English"');
  });
});

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import { LOCALES, LOCALE_NAMES } from '@/i18n/locale';

let pathname = '/';
vi.mock('next/navigation', () => ({ usePathname: () => pathname, useRouter: () => ({ refresh: () => {} }) }));

const { LanguageMenu } = await import('@/components/ui/language-menu');

const render = (path: string, locale: 'zh' | 'en') => {
  pathname = path;
  return renderToStaticMarkup(createElement(I18nProvider, { locale, t: messages(locale), children: createElement(LanguageMenu, {}) }));
};

afterEach(() => {
  pathname = '/';
});

describe('language menu', () => {
  it('is a menu button showing the current language by its own name', () => {
    const html = render('/login', 'zh');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="界面语言：中文"');
    expect(html).toContain('<span lang="zh-CN">中文</span>');
  });

  it('on a language URL, keeps the other languages in the HTML as hreflang links to the same page', () => {
    const html = render('/en/r/some-ree', 'en');
    expect(html).toMatch(/<div role="menu"[^>]*hidden/);
    expect(html).toContain('href="/zh/r/some-ree" hrefLang="zh" data-locale-switch=""');
    /* The current language is the checked item, not a link to itself. */
    expect(html).not.toContain('href="/en/r/some-ree"');
    expect(html).toMatch(/<button type="button" role="menuitemradio" aria-checked="true"[^>]*><span class="row-menu-label" lang="en">English<\/span>/);
    for (const locale of LOCALES) expect(html).toContain(LOCALE_NAMES[locale]);
  });

  it('elsewhere renders no links: the choice is applied in place', () => {
    expect(render('/rees', 'en')).not.toContain('role="menu"');
    expect(render('/login', 'zh')).not.toContain('href=');
  });
});

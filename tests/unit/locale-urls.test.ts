import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { isLocalizedPath, LOCALE_HEADER, localeAlternates, localizeHref, PUBLIC_PAGES, splitLocale, stripLocale } from '@/i18n/paths';
import { renderedLocale } from '@/components/shell/locale-boundary';
import robots from '@/app/robots';
import { CRAWL_DISALLOWED, WORKSPACE_PATHS } from '@/lib/http/private-paths';
import { safeReturnTo } from '@/lib/domain/auth';
import { PATH_HEADER, SESSION_COOKIE } from '@/lib/http/cookies';

function request(path: string, headers: Record<string, string> = {}) {
  return middleware(new NextRequest(`https://re0.test${path}`, { headers }));
}

/** What the page's request carries on to rendering, and where a rewrite sends it. */
const forwarded = (response: Response, name: string) => response.headers.get(`x-middleware-request-${name}`);
const rewrittenTo = (response: Response) => response.headers.get('x-middleware-rewrite');

describe('language URLs (i18n/paths.ts)', () => {
  it('covers the public, indexable pages only', () => {
    for (const path of ['/', '/pricing', '/explore', '/legal/terms', '/legal/privacy', '/r/some-ree']) expect(isLocalizedPath(path)).toBe(true);
    for (const path of ['/s/some-ree', '/r/some-ree/opengraph-image-abc', '/login', '/checkout', '/dashboard', '/rees', '/admin/users', '/api/explore', '/legal', '/sitemap.xml']) {
      expect(isLocalizedPath(path)).toBe(false);
    }
  });

  it('localizes every page the sitemap lists from the same list', () => {
    expect(PUBLIC_PAGES.map((page) => page.path)).toEqual(['/', '/explore', '/pricing', '/legal/terms', '/legal/privacy']);
    for (const { path } of PUBLIC_PAGES) expect(isLocalizedPath(path)).toBe(true);
  });

  it('knows which language the server renders a path in', () => {
    expect(renderedLocale('/en/explore', 'zh')).toBe('en');
    expect(renderedLocale('/zh', 'en')).toBe('zh');
    expect(renderedLocale('/rees', 'en')).toBe('en');
    expect(renderedLocale('/login', 'zh')).toBe('zh');
  });

  it('splits and strips the prefix', () => {
    expect(splitLocale('/en/pricing')).toEqual({ locale: 'en', path: '/pricing' });
    expect(splitLocale('/zh')).toEqual({ locale: 'zh', path: '/' });
    expect(splitLocale('/fr/pricing')).toBeNull();
    expect(splitLocale('/explore')).toBeNull();
    expect(stripLocale('/en/r/x')).toBe('/r/x');
    expect(stripLocale('/rees')).toBe('/rees');
  });

  it('localizes links to public pages, keeping query and hash, and leaves the rest alone', () => {
    expect(localizeHref('en', '/')).toBe('/en');
    expect(localizeHref('zh', '/explore?category=tech&q=a%2Fb')).toBe('/zh/explore?category=tech&q=a%2Fb');
    expect(localizeHref('en', '/r/x#comments')).toBe('/en/r/x#comments');
    expect(localizeHref('en', '/en/r/x')).toBe('/en/r/x');
    for (const href of ['/rees/new', '/login?returnTo=%2Fr%2Fx', '/s/x', 'https://example.com/pricing', '//evil.example/', '#top']) expect(localizeHref('en', href)).toBe(href);
  });

  it('lists each language and the plain path as x-default', () => {
    expect(localeAlternates('/pricing', (path) => `https://re0.io${path}`)).toEqual({
      zh: 'https://re0.io/zh/pricing',
      en: 'https://re0.io/en/pricing',
      'x-default': 'https://re0.io/pricing',
    });
  });
});

describe('middleware: language URLs', () => {
  it('serves /en/... from the plain page with the language fixed by the URL, whatever the visitor prefers', () => {
    const response = request('/en/r/some-ree?from=%2Fexplore', { cookie: 're0_lang=zh', 'accept-language': 'zh-CN,zh;q=0.9' });
    expect(response.headers.get('location')).toBeNull();
    expect(rewrittenTo(response)).toBe('https://re0.test/r/some-ree?from=%2Fexplore');
    expect(forwarded(response, LOCALE_HEADER)).toBe('en');
    expect(response.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    expect(rewrittenTo(request('/zh'))).toBe('https://re0.test/');
    expect(forwarded(request('/zh'), LOCALE_HEADER)).toBe('zh');
  });

  it('never takes the language header from the client', () => {
    expect(forwarded(request('/en/pricing', { [LOCALE_HEADER]: 'zh' }), LOCALE_HEADER)).toBe('en');
    expect(forwarded(request('/rees', { [LOCALE_HEADER]: 'en', cookie: `${SESSION_COOKIE}=x` }), LOCALE_HEADER)).toBeNull();
  });

  it('sends a plain public URL on to the visitor\'s language, query kept: cookie, then Accept-Language, then zh', () => {
    const byCookie = request('/r/some-ree?join=1', { cookie: 're0_lang=en', 'accept-language': 'zh-CN' });
    expect(byCookie.status).toBe(307);
    expect(byCookie.headers.get('location')).toBe('https://re0.test/en/r/some-ree?join=1');
    expect(byCookie.headers.get('vary')).toBe('Cookie, Accept-Language');
    expect(request('/', { 'accept-language': 'en-GB,en;q=0.8' }).headers.get('location')).toBe('https://re0.test/en');
    expect(request('/pricing').headers.get('location')).toBe('https://re0.test/zh/pricing');
  });

  it('drops a prefix in front of a page that has one URL for both languages', () => {
    expect(request('/en/dashboard?x=1').headers.get('location')).toBe('https://re0.test/dashboard?x=1');
    expect(request('/zh/s/some-ree').headers.get('location')).toBe('https://re0.test/s/some-ree');
  });

  it('leaves the share page, sign-in and the workspace where they are', () => {
    for (const path of ['/s/some-ree', '/login', '/checkout']) expect(request(path).headers.get('location')).toBeNull();
    const signedIn = request('/rees', { cookie: `${SESSION_COOKIE}=x` });
    expect(signedIn.headers.get('location')).toBeNull();
    expect(forwarded(signedIn, PATH_HEADER.toLowerCase())).toBe('/rees');
  });
});

describe('private paths: one list for the sign-in gate and robots.txt', () => {
  it('gates every workspace path and keeps crawlers out of it', () => {
    const disallowed = robots().rules;
    expect(Array.isArray(disallowed) ? null : disallowed.disallow).toEqual([...CRAWL_DISALLOWED]);
    for (const path of WORKSPACE_PATHS) {
      expect(CRAWL_DISALLOWED).toContain(path);
      expect(request(`${path}/x`).headers.get('location')).toBe(`https://re0.test/login?returnTo=${encodeURIComponent(`${path}/x`)}`);
    }
  });
});

describe('sign-in return paths', () => {
  it('accepts a language URL wherever its plain page is accepted', () => {
    expect(safeReturnTo('/en/r/some-ree#comments')).toBe('/en/r/some-ree#comments');
    expect(safeReturnTo('/zh')).toBe('/zh');
    expect(safeReturnTo('/en/admin/models')).toBe('/rees');
    expect(safeReturnTo('//en/r/x')).toBe('/rees');
  });
});

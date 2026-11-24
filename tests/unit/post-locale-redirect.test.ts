/**
 * A post written on an English page opens in English (2026-11-24): the
 * composer used to push the plain `/p/<id>`, and the middleware sent that on
 * by the language cookie or Accept-Language -- Chinese on a Chinese phone
 * browsing `/en`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({}), useSearchParams: () => new URLSearchParams() }));

const { publishedPostHref } = await import('@/components/posts/composer');
const { middleware } = await import('@/middleware');

describe('where a new post opens', () => {
  it('is its page in the language of the page it was written on', () => {
    expect(publishedPostHref('en', 'p1')).toBe('/en/p/p1');
    expect(publishedPostHref('zh', 'p1')).toBe('/zh/p/p1');
  });

  it('stays in that language whatever the cookie and the browser prefer', () => {
    const headers = { cookie: 're0_lang=zh', 'accept-language': 'zh-CN,zh;q=0.9' };
    const response = middleware(new NextRequest(`https://re0.test${publishedPostHref('en', 'p1')}`, { headers }));
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-rewrite')).toBe('https://re0.test/p/p1');
    /* The plain path is what used to be pushed: it follows the cookie. */
    expect(middleware(new NextRequest('https://re0.test/p/p1', { headers })).headers.get('location')).toBe('https://re0.test/zh/p/p1');
  });

  it('is never the plain path in the composer (public post, private question)', () => {
    const source = readFileSync(new URL('../../components/posts/composer.tsx', import.meta.url), 'utf8');
    expect(source).not.toMatch(/router\.(push|replace)\(`\/p\//);
    expect(source.match(/router\.push\(href\)/g)).toHaveLength(2);
  });
});

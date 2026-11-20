/**
 * 首页 while there are no posts yet (review 2026-11-18, #159 item 2): a visitor's page has
 * one h1, the introduction's headline, and only a short list of Rees with
 * the way to 发现 -- the full list lives on /explore alone, so the two
 * pages do not repeat each other.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';

vi.mock('next/navigation', () => ({ usePathname: () => '/', useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }), useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/http/session', () => ({ currentUser: async () => null }));
vi.mock('@/i18n/server', async () => {
  const { messages: all } = await import('@/i18n');
  return { serverMessages: async () => ({ t: all('zh'), locale: 'zh' }) };
});
const card = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, slug: `ree-${n}`, name: `Ree number ${n}`, description: 'd', avatarBlob: null, coverBlob: null, color: 'default', category: 'life', tags: [],
  ownerId: 'o', ownerName: 'Owner', role: 'normal', queryFee: 0, price: 20, sources: 1, answers: 0, positiveRate: null, excerpt: null, createdAt: new Date(), pinned: false, video: null, asked7: 0, lastAnsweredAt: null, publicQa: 0,
});
vi.mock('@/lib/services/explore', () => ({
  explore: async () => ({ mode: 'browse', items: Array.from({ length: 12 }, (_, n) => card(n + 1)), total: 12, nextCursor: 'more' }),
  weeklyMostAsked: async () => [],
}));
vi.mock('@/lib/services/ree-favorites', () => ({ favoriteReeIds: async () => [] }));
vi.mock('@/lib/services/video', () => ({ introsFor: async () => new Map() }));
/* No posts yet: the case where 首页 stands in a few Rees. */
vi.mock('@/lib/services/posts', () => ({ listFeed: async () => ({ items: [], next: null }), unansweredCount: async () => 0 }));

const { default: HomePage } = await import('@/app/(product)/page');

describe('the visitor\'s 首页', () => {
  it('has the introduction as its only h1, six Rees and the way to 发现', async () => {
    const t = messages('zh');
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: await HomePage({ searchParams: Promise.resolve({}) }) }));
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1 id="home-intro">/);
    expect(html.match(/Ree number \d+/g)?.length ?? 0).toBeGreaterThan(0);
    expect(new Set(html.match(/Ree number \d+/g)).size).toBe(6);
    expect(html).toContain(t.site.visitor.allRees);
  });

  it('opens on one welcome card with one way to sign in, and searches posts (v6)', async () => {
    const t = messages('zh');
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: await HomePage({ searchParams: Promise.resolve({}) }) }));
    expect(html).toContain('class="xwelcome"');
    expect(html).toContain(t.site.visitor.welcomeTitle);
    expect(html.match(new RegExp(t.site.visitor.introAsk, 'g'))).toHaveLength(1);
    /* No composer strip for visitors, no create-a-Ree button beside the welcome. */
    expect(html).not.toContain('post-composer is-visitor');
    expect(html).not.toContain('returnTo=%2Frees%2Fnew" class="btn-secondary btn-sm"><svg');
    /* The search posts box, in the right column and again for narrow screens. */
    expect(html.match(/<form role="search" class="search-box" aria-label="搜索帖子" action="\/">/g)).toHaveLength(2);
  });

  it('shows a post search under the front page, without the welcome card', async () => {
    const t = messages('zh');
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: await HomePage({ searchParams: Promise.resolve({ q: 'refund' }) }) }));
    expect(html).not.toContain('class="xwelcome"');
    expect(html).toContain('搜索“refund”的帖子');
    expect(html).toContain(t.posts.explore.noPosts);
  });

  it('says nothing of asking without an account: visitors must sign in to ask (2026-11-21)', async () => {
    const t = messages('zh');
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: await HomePage({ searchParams: Promise.resolve({}) }) }));
    expect(html).not.toContain('xfree-note');
    expect(html).not.toContain('免登录提问');
    expect('railFree' in t.discover.explore).toBe(false);
  });
});

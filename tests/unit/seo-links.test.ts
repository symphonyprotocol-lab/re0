/**
 * What a crawler can follow and what it is told (GSC review 2026-11, A2, A8,
 * A9, A12): links to a Ree never carry `?from=`, the way back lives in the
 * tab instead; no loading boundary wraps the public Ree and post pages, so
 * not found is a real 404; Explore's categories and numbered pages are
 * plain links, each its own canonical page with its own h1; 首页's right
 * column links the most active Rees.
 */
import { existsSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/client';
import { messages } from '@/i18n';
import type { ExploreResult, ReeCard } from '@/lib/services/explore';

vi.mock('next/navigation', () => ({
  usePathname: () => '/explore',
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  permanentRedirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/http/session', () => ({ currentUser: async () => null }));
vi.mock('@/i18n/server', async () => {
  const { messages: load } = await import('@/i18n');
  return { serverMessages: async () => ({ t: load('zh'), locale: 'zh' }) };
});

const card = (n: number): ReeCard => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, slug: `ree-${n}`, name: `Ree number ${n}`, description: 'd', avatarBlob: null, coverBlob: null, color: 'default', category: 'life', tags: [],
  ownerId: 'o', ownerName: 'Owner', role: 'normal', queryFee: 0, price: 20, sources: 1, answers: 0, positiveRate: null, excerpt: null, createdAt: new Date(), pinned: false, video: null, asked7: 0, lastAnsweredAt: null, publicQa: 0,
} as unknown as ReeCard);
const listing = vi.hoisted(() => ({ total: 100, calls: [] as unknown[][] }));
vi.mock('@/lib/services/explore', () => ({
  explore: async (...args: unknown[]) => {
    listing.calls.push(args);
    return { mode: 'browse', items: Array.from({ length: 24 }, (_, n) => card(n + 1)), total: listing.total, nextCursor: 'more' };
  },
  allowSearch: async () => true,
}));
vi.mock('@/lib/services/ree-favorites', () => ({ favoriteReeIds: async () => [], listFavoriteRees: async () => ({ items: [] }) }));
vi.mock('@/lib/services/video', () => ({ introsFor: async () => new Map() }));

const t = messages('zh');
const { ExploreView, SiteRail } = await import('@/components/discover/explore-view');
const { exploreBackPath, explorePageCount, explorePagePath, parseExplorePage } = await import('@/components/discover/explore-pages');
const { rememberExploreReturn } = await import('@/components/discover/public-visit');
const explorePage = await import('@/app/(product)/(discover)/explore/page');

const wrap = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'zh', t, children: element }));
const result = (total: number): ExploreResult => ({ mode: 'browse', items: Array.from({ length: 24 }, (_, n) => card(n + 1)), total, nextCursor: 'more' });
const view = (props: Partial<Parameters<typeof ExploreView>[0]> = {}) =>
  wrap(createElement(ExploreView, { query: { q: '', category: null, sort: 'active' }, result: result(100), limited: false, signedIn: false, renderedAt: 0, ...props }));

beforeEach(() => {
  listing.total = 100;
  listing.calls = [];
});

describe('numbered explore pages', () => {
  it('reads ?page= as 2 and up; absent is 1, anything else is not a page', () => {
    expect(parseExplorePage(undefined)).toBe(1);
    expect(parseExplorePage('2')).toBe(2);
    expect(parseExplorePage(['7', '8'])).toBe(7);
    for (const bad of ['1', '0', '01', '2x', '', '-3', '1234567']) expect(parseExplorePage(bad)).toBeNull();
  });

  it('counts pages of one first batch each, and builds their paths (a search has none)', () => {
    expect(explorePageCount(0)).toBe(1);
    expect(explorePageCount(24)).toBe(1);
    expect(explorePageCount(25)).toBe(2);
    expect(explorePagePath({}, 1)).toBe('/explore');
    expect(explorePagePath({}, 3)).toBe('/explore?page=3');
    expect(explorePagePath({ category: 'design', sort: 'answers' }, 2)).toBe('/explore?category=design&sort=answers&page=2');
    expect(explorePagePath({ q: 'tax' }, 4)).toBe('/explore?q=tax');
  });

  it('keeps only a real explore list as the way back', () => {
    expect(exploreBackPath('/explore?category=design&page=3')).toBe('/explore?category=design&page=3');
    expect(exploreBackPath('/explore?q=tax&page=3')).toBe('/explore?q=tax');
    expect(exploreBackPath('/explore?category=nope&page=1')).toBe('/explore');
    expect(exploreBackPath('/saved')).toBe('/explore');
    expect(exploreBackPath('https://evil.test/explore?q=x')).toBe('/explore');
  });
});

describe('Explore for a crawler', () => {
  it('links every category and the next page, and its Rees without ?from=', () => {
    const html = view();
    for (const category of ['technology', 'design', 'business', 'learning', 'professional', 'life', 'other']) {
      expect(html).toContain(`href="/zh/explore?category=${category}"`);
    }
    expect(html).not.toMatch(/<button[^>]*class="filter/);
    expect(html).toContain('href="/zh/r/ree-1"');
    expect(html).not.toContain('from=');
    expect(html).toContain('href="/zh/explore?page=2"');
    expect(html).toContain(fill(t.discover.explore.pageOf, { page: '1', pages: '5' }));
  });

  it('links the pages either side of a middle page, keeping the category', () => {
    const html = view({ query: { q: '', category: 'design', sort: 'active' }, page: 3 });
    expect(html).toMatch(/<a rel="prev" [^>]*href="\/zh\/explore\?category=design&amp;page=2"/);
    expect(html).toMatch(/<a rel="next" [^>]*href="\/zh\/explore\?category=design&amp;page=4"/);
  });

  it('has no pages for a search or a list that fits on one', () => {
    expect(view({ result: { mode: 'search', items: [card(1)], total: 1, nextCursor: null } })).not.toContain('discovery-pager');
    expect(view({ result: result(20) })).not.toContain('discovery-pager');
  });

  it('gives /explore one descriptive h1, and each category its own', async () => {
    const all = wrap(await explorePage.default({ searchParams: Promise.resolve({}) }));
    expect(all.match(/<h1\b/g)).toHaveLength(1);
    expect(all).toContain(`<h1>${t.discover.explore.heading}</h1>`);
    const design = wrap(await explorePage.default({ searchParams: Promise.resolve({ category: 'design' }) }));
    expect(design.match(/<h1\b/g)).toHaveLength(1);
    expect(design).toContain(`<h1>${fill(t.discover.explore.categoryHeading, { category: t.common.categories.design })}</h1>`);
  });

  it('makes each category and page its own canonical, the order not', async () => {
    const meta = (params: Record<string, string>) => explorePage.generateMetadata({ searchParams: Promise.resolve(params) });
    const all = await meta({});
    expect(String(all.alternates?.canonical)).toMatch(/\/zh\/explore$/);
    expect(JSON.stringify(all.title)).toContain('Rees');
    const category = await meta({ category: 'technology', sort: 'free' });
    expect(String(category.alternates?.canonical)).toMatch(/\/zh\/explore\?category=technology$/);
    expect(category.title).toBe(fill(t.discover.explore.categoryHeading, { category: t.common.categories.technology }));
    expect(category.robots).toBeUndefined();
    const second = await meta({ category: 'technology', page: '2' });
    expect(String(second.alternates?.canonical)).toMatch(/\/zh\/explore\?category=technology&page=2$/);
    expect(String(second.title)).toContain(fill(t.discover.explore.pageSuffix, { page: 2 }));
    expect((await meta({ q: 'tax', page: '2' })).robots).toMatchObject({ index: false });
  });

  it('starts page N that many batches in; page 1 written out or a bad page moves to the URL without it; past the last is not found', async () => {
    await explorePage.default({ searchParams: Promise.resolve({ page: '3' }) });
    expect(listing.calls.at(-1)?.[2]).toMatchObject({ offset: 48 });
    await expect(explorePage.default({ searchParams: Promise.resolve({ page: '1' }) })).rejects.toThrow('NEXT_REDIRECT /zh/explore');
    await expect(explorePage.default({ searchParams: Promise.resolve({ category: 'life', page: 'x' }) })).rejects.toThrow('NEXT_REDIRECT /zh/explore?category=life');
    await expect(explorePage.default({ searchParams: Promise.resolve({ q: 'tax', page: '2' }) })).rejects.toThrow('NEXT_REDIRECT /zh/explore?q=tax');
    await expect(explorePage.default({ searchParams: Promise.resolve({ page: '6' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('首页 links Rees', () => {
  it('lists the most active Rees in its right column, each a plain link', () => {
    const html = wrap(createElement(SiteRail, { popular: [card(1), card(2)], signedIn: false }));
    expect(html).toContain(t.discover.explore.railPopular);
    expect(html).toContain('href="/zh/r/ree-1"');
    expect(html).toContain('href="/zh/r/ree-2"');
    expect(html).toContain('href="/zh/explore"');
  });
});

describe('the way back from a Ree page', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', { sessionStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is kept per Ree in the tab, and only for an explore list', () => {
    rememberExploreReturn('Ree-1', '/explore?category=design&page=2');
    rememberExploreReturn('ree-2', '/saved');
    expect(JSON.parse(store.get('re0:ree-return') ?? '{}')).toEqual({ 'ree-1': '/explore?category=design&page=2' });
    rememberExploreReturn('ree-1', '/explore');
    expect(JSON.parse(store.get('re0:ree-return') ?? '{}')).toEqual({});
  });
});

describe('real 404s', () => {
  it('has no loading boundary above the public Ree and post pages', () => {
    for (const file of ['app/loading.tsx', 'app/(product)/loading.tsx', 'app/(product)/(discover)/loading.tsx', 'app/(product)/(discover)/r/[slug]/loading.tsx', 'app/(product)/(discover)/p/[id]/loading.tsx']) {
      expect(existsSync(file), file).toBe(false);
    }
  });
});

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSitemapId, sitemapIndexXml, sitemapPart } from '@/lib/sitemaps';
import { generateSitemaps } from '@/app/sitemap';
import { publicPage } from '@/lib/seo';
import { LOCALES } from '@/i18n/locale';

const changed = new Date('2026-11-20T08:00:00Z');
vi.mock('@/lib/services/public-rees', () => ({
  sitemapReeTotals: async () => ({ total: 3, latest: changed }),
  /* Two of the seven categories have public Rees; the rest are empty. */
  sitemapReeCategories: async () => [{ category: 'technology', latest: changed }, { category: 'life', latest: changed }],
  sitemapRees: async () => [],
}));
vi.mock('@/lib/services/posts', () => ({ indexablePosts: async () => [], indexablePostCount: async () => 0 }));
/* Only channels with a visible post come back from the service; an empty one is never asked for. */
vi.mock('@/lib/services/channels', () => ({ indexableChannels: async () => [{ name: 'travel', at: changed }, { name: '旅行', at: changed }] }));

beforeEach(() => vi.stubEnv('APP_BASE_URL', 'https://re0.io'));
afterEach(() => vi.unstubAllEnvs());

describe('sitemap parts (lib/sitemaps.ts)', () => {
  it('reads a part from its id, and nothing else', () => {
    expect(parseSitemapId('pages')).toEqual({ kind: 'pages' });
    expect(parseSitemapId('rees-1')).toEqual({ kind: 'rees', page: 1 });
    expect(parseSitemapId('posts-12')).toEqual({ kind: 'posts', page: 12 });
    for (const id of [undefined, '', 'rees', 'rees-0', 'rees-01', 'rees-1.xml', 'pages-1', 'users-1', 'rees-1234567']) expect(parseSitemapId(id)).toBeNull();
  });

  it('builds at build time without the database, from parts that always exist', async () => {
    const ids = (await generateSitemaps()).map((item) => item.id);
    expect(ids).toEqual(['pages', 'rees-1', 'posts-1']);
    for (const id of ids) expect(parseSitemapId(id)).not.toBeNull();
  });

  it('indexes the parts at their absolute URLs', () => {
    const xml = sitemapIndexXml(['pages', 'rees-1', 'rees-2']);
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<sitemapindex xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
    expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])).toEqual([
      'https://re0.io/sitemap/pages.xml',
      'https://re0.io/sitemap/rees-1.xml',
      'https://re0.io/sitemap/rees-2.xml',
    ]);
  });

  it('lists the channels that have a visible post, in both languages', async () => {
    const entries = (await sitemapPart({ kind: 'pages' }))!;
    expect(entries.filter((entry) => entry.url.includes('/c/')).map((entry) => entry.url)).toEqual([
      'https://re0.io/zh/c/travel',
      'https://re0.io/en/c/travel',
      'https://re0.io/zh/c/%E6%97%85%E8%A1%8C',
      'https://re0.io/en/c/%E6%97%85%E8%A1%8C',
    ]);
  });

  it('lists each Explore category that has public Rees, in both languages, at exactly the URL its page names as canonical', async () => {
    const entries = (await sitemapPart({ kind: 'pages' }))!;
    const categories = entries.filter((entry) => entry.url.includes('/explore?'));
    expect(categories.map((entry) => entry.url)).toEqual([
      'https://re0.io/zh/explore?category=technology',
      'https://re0.io/en/explore?category=technology',
      'https://re0.io/zh/explore?category=life',
      'https://re0.io/en/explore?category=life',
    ]);
    for (const category of ['technology', 'life']) {
      for (const locale of LOCALES) {
        /* What app/(product)/(discover)/explore/page.tsx's generateMetadata gives the category's first page. */
        const { alternates } = publicPage({ path: `/explore?category=${category}`, title: '', description: '', locale });
        const entry = categories.find((item) => item.url === alternates?.canonical);
        expect(entry).toMatchObject({ lastModified: changed, changeFrequency: 'daily', alternates: { languages: alternates?.languages } });
      }
    }
    expect(entries.some((entry) => /[?&](page|sort)=/.test(entry.url))).toBe(false);
  });
});

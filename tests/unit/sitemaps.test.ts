import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSitemapId, sitemapIndexXml } from '@/lib/sitemaps';
import { generateSitemaps } from '@/app/sitemap';

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
});

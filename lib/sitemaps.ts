import type { MetadataRoute } from 'next';
import { LOCALES, type Locale } from '@/i18n/locale';
import { localeAlternates, PUBLIC_PAGES } from '@/i18n/paths';
import { indexablePostCount, indexablePosts } from '@/lib/services/posts';
import { sitemapReeTotals, sitemapRees } from '@/lib/services/public-rees';
import { absoluteUrl, localeUrl, reeContentLocale } from '@/lib/seo';

/**
 * The sitemap, in files (A10, docs/research/gsc-seo-review-2026-11.md):
 * `/sitemap.xml` is an index (app/sitemap-index.xml/route.ts) of
 * `/sitemap/pages.xml` (the site's own pages), `/sitemap/rees-<n>.xml`
 * (public Rees) and `/sitemap/posts-<n>.xml` (public posts a Ree answered),
 * served by app/sitemap.ts. Search Console then reports each part on its
 * own, and nothing is cut off at a fixed limit: a part that fills up gets
 * a next one. A part holds well under the 50,000 URLs and 50 MB a sitemap
 * may: at most two URLs per Ree or post.
 */
export const REES_PER_SITEMAP = 10_000;
export const POSTS_PER_SITEMAP = 10_000;

export type SitemapPart = { kind: 'pages' } | { kind: 'rees' | 'posts'; page: number };

/** `pages`, `rees-1`, `posts-3` → the part; anything else (`rees-0`, `rees`, `x`) → null. */
export function parseSitemapId(id: string | undefined): SitemapPart | null {
  if (id === 'pages') return { kind: 'pages' };
  const match = /^(rees|posts)-([1-9][0-9]{0,5})$/.exec(id ?? '');
  return match ? { kind: match[1] as 'rees' | 'posts', page: Number(match[2]) } : null;
}

/** Every part there is now, for the index: the pages, then as many Ree and post files as they fill (none for an empty list). */
export async function sitemapIds(): Promise<string[]> {
  const [{ total: rees }, posts] = await Promise.all([sitemapReeTotals(), indexablePostCount()]);
  const files = (prefix: string, count: number, per: number) => Array.from({ length: Math.ceil(count / per) }, (_, index) => `${prefix}-${index + 1}`);
  return ['pages', ...files('rees', rees, REES_PER_SITEMAP), ...files('posts', posts, POSTS_PER_SITEMAP)];
}

type Entry = MetadataRoute.Sitemap[number];

/**
 * A localized page, once per language (`/zh/...`, `/en/...`), each listing
 * the other as its hreflang alternate (i18n/paths.ts); or, for a page whose
 * content is in one language only (`only`: an English Ree), just that URL,
 * the canonical both URLs name (lib/seo.ts `publicPage`).
 */
function localized(path: string, entry: Omit<Entry, 'url' | 'alternates'>, only: Locale | null = null): Entry[] {
  if (only) return [{ url: localeUrl(only, path), ...entry }];
  return LOCALES.map((locale) => ({ url: localeUrl(locale, path), alternates: { languages: localeAlternates(path, absoluteUrl) }, ...entry }));
}

/**
 * One part's entries, or null when it does not exist (a Ree or post file
 * past the last). Only `publicRee()` Rees; the share pages `/s/*` are left
 * out, they point at `/r/*` as canonical. Explore changes whenever a public
 * Ree does.
 */
export async function sitemapPart(part: SitemapPart): Promise<MetadataRoute.Sitemap | null> {
  if (part.kind === 'pages') {
    const { latest } = await sitemapReeTotals();
    return PUBLIC_PAGES.flatMap(({ path, changeFrequency, priority }) => localized(path, { lastModified: path === '/explore' ? (latest ?? undefined) : undefined, changeFrequency, priority }));
  }
  if (part.kind === 'rees') {
    const rees = await sitemapRees({ offset: (part.page - 1) * REES_PER_SITEMAP, limit: REES_PER_SITEMAP });
    if (!rees.length && part.page > 1) return null;
    return rees.flatMap((ree) => localized(`/r/${ree.slug}`, { lastModified: ree.updatedAt, changeFrequency: 'weekly', priority: 0.8 }, reeContentLocale(ree)));
  }
  const posts = await indexablePosts({ offset: (part.page - 1) * POSTS_PER_SITEMAP, limit: POSTS_PER_SITEMAP });
  if (!posts.length && part.page > 1) return null;
  return posts.flatMap((post) => localized(`/p/${post.id}`, { lastModified: post.at, changeFrequency: 'weekly', priority: 0.6 }));
}

/** `/sitemap.xml`: the index of the parts, at their absolute URLs. */
export function sitemapIndexXml(ids: readonly string[]): string {
  const entries = ids.map((id) => `<sitemap>\n<loc>${absoluteUrl(`/sitemap/${id}.xml`)}</loc>\n</sitemap>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;
}

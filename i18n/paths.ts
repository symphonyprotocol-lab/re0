import type { MetadataRoute } from 'next';
import { isLocale, LOCALES, type Locale } from './locale';

/**
 * Per-language URLs for the public, indexable pages: `/zh/...` and
 * `/en/...`. The pages themselves live at their plain paths in `app/`; the
 * middleware rewrites `/en/pricing` to `/pricing` and passes the language
 * on in a request header (LOCALE_HEADER), which `requestLocale()` reads
 * first. The plain path is the x-default: the middleware sends a visitor
 * there on to their language (cookie, then Accept-Language, then zh), so
 * links made before this keep working. Everything else -- the workspace,
 * the console, sign-in, checkout, share pages -- has one URL in both
 * languages, as before.
 */
export const LOCALE_HEADER = 'x-re0-locale';

/** hreflang values, per locale. */
export const HREFLANG: Record<Locale, string> = { zh: 'zh', en: 'en' };

/**
 * The site's public pages, with what the sitemap says about each (app/sitemap.ts).
 * Public Rees (`/r/<slug>`) are the other localized pages.
 */
export const PUBLIC_PAGES: readonly { path: string; changeFrequency: NonNullable<MetadataRoute.Sitemap[number]['changeFrequency']>; priority: number }[] = [
  { path: '/', changeFrequency: 'weekly', priority: 1 },
  { path: '/explore', changeFrequency: 'daily', priority: 0.9 },
  { path: '/pricing', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/legal/terms', changeFrequency: 'yearly', priority: 0.2 },
  { path: '/legal/privacy', changeFrequency: 'yearly', priority: 0.2 },
];
const PUBLIC_PATHS = new Set(PUBLIC_PAGES.map((page) => page.path));
/** A public Ree's page; not its `opengraph-image` route below it. */
const PUBLIC_REE = /^\/r\/[^/]+$/;

/** Whether a plain path (no language prefix, no query) has per-language URLs. */
export function isLocalizedPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || PUBLIC_REE.test(path);
}

/** `/en/pricing` → `{ locale: 'en', path: '/pricing' }`; `/en` → path `/`; anything else → null. */
export function splitLocale(pathname: string): { locale: Locale; path: string } | null {
  const match = /^\/([a-z]{2})(\/.*)?$/.exec(pathname);
  if (!match || !isLocale(match[1])) return null;
  return { locale: match[1], path: match[2] || '/' };
}

/** The path without its language prefix, for matching the current page (nav highlights). */
export function stripLocale(pathname: string): string {
  return splitLocale(pathname)?.path ?? pathname;
}

/** A plain path in a language: `/pricing` → `/en/pricing`, `/` → `/en`. */
export function localePath(locale: Locale, path: string): string {
  return `/${locale}${path === '/' ? '' : path}`;
}

/**
 * An href as it should be linked from a page in `locale`: a localized page
 * gets its prefix (query and hash kept), anything else -- an already
 * prefixed path, the workspace, an absolute URL -- is left alone.
 */
export function localizeHref(locale: Locale, href: string): string {
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  return isLocalizedPath(path) ? localePath(locale, path) + (cut === -1 ? '' : href.slice(cut)) : href;
}

/** The same page in each language, for hreflang. */
export function localeAlternates(path: string, absolute: (path: string) => string): Record<string, string> {
  return {
    ...Object.fromEntries(LOCALES.map((locale) => [HREFLANG[locale], absolute(localePath(locale, path))])),
    'x-default': absolute(path),
  };
}

import type { Metadata } from 'next';
import { appBaseUrl } from '@/lib/http/cookies';
import type { PublicRee } from '@/lib/services/public-rees';
import { HTML_LANG, LOCALES, type Locale } from '@/i18n/locale';
import { localeAlternates, localePath } from '@/i18n/paths';

/**
 * What search engines and link previews read: canonical URLs, the shared
 * Open Graph fields and the JSON-LD graphs. URLs are absolute on
 * `APP_BASE_URL` (https://re0.io in production), so the vercel.app aliases
 * of a deployment point their canonicals at the real site.
 */
export const SITE_NAME = 'RE0';

/** Pages nobody should find from a search: the workspace, the console. */
export const PRIVATE_ROBOTS: Metadata['robots'] = { index: false, follow: false };
/** Public but useless as a search result (sign-in, checkout, search results): kept out, links still followed. */
export const UNLISTED_ROBOTS: Metadata['robots'] = { index: false, follow: true };

export function absoluteUrl(path: string): string {
  return `${appBaseUrl()}${path}`;
}

export function ogLocale(locale: Locale): string {
  return locale === 'zh' ? 'zh_CN' : 'en_US';
}

/** A public page's URL in a language: `/pricing` → `https://re0.io/en/pricing`. */
export function localeUrl(locale: Locale, path: string): string {
  return absoluteUrl(localePath(locale, path));
}

/**
 * The site's image in a language (app/og/site/[lang], lib/og/site-image.tsx),
 * named outright: a page that sets its own `openGraph` no longer inherits
 * app/opengraph-image.tsx. Its alt text is the card's headline.
 */
const SITE_IMAGE_ALT: Record<Locale, string> = { en: 'RE0 — Ask once. Many Rees answer.', zh: 'RE0 — 问一次，多个 Ree 来回答。' };
export function siteImage(locale: Locale): { url: string; width: number; height: number; alt: string } {
  return { url: `/og/site/${locale}`, width: 1200, height: 630, alt: SITE_IMAGE_ALT[locale] };
}

/**
 * An indexable page's own metadata. `path` is the plain path (`/pricing`):
 * the canonical is the page in this language (`/en/pricing`), with hreflang
 * alternates for each language and the English page as x-default
 * (i18n/paths.ts). A page whose content exists in one language only (an
 * English Ree, `contentLocale`) is canonical in that language from both
 * URLs and has no hreflang: the other URL is the same text under another
 * interface, not a translation. Open Graph and Twitter carry the
 * title, description and the site's image. A route with its own
 * `opengraph-image` file (a public Ree) passes `ownImage`: an image named
 * here would replace the file's.
 */
export function publicPage({ path, title, description, locale, absoluteTitle = false, ownImage = false, contentLocale }: { path: string; title: string; description: string; locale: Locale; absoluteTitle?: boolean; ownImage?: boolean; contentLocale?: Locale | null }): Metadata {
  const canonicalLocale = contentLocale ?? locale;
  const url = localeUrl(canonicalLocale, path);
  const alternates = contentLocale ? { canonical: url } : { canonical: url, languages: localeAlternates(path, absoluteUrl) };
  const alternateLocale = contentLocale ? [] : LOCALES.filter((other) => other !== locale).map(ogLocale);
  /* Left out, not `undefined`: Next reads a present `images` key as "no image" and drops the file's. */
  const image = ownImage ? {} : { images: [siteImage(locale)] };
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates,
    openGraph: { type: 'website', siteName: SITE_NAME, locale: ogLocale(canonicalLocale), alternateLocale, url, title, description, ...image },
    twitter: { card: 'summary_large_image', title, description, ...image },
  };
}

/**
 * The language a public Ree's own words (name, introduction, sample
 * questions) are written in, when they are in one language only; null for
 * a Ree indexed in both. A Ree has no content-language field yet; official
 * Rees are all written in English, so they are `en`, and everyone else's
 * stay in both languages as before. Questions in Chinese still work
 * on an English Ree; only which URL search engines index changes.
 */
export function reeContentLocale(ree: Pick<PublicRee, 'role'>): Locale | null {
  return ree.role === 'official' ? 'en' : null;
}

/** A public Ree's canonical page: in its content language if it has one, else in `locale` (Explore's ItemList, the share page). */
export function reeUrl(ree: Pick<PublicRee, 'slug' | 'role'>, locale: Locale): string {
  return localeUrl(reeContentLocale(ree) ?? locale, `/r/${ree.slug}`);
}

/** What a Ree page's title promises after the Ree's name: what people come to do there. */
const REE_TITLE_PROMISE: Record<Locale, string> = { en: 'Ask questions, get cited answers', zh: '提问，获得带出处的回答' };

/**
 * A public Ree's page title: its name and what the page is for, in the
 * Ree's own language (so both URLs of an English Ree read the same), e.g.
 * "System Design Primer — Ask questions, get cited answers · RE0".
 */
export function reeTitle(ree: Pick<PublicRee, 'name' | 'role'>, locale: Locale): string {
  return `${ree.name} — ${REE_TITLE_PROMISE[reeContentLocale(ree) ?? locale]}`;
}

/** `/r/<slug>`'s metadata: `publicPage` in the Ree's content language, with the Ree's own preview image. */
export function reePage(ree: Pick<PublicRee, 'slug' | 'name' | 'role'>, locale: Locale, description: string): Metadata {
  return publicPage({ path: `/r/${ree.slug}`, title: reeTitle(ree, locale), description, locale, ownImage: true, contentLocale: reeContentLocale(ree) });
}

/**
 * Text as one line of at most `max` characters, cut with an ellipsis.
 * Counted in code points, so an emoji is never split into a lone surrogate.
 */
export function oneLine(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}

type JsonLd = Record<string, unknown>;

const organizationId = () => absoluteUrl('/#organization');
const websiteId = () => absoluteUrl('/#website');

/** The home page's graph: who runs the site, and the site itself. */
export function siteJsonLd(description: string): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'Organization', '@id': organizationId(), name: SITE_NAME, url: absoluteUrl('/'), logo: absoluteUrl('/apple-icon.png') },
      { '@type': 'WebSite', '@id': websiteId(), name: SITE_NAME, url: absoluteUrl('/'), description, inLanguage: LOCALES.map((locale) => HTML_LANG[locale]), publisher: { '@id': organizationId() } },
    ],
  };
}

/**
 * A public Ree's page: the page, its breadcrumb (home → explore → the Ree)
 * and the Ree as a creative work by its owner. Nothing claimed that the
 * page does not show: no ratings, no prices in currency. No image either:
 * the Ree's preview sits at a path Next hashes (the route is in a group),
 * and og:image already carries it.
 */
export function reeJsonLd(ree: PublicRee, locale: Locale, labels: { home: string; explore: string; category: string; description: string }): JsonLd {
  /* The canonical page (reePage): an English Ree's /zh URL describes its /en page. */
  const contentLocale = reeContentLocale(ree) ?? locale;
  const url = reeUrl(ree, locale);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': url,
        url,
        name: ree.name,
        description: labels.description,
        inLanguage: HTML_LANG[contentLocale],
        isPartOf: { '@id': websiteId() },
        breadcrumb: { '@id': `${url}#breadcrumb` },
        mainEntity: { '@id': `${url}#ree` },
        dateModified: ree.updatedAt.toISOString(),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: labels.home, item: localeUrl(locale, '/') },
          { '@type': 'ListItem', position: 2, name: labels.explore, item: localeUrl(locale, '/explore') },
          { '@type': 'ListItem', position: 3, name: ree.name, item: url },
        ],
      },
      {
        '@type': 'CreativeWork',
        '@id': `${url}#ree`,
        name: ree.name,
        description: labels.description,
        url,
        genre: labels.category,
        keywords: ree.tags.length ? ree.tags.join(', ') : undefined,
        author: { '@type': ree.role === 'official' ? 'Organization' : 'Person', name: ree.ownerName, url: ree.ownerWebsite || undefined },
        dateModified: ree.updatedAt.toISOString(),
        publisher: { '@id': organizationId() },
      },
    ],
  };
}

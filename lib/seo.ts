import type { Metadata } from 'next';
import { appBaseUrl } from '@/lib/http/cookies';
import type { PricingView } from '@/lib/domain/pricing';
import type { PublicRee } from '@/lib/services/public-rees';
import type { Locale } from '@/i18n/locale';

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

/** app/opengraph-image.tsx, named outright: a page that sets its own `openGraph` no longer inherits the file's image. */
const SITE_IMAGE = { url: '/opengraph-image', width: 1200, height: 630, alt: 'RE0 — Your knowledge, a voice of its own' };

/**
 * An indexable page's own metadata: its canonical URL, and Open Graph and
 * Twitter copies of its title and description, and the site's image. A
 * route with its own `opengraph-image` file (a public Ree) passes
 * `ownImage`: an image named here would replace the file's.
 */
export function publicPage({ path, title, description, locale, absoluteTitle = false, ownImage = false }: { path: string; title: string; description: string; locale: Locale; absoluteTitle?: boolean; ownImage?: boolean }): Metadata {
  const url = absoluteUrl(path);
  /* Left out, not `undefined`: Next reads a present `images` key as "no image" and drops the file's. */
  const image = ownImage ? {} : { images: [SITE_IMAGE] };
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'website', siteName: SITE_NAME, locale: ogLocale(locale), url, title, description, ...image },
    twitter: { card: 'summary_large_image', title, description, ...image },
  };
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
      { '@type': 'WebSite', '@id': websiteId(), name: SITE_NAME, url: absoluteUrl('/'), description, inLanguage: ['zh-CN', 'en'], publisher: { '@id': organizationId() } },
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
export function reeJsonLd(ree: PublicRee, labels: { home: string; explore: string; category: string; description: string }): JsonLd {
  const url = absoluteUrl(`/r/${ree.slug}`);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': url,
        url,
        name: ree.name,
        description: labels.description,
        isPartOf: { '@id': websiteId() },
        breadcrumb: { '@id': `${url}#breadcrumb` },
        mainEntity: { '@id': `${url}#ree` },
        dateModified: ree.updatedAt.toISOString(),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: labels.home, item: absoluteUrl('/') },
          { '@type': 'ListItem', position: 2, name: labels.explore, item: absoluteUrl('/explore') },
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

/**
 * `/pricing`: the two things for sale, at the prices the page shows (USD
 * cents in the catalogue). A Pack on promotion carries its promotional
 * price until the promotion ends; the Plan's promotion is first-period
 * only, so its offer is the regular monthly price.
 */
export function pricingJsonLd(prices: PricingView, description: string): JsonLd {
  const usd = (minor: number) => (minor / 100).toFixed(2);
  const pack = prices.pack;
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `${SITE_NAME} credits`,
    description,
    brand: { '@type': 'Brand', name: SITE_NAME },
    url: absoluteUrl('/pricing'),
    offers: [
      {
        '@type': 'Offer',
        name: `Plan · ${prices.plan.credits} credits / month`,
        price: usd(prices.plan.priceMinor),
        priceCurrency: 'USD',
        priceSpecification: { '@type': 'UnitPriceSpecification', price: usd(prices.plan.priceMinor), priceCurrency: 'USD', billingDuration: 'P1M' },
        availability: 'https://schema.org/InStock',
        url: absoluteUrl('/checkout?kind=plan'),
      },
      {
        '@type': 'Offer',
        name: `Pack · ${pack.credits} credits`,
        price: usd(pack.effectivePriceMinor),
        priceCurrency: 'USD',
        priceValidUntil: pack.promotional && pack.promotion ? pack.promotion.endsAt : undefined,
        availability: 'https://schema.org/InStock',
        url: absoluteUrl('/checkout?kind=pack'),
      },
    ],
  };
}

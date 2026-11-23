import type { PricingView } from '@/lib/domain/pricing';
import type { PostView } from '@/lib/domain/post';
import { HTML_LANG, type Locale } from '@/i18n/locale';
import { absoluteUrl, localeUrl, reeUrl, siteImage, SITE_NAME } from '@/lib/seo';
import type { PublicRee } from '@/lib/services/public-rees';

/**
 * JSON-LD for the pricing page, a post's page and Explore (2026-11-23, GSC
 * review A11 / A15; components/site/structured-data.tsx renders them).
 * Only what the page itself shows: no ratings, no reviews, no counts the
 * reader cannot see.
 */
export type JsonLdGraph = Record<string, unknown>;

const usd = (minor: number) => (minor / 100).toFixed(2);
const organization = () => ({ '@type': 'Organization', name: SITE_NAME, url: absoluteUrl('/') });

/**
 * `/pricing`: RE0 as a web application with the three offers the page
 * shows -- the free trial, the Plan at its regular monthly price (its
 * promotion is first-period only) and the Pack, at its promotional price
 * until the promotion ends. Was a `Product` until 2026-11: Search Console
 * read that as a merchant listing (a physical good) and flagged it for a
 * missing image, return policy and shipping. Google shows a software-app
 * rich result only with a rating or review, which RE0 does not have and
 * does not invent; the markup still says what the page is.
 */
export function pricingJsonLd(prices: PricingView, locale: Locale, description: string): JsonLdGraph {
  const pack = prices.pack;
  const url = localeUrl(locale, '/pricing');
  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    '@id': `${url}#app`,
    name: SITE_NAME,
    description,
    url,
    image: absoluteUrl(siteImage(locale).url),
    applicationCategory: 'ReferenceApplication',
    operatingSystem: 'Web',
    inLanguage: HTML_LANG[locale],
    publisher: organization(),
    offers: [
      { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD', url },
      {
        '@type': 'Offer',
        name: `Plan · ${prices.plan.credits} credits / month`,
        price: usd(prices.plan.priceMinor),
        priceCurrency: 'USD',
        priceSpecification: { '@type': 'UnitPriceSpecification', price: usd(prices.plan.priceMinor), priceCurrency: 'USD', billingDuration: 'P1M' },
        url: absoluteUrl('/checkout?kind=plan'),
      },
      {
        '@type': 'Offer',
        name: `Pack · ${pack.credits} credits`,
        price: usd(pack.effectivePriceMinor),
        priceCurrency: 'USD',
        priceValidUntil: pack.promotional && pack.promotion ? pack.promotion.endsAt : undefined,
        url: absoluteUrl('/checkout?kind=pack'),
      },
    ],
  };
}

/**
 * `/p/[id]`: the question and the Rees' answers, as a Q&A page. Only for a
 * page that may be indexed -- public, published, with at least one answer
 * shown (lib/og/post-meta.ts) -- so `null` for anything else. An answer the
 * asker pinned is the accepted one; the rest are suggested. Each answer
 * links to its own anchor (`#a-…`, components/posts/post-detail.tsx) and
 * carries its "有帮助" count. The page is in the reader's language, the
 * question and answers in the post's own. A Ree is not a person, so answers name no
 * author; the question names its asker only when the page does.
 */
export function postJsonLd(post: PostView, locale: Locale): JsonLdGraph | null {
  if (post.visibility !== 'public' || post.status !== 'published' || post.hiddenBy || post.deleted) return null;
  const answers = post.answers.filter((entry) => entry.state === 'answered' && entry.text.trim());
  if (answers.length === 0) return null;
  const url = localeUrl(locale, `/p/${post.id}`);
  const answer = (entry: PostView['answers'][number]) => ({ '@type': 'Answer', text: entry.text, url: `${url}#a-${entry.id}`, upvoteCount: entry.helpful });
  const accepted = answers.filter((entry) => entry.pinned);
  const suggested = answers.filter((entry) => !entry.pinned);
  const author =
    post.author.kind === 'user' ? { '@type': 'Person', name: post.author.name }
    : post.author.kind === 'example' ? organization()
    : undefined;
  return {
    '@context': 'https://schema.org',
    '@type': 'QAPage',
    '@id': url,
    url,
    inLanguage: HTML_LANG[locale],
    mainEntity: {
      '@type': 'Question',
      inLanguage: HTML_LANG[post.lang],
      name: post.question,
      text: post.detail.trim() ? `${post.question}\n\n${post.detail.trim()}` : post.question,
      answerCount: answers.length,
      datePublished: post.createdAt,
      author,
      acceptedAnswer: accepted.length ? accepted.map(answer) : undefined,
      suggestedAnswer: suggested.length ? suggested.map(answer) : undefined,
    },
  };
}

/**
 * `/explore`, a category of it or one of their numbered pages (each its own
 * canonical, `path`): the page as a collection, and the Rees it lists (the
 * batch rendered on the server; the rest load as the list scrolls), each at
 * its canonical page (`reeUrl`: an official Ree's is in English).
 */
export function exploreJsonLd(rees: readonly Pick<PublicRee, 'slug' | 'name' | 'role'>[], locale: Locale, labels: { path: string; name: string; description: string }): JsonLdGraph {
  const url = localeUrl(locale, labels.path);
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': url,
    url,
    name: labels.name,
    description: labels.description,
    inLanguage: HTML_LANG[locale],
    isPartOf: { '@id': absoluteUrl('/#website') },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: rees.length,
      itemListElement: rees.map((ree, index) => ({ '@type': 'ListItem', position: index + 1, url: reeUrl(ree, locale), name: ree.name })),
    },
  };
}

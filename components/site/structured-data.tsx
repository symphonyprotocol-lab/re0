import type { ExploreQuery } from '@/lib/domain/explore';
import type { PostView } from '@/lib/domain/post';
import { exploreJsonLd, postJsonLd } from '@/lib/jsonld';
import type { Locale } from '@/i18n/locale';
import type { PublicRee } from '@/lib/services/public-rees';
import { JsonLd } from '@/components/site/json-ld';
import { explorePagePath } from '@/components/discover/explore-pages';

/**
 * A page's JSON-LD block (lib/jsonld.ts), each one line in its page, from
 * what the page already has. Synchronous, so a page renders without a
 * suspense boundary around them.
 */

/** `/p/[id]`: a Q&A page, only when the post may be indexed. */
export function PostJsonLd({ post, locale }: { post: PostView; locale: Locale }) {
  const data = postJsonLd(post, locale);
  return data ? <JsonLd data={data} /> : null;
}

/**
 * `/explore`, a category or a numbered page: a collection of the Rees it
 * lists, at the page's own canonical. Not for a search (not indexed) or
 * another order (`?sort=` shares the unsorted page's canonical, so its
 * list would describe another page). `name` and `description` are the
 * page's title and description.
 */
export function ExploreJsonLd({ query, page, locale, rees, name, description }: { query: ExploreQuery; page: number; locale: Locale; rees: readonly Pick<PublicRee, 'slug' | 'name' | 'role'>[]; name: string; description: string }) {
  if (query.q || query.sort !== 'active') return null;
  return <JsonLd data={exploreJsonLd(rees, locale, { path: explorePagePath({ category: query.category }, page), name, description })} />;
}

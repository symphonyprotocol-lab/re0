import type { ExploreQuery } from '@/lib/domain/explore';
import type { PostView } from '@/lib/domain/post';
import { exploreJsonLd, postJsonLd } from '@/lib/jsonld';
import { serverMessages } from '@/i18n/server';
import { JsonLd } from '@/components/site/json-ld';

/**
 * A page's JSON-LD block (lib/jsonld.ts), each one line in its page. They
 * read the page's language themselves, so the page passes only what it
 * already has.
 */

/** `/p/[id]`: a Q&A page, only when the post may be indexed. */
export async function PostJsonLd({ post }: { post: PostView }) {
  const { locale } = await serverMessages();
  const data = postJsonLd(post, locale);
  return data ? <JsonLd data={data} /> : null;
}

/**
 * `/explore`: a collection of the Rees listed first. Only the plain list,
 * the page's canonical: a search is not indexed, and a category or order
 * shares `/explore`'s canonical, so its list would describe another page.
 */
export async function ExploreJsonLd({ query, rees }: { query: ExploreQuery; rees: readonly { slug: string; name: string }[] }) {
  if (query.q || query.category || query.sort !== 'active') return null;
  const { t, locale } = await serverMessages();
  return <JsonLd data={exploreJsonLd(rees, locale, { name: t.discover.explore.title, description: t.discover.explore.body })} />;
}

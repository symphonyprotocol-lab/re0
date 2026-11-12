import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { currentUser } from '@/lib/http/session';
import { publicReeBySlug as lookup, type PublicRee } from '@/lib/services/public-rees';
import { oneLine, publicPage, reeJsonLd, SITE_NAME } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { ReeDetail } from '@/components/discover/ree-detail';
import { JsonLd } from '@/components/site/json-ld';

/** Metadata and the page share one lookup per request. */
const publicReeBySlug = cache(lookup);

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [ree, { t, locale }] = await Promise.all([params.then(({ slug }) => publicReeBySlug(slug)), serverMessages()]);
  if (!ree) return { title: { absolute: SITE_NAME }, robots: { index: false } };
  const meta = publicPage({ path: `/r/${ree.slug}`, title: ree.name, description: reeDescription(ree, t.site.seo.reeFallback), locale, ownImage: true });
  return { ...meta, keywords: ree.tags.length ? ree.tags : undefined };
}

/** The Ree's own description as one line, or the site's sentence about a Ree when it has none. */
function reeDescription(ree: PublicRee, fallback: string): string {
  return oneLine(ree.description, 200) || fallback;
}

/**
 * `/r/[slug]` (rebuild-proposal.md 2.4, prototype public-dot.js): a public
 * Ree on show with public comments. Asking happens in a conversation via
 * 「加入对话」. Knowledge appears only as
 * a count. Private, taken-down and deleted Rees are not found. Indexable.
 */
export default async function PublicReePage({ params, searchParams }: Props) {
  const [{ slug }, query, user, { t, locale }] = await Promise.all([params, searchParams, currentUser(), serverMessages()]);
  const ree = await publicReeBySlug(slug);
  if (!ree) notFound();
  const category = t.common.categories[ree.category as keyof typeof t.common.categories] ?? ree.category;
  return (
    <>
      <JsonLd data={reeJsonLd(ree, locale, { home: t.site.nav.home, explore: t.discover.explore.title, category, description: reeDescription(ree, t.site.seo.reeFallback) })} />
      <ReeDetail ree={ree} query={query} viewerId={user?.id} />
    </>
  );
}

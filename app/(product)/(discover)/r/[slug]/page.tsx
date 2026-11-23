import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import { currentUser } from '@/lib/http/session';
import { authorOthersPages, publicReeBySlug as lookup, type PublicRee } from '@/lib/services/public-rees';
import { oneLine, publicPage, reeJsonLd, SITE_NAME, UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { localePath } from '@/i18n/paths';
import type { Locale } from '@/i18n/locale';
import { ReeDetail } from '@/components/discover/ree-detail';
import { JsonLd } from '@/components/site/json-ld';

/** Metadata and the page share one lookup per request. */
const publicReeBySlug = cache(lookup);

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * 同一创作者的更多 Ree's page (`?ap=`), and whether it may be indexed.
 * Every Ree links hundreds of these (an owner with ~2.9k public Rees has
 * ~730 pages), each the same Ree page with another four cards: page 2 on
 * is `noindex, follow`, and a page that does not exist (past the last, not
 * a whole number, 1 spelled out) moves to the Ree's own URL. The
 * (discover) loading.tsx boundary has sent the 200 by the time this runs,
 * so the move arrives as an instant meta refresh, which Google treats as a
 * permanent redirect; it becomes a real 308 once that boundary no longer
 * wraps this page.
 */
async function authorPageGate(ree: PublicRee, raw: string | string[] | undefined, locale: Locale): Promise<Metadata['robots'] | undefined> {
  if (raw === undefined) return undefined;
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const page = /^[1-9][0-9]{0,5}$/.test(value) ? Number(value) : NaN;
  if (!(page >= 2) || page > (await authorOthersPages(ree))) permanentRedirect(localePath(locale, `/r/${ree.slug}`));
  return UNLISTED_ROBOTS;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [ree, query, { t, locale }] = await Promise.all([params.then(({ slug }) => publicReeBySlug(slug)), searchParams, serverMessages()]);
  if (!ree) return { title: { absolute: SITE_NAME }, robots: { index: false } };
  const robots = await authorPageGate(ree, query.ap, locale);
  const meta = publicPage({ path: `/r/${ree.slug}`, title: ree.name, description: reeDescription(ree, t.site.seo.reeFallback), locale, ownImage: true });
  return { ...meta, keywords: ree.tags.length ? ree.tags : undefined, ...(robots ? { robots } : {}) };
}

/** The Ree's own description as one line, or the site's sentence about a Ree when it has none. */
function reeDescription(ree: PublicRee, fallback: string): string {
  return oneLine(ree.description, 200) || fallback;
}

/**
 * `/r/[slug]` (rebuild-proposal.md 2.4, prototype public-dot.js): a public
 * Ree on show with public comments. Asking happens in the 向它提问 box (a
 * public post or a private question). Knowledge appears only as a count. Private, taken-down and deleted Rees are not found. Indexable.
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

import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { cache } from 'react';
import { currentUser } from '@/lib/http/session';
import { authorOthersPages, publicReeBySlug as lookup, type PublicRee } from '@/lib/services/public-rees';
import { reeAnsweredExamples } from '@/lib/services/posts';
import { reeDescription, reeJsonLd, reeMetaDescription, reePage, SITE_NAME, UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { localePath } from '@/i18n/paths';
import type { Locale } from '@/i18n/locale';
import { ReeDetail } from '@/components/discover/ree-detail';
import { ReeExamples } from '@/components/discover/ree-examples';
import { JsonLd } from '@/components/site/json-ld';

/** Metadata and the page share one lookup per request, and one read of the Ree's answered questions. */
const publicReeBySlug = cache(lookup);
const answeredExamples = cache(reeAnsweredExamples);

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * 同一创作者的更多 Ree's page (`?ap=`), and whether it may be indexed.
 * Every Ree linked hundreds of these (an owner with ~2.9k public Rees has
 * ~730 pages), each the same Ree page with another four cards. The pager
 * now fetches in place (GET /api/rees/[id]/author-rees) and robots.txt
 * disallows `ap`; for the old URLs still out there, page 2 on
 * is `noindex, follow`, and a page that does not exist (past the last, not
 * a whole number, 1 spelled out) moves to the Ree's own URL with a real
 * 308: no loading.tsx boundary wraps this page, so nothing is sent before
 * it runs.
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
  const [robots, examples] = await Promise.all([authorPageGate(ree, query.ap, locale), answeredExamples(ree.id)]);
  const meta = reePage(ree, locale, reeMetaDescription(ree, examples, t.site.seo.reeFallback));
  return { ...meta, keywords: ree.tags.length ? ree.tags : undefined, ...(robots ? { robots } : {}) };
}

/**
 * `/r/[slug]` (rebuild-proposal.md 2.4, prototype public-dot.js): a public
 * Ree on show with public comments. Asking happens in the 向它提问 box (a
 * public post or a private question). Knowledge appears only as a count. Private, taken-down and deleted Rees are not found. Indexable.
 * Under the introduction, the questions it answered best in public posts
 * (`ReeExamples`), so the page carries real answers in its HTML.
 *
 * Not found is a real 404 (GSC review 2026-11, A8; it was a 200 with
 * noindex): neither app/loading.tsx nor a (discover) one wraps this page any
 * more, so the status is still open when `notFound()` runs. A taken-down
 * Ree is a 404 too -- a page cannot answer 410; that would take middleware.
 */
export default async function PublicReePage({ params, searchParams }: Props) {
  const [{ slug }, query, user, { t, locale }] = await Promise.all([params, searchParams, currentUser(), serverMessages()]);
  const ree = await publicReeBySlug(slug);
  if (!ree) notFound();
  const examples = await answeredExamples(ree.id);
  const category = t.common.categories[ree.category as keyof typeof t.common.categories] ?? ree.category;
  return (
    <>
      <JsonLd data={reeJsonLd(ree, locale, { home: t.site.nav.home, explore: t.discover.explore.title, category, description: reeDescription(ree, t.site.seo.reeFallback) })} />
      <ReeDetail ree={ree} query={query} viewerId={user?.id} examples={<ReeExamples examples={examples} locale={locale} labels={t.discover.public.examples} />} />
    </>
  );
}

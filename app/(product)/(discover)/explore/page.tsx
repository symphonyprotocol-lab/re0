import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound, permanentRedirect } from 'next/navigation';
import { parseExploreQuery, type ExploreQuery } from '@/lib/domain/explore';
import { clientIp } from '@/lib/http/client-ip';
import { currentUser } from '@/lib/http/session';
import { allowSearch, explore } from '@/lib/services/explore';
import { favoriteReeIds, listFavoriteRees } from '@/lib/services/ree-favorites';
import { introsFor } from '@/lib/services/video';
import { publicPage, UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { localePath } from '@/i18n/paths';
import type { Messages } from '@/i18n';
import { fill } from '@/i18n/format';
import { FeedColumns } from '@/components/shell/feed-columns';
import { ExploreView, SiteRail } from '@/components/discover/explore-view';
import { EXPLORE_PAGE_SIZE, explorePageCount, explorePagePath, parseExplorePage } from '@/components/discover/explore-pages';
import { ExploreJsonLd } from '@/components/site/structured-data';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** How many saved Rees the right column lists. */
const RAIL_SAVED = 3;

/**
 * What the list is, in words (GSC review 2026-11, A9 / A12): the whole list
 * or one category's, and which numbered page. The h1, the title and the
 * description all come from here.
 */
function describe(t: Messages, query: ExploreQuery, page: number): { heading: string; body: string; title: string } {
  const e = t.discover.explore;
  const category = query.category ? t.common.categories[query.category] : null;
  const heading = category ? fill(e.categoryHeading, { category }) : e.heading;
  const suffix = page > 1 ? ` · ${fill(e.pageSuffix, { page })}` : '';
  return {
    heading: `${heading}${suffix}`,
    body: category ? fill(e.categoryBody, { category }) : e.headingBody,
    title: `${category ? heading : e.seoTitle}${suffix}`,
  };
}

/**
 * Each category and each numbered page is its own canonical page (so a
 * crawler that follows the category and page links finds every Ree); the
 * order is not (`?sort=` shares the unsorted URL), and a search's results
 * are not themselves a search result.
 */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const [params, { t, locale }] = await Promise.all([searchParams, serverMessages()]);
  const query = parseExploreQuery(params);
  if (query.q) return { ...publicPage({ path: '/explore', title: t.discover.explore.seoTitle, description: t.discover.explore.headingBody, locale }), robots: UNLISTED_ROBOTS };
  const page = parseExplorePage(params.page) ?? 1;
  const words = describe(t, query, page);
  return publicPage({ path: explorePagePath({ category: query.category }, page), title: words.title, description: words.body, locale });
}

/**
 * `/explore` -- Rees (v6; was 发现): only Rees. One box for a question, the
 * categories and orders; with a question, the two-level search (free,
 * rate-limited); without, the most active public Rees, the first batch here
 * and the rest from `GET /api/explore` as the list scrolls. Categories are
 * links, and `?page=N` starts the list N batches in, with plain links to the
 * pages either side, so a crawler reaches every Ree. The right column
 * has the signed-in user's saved Rees and the create-a-Ree card.
 *
 * Posts moved to 首页 (v6): the old 帖子 tab's search is 首页's `?q=`, and
 * 待回答 is 首页's `?tab=unanswered`; old links go there for good.
 */
export default async function ExplorePage({ searchParams }: Props) {
  const params = await searchParams;
  if (params.tab === 'posts') {
    const q = typeof params.q === 'string' ? params.q.trim().slice(0, 200) : '';
    permanentRedirect(q ? `/?q=${encodeURIComponent(q)}` : '/');
  }
  if (params.tab === 'unanswered') permanentRedirect('/?tab=unanswered');
  const query = parseExploreQuery(params);
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  /* A numbered page: `?page=1` or a malformed one is the page without it, in this language; a search has no pages. */
  const page = query.q ? 1 : parseExplorePage(params.page);
  if (page === null || (query.q && params.page !== undefined)) permanentRedirect(localePath(locale, explorePagePath(query, 1)));
  const limited = Boolean(query.q) && !(await allowSearch({ ip: clientIp(await headers()), userId: user?.id ?? null }));
  const listed = limited ? { ...query, q: '' } : query;
  const result = await explore(listed, { cursor: null, size: EXPLORE_PAGE_SIZE }, { includeIntros: false, offset: (page - 1) * EXPLORE_PAGE_SIZE });
  /* Past the last page there is nothing to show: a real 404 (no loading boundary wraps this page). */
  if (page > 1 && (result.mode !== 'browse' || page > explorePageCount(result.total))) notFound();
  const [favoriteIds, coverVideos, saved] = await Promise.all([
    user ? favoriteReeIds(user.id, result.items.map((ree) => ree.id)) : undefined,
    introsFor(result.items.filter((ree) => !ree.coverBlob).map((ree) => ree.id)),
    user ? listFavoriteRees(user.id, 1).then((list) => list.items.slice(0, RAIL_SAVED)) : undefined,
  ]);
  const items = result.items.map((ree) => ({ ...ree, video: coverVideos.get(ree.id) ?? null }));
  const words = describe(t, listed, page);
  return (
    <FeedColumns title={t.common.nav.discover} heading={false} rail={<SiteRail saved={saved} signedIn={Boolean(user)} />}>
      <ExploreJsonLd query={query} page={page} locale={locale} rees={items} name={words.title} description={words.body} />
      <ExploreView query={query} result={{ ...result, items }} limited={limited} signedIn={Boolean(user)} favoriteIds={favoriteIds} viewerId={user?.id} renderedAt={Date.now()} page={page} intro={{ title: words.heading, body: words.body }} />
    </FeedColumns>
  );
}

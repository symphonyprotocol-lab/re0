import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { permanentRedirect } from 'next/navigation';
import { EXPLORE_BATCH_SIZES } from '@/lib/constants';
import { parseExploreQuery } from '@/lib/domain/explore';
import { clientIp } from '@/lib/http/conversations';
import { currentUser } from '@/lib/http/session';
import { allowSearch, explore } from '@/lib/services/explore';
import { favoriteReeIds, listFavoriteRees } from '@/lib/services/ree-favorites';
import { introsFor } from '@/lib/services/video';
import { publicPage, UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { FeedColumns } from '@/components/shell/feed-columns';
import { ExploreView, SiteRail } from '@/components/discover/explore-view';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** How many saved Rees the right column lists. */
const RAIL_SAVED = 3;

/** Filters and orders share `/explore`'s canonical; a search's results are not themselves a search result. */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const [params, { t, locale }] = await Promise.all([searchParams, serverMessages()]);
  const page = publicPage({ path: '/explore', title: t.discover.explore.title, description: t.discover.explore.body, locale });
  return parseExploreQuery(params).q ? { ...page, robots: UNLISTED_ROBOTS } : page;
}

/**
 * `/explore` -- Rees (v6; was 发现): only Rees. One box for a question, the
 * categories and orders; with a question, the two-level search (free,
 * rate-limited); without, the most active public Rees, the first batch here
 * and the rest from `GET /api/explore` as the list scrolls. The right column
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
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  const query = parseExploreQuery(params);
  const limited = Boolean(query.q) && !(await allowSearch({ ip: clientIp(await headers()), userId: user?.id ?? null }));
  const result = await explore(limited ? { ...query, q: '' } : query, { cursor: null, size: EXPLORE_BATCH_SIZES[0] }, { includeIntros: false });
  const [favoriteIds, coverVideos, saved] = await Promise.all([
    user ? favoriteReeIds(user.id, result.items.map((ree) => ree.id)) : undefined,
    introsFor(result.items.filter((ree) => !ree.coverBlob).map((ree) => ree.id)),
    user ? listFavoriteRees(user.id, 1).then((list) => list.items.slice(0, RAIL_SAVED)) : undefined,
  ]);
  const items = result.items.map((ree) => ({ ...ree, video: coverVideos.get(ree.id) ?? null }));
  return (
    <FeedColumns title={t.common.nav.discover} rail={<SiteRail saved={saved} signedIn={Boolean(user)} />}>
      <ExploreView query={query} result={{ ...result, items }} limited={limited} signedIn={Boolean(user)} favoriteIds={favoriteIds} viewerId={user?.id} renderedAt={Date.now()} />
    </FeedColumns>
  );
}

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { EXPLORE_BATCH_SIZES } from '@/lib/constants';
import { parseExploreQuery } from '@/lib/domain/explore';
import { clientIp } from '@/lib/http/conversations';
import { currentUser } from '@/lib/http/session';
import { allowSearch, explore } from '@/lib/services/explore';
import { favoriteReeIds } from '@/lib/services/ree-favorites';
import { introsFor } from '@/lib/services/video';
import { publicPage, UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { ExploreView } from '@/components/discover/explore-view';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Filters and orders share `/explore`'s canonical; a search's results are not themselves a search result. */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const [params, { t, locale }] = await Promise.all([searchParams, serverMessages()]);
  const page = publicPage({ path: '/explore', title: t.discover.explore.title, description: t.discover.explore.body, locale });
  return parseExploreQuery(params).q ? { ...page, robots: UNLISTED_ROBOTS } : page;
}

/**
 * `/explore` (rebuild-proposal.md 2.4): one box for a question, seven
 * categories, three orders. With a question, the two-level search (free,
 * rate-limited); without, the most active public Rees, the first batch here
 * and the rest from `GET /api/explore` as the list scrolls. Visitors see it
 * in the site frame, signed-in users in the workspace.
 */
export default async function ExplorePage({ searchParams }: Props) {
  const [params, user, { t }] = await Promise.all([searchParams, currentUser(), serverMessages()]);
  const query = parseExploreQuery(params);
  const limited = Boolean(query.q) && !(await allowSearch({ ip: clientIp(await headers()), userId: user?.id ?? null }));
  const result = await explore(limited ? { ...query, q: '' } : query, { cursor: null, size: EXPLORE_BATCH_SIZES[0] }, { includeIntros: false });
  const [favoriteIds, coverVideos] = await Promise.all([
    user ? favoriteReeIds(user.id, result.items.map(ree => ree.id)) : undefined,
    introsFor(result.items.filter(ree => !ree.coverBlob).map(ree => ree.id)),
  ]);
  const items = result.items.map(ree => ({ ...ree, video: coverVideos.get(ree.id) ?? null }));
  return (
    <>
      {user && <Topbar crumbs={[{ label: t.discover.explore.title }]} />}
      <ExploreView query={query} result={{ ...result, items }} limited={limited} signedIn={Boolean(user)} favoriteIds={favoriteIds} viewerId={user?.id} />
    </>
  );
}

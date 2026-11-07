import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { parseExploreQuery } from '@/lib/domain/explore';
import { clientIp } from '@/lib/http/conversations';
import { currentUser } from '@/lib/http/session';
import { allowSearch, explore } from '@/lib/services/explore';
import { favoriteReeIds } from '@/lib/services/ree-favorites';
import { introsFor } from '@/lib/services/video';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { ExploreView } from '@/components/discover/explore-view';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.discover.explore.title, description: t.discover.explore.body };
}

/**
 * `/explore` (rebuild-proposal.md 2.4): one box for a question, seven
 * categories, three orders, 24 / 48 / 96 a page. With a question, the
 * two-level search (free, rate-limited); without, the most active public
 * Rees. Visitors see it in the site frame, signed-in users in the workspace.
 */
export default async function ExplorePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [params, user, { t }] = await Promise.all([searchParams, currentUser(), serverMessages()]);
  const query = parseExploreQuery(params);
  const limited = Boolean(query.q) && !(await allowSearch({ ip: clientIp(await headers()), userId: user?.id ?? null }));
  const result = await explore(limited ? { ...query, q: '' } : query, { includeIntros: false });
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

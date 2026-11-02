import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { parseExploreQuery } from '@/lib/domain/explore';
import { clientIp } from '@/lib/http/conversations';
import { currentUser } from '@/lib/http/session';
import { allowSearch, explore, type ExploreResult } from '@/lib/services/explore';
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
  let limited = false;
  let result: ExploreResult;
  if (query.q && !(await allowSearch({ ip: clientIp(await headers()), userId: user?.id ?? null }))) {
    limited = true;
    result = await explore({ ...query, q: '' });
  } else {
    result = await explore(query);
  }
  return (
    <>
      {user && <Topbar crumbs={[{ label: t.discover.explore.title }]} />}
      <ExploreView query={query} result={result} limited={limited} signedIn={Boolean(user)} />
    </>
  );
}

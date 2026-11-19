import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { EXPLORE_BATCH_SIZES } from '@/lib/constants';
import { parseExploreQuery } from '@/lib/domain/explore';
import { clientIp } from '@/lib/http/conversations';
import { currentUser } from '@/lib/http/session';
import { allowSearch, explore, weeklyMostAsked } from '@/lib/services/explore';
import { favoriteReeIds } from '@/lib/services/ree-favorites';
import { introsFor } from '@/lib/services/video';
import { publicPage, UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { FeedColumns } from '@/components/shell/feed-columns';
import { ExploreRail, ExploreView } from '@/components/discover/explore-view';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { Icon } from '@/components/ui/icons';
import { PostFeed } from '@/components/posts/post-feed';
import { listFeed } from '@/lib/services/posts';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Filters and orders share `/explore`'s canonical; a search's results are not themselves a search result. */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const [params, { t, locale }] = await Promise.all([searchParams, serverMessages()]);
  const page = publicPage({ path: '/explore', title: t.discover.explore.title, description: t.discover.explore.body, locale });
  return parseExploreQuery(params).q || params.tab === 'posts' || params.tab === 'unanswered' ? { ...page, robots: UNLISTED_ROBOTS } : page;
}

/**
 * `/explore` (rebuild-proposal.md 2.4): one box for a question, seven
 * categories, three orders. With a question, the two-level search (free,
 * rate-limited); without, the most active public Rees, the first batch here
 * and the rest from `GET /api/explore` as the list scrolls, one Ree per feed
 * item, in the three-column frame (v5) for visitors and signed-in users alike.
 * Two more tabs (v5): 帖子 searches public posts by their words (`?tab=posts&q=`)
 * and 待回答 lists the posts no Ree could answer, for creators.
 */
export default async function ExplorePage({ searchParams }: Props) {
  const [params, user, { t }] = await Promise.all([searchParams, currentUser(), serverMessages()]);
  const query = parseExploreQuery(params);
  const tab = params.tab === 'posts' || params.tab === 'unanswered' ? params.tab : 'rees';
  const e = t.posts.explore;
  const tabs = (
    <div className="cl-tabs" role="tablist" aria-label={t.common.nav.discover}>
      {([['rees', e.rees, '/explore'], ['posts', e.posts, '/explore?tab=posts'], ['unanswered', e.unanswered, '/explore?tab=unanswered']] as const).map(([key, label, href]) => (
        <Link key={key} href={href} role="tab" aria-selected={tab === key} className={`cl-tab${tab === key ? ' active' : ''}`} scroll={false}>
          {label}
        </Link>
      ))}
    </div>
  );
  if (tab !== 'rees') {
    const top = await weeklyMostAsked();
    const q = tab === 'posts' && typeof params.q === 'string' ? params.q.slice(0, 200) : null;
    const feed = await listFeed(tab === 'posts' ? 'latest' : 'unanswered', { viewerId: user?.id, q });
    return (
      <FeedColumns title={t.common.nav.discover} tabs={tabs} rail={<ExploreRail rail={{ top }} signedIn={Boolean(user)} from="/explore" />}>
        {tab === 'posts' && (
          <form action="/explore" role="search" className="post-search" aria-label={e.searchPosts}>
            <input type="hidden" name="tab" value="posts" />
            <Icon name="search" className="size-4" />
            <input name="q" defaultValue={q ?? ''} placeholder={e.searchPosts} aria-label={e.searchPosts} className="min-w-0 flex-1 bg-transparent outline-none" />
          </form>
        )}
        <PostFeed
          key={`${tab}:${q ?? ''}`}
          tab={tab === 'posts' ? 'latest' : 'unanswered'}
          q={q}
          initial={feed}
          now={Date.now()}
          signedIn={Boolean(user)}
          empty={<p className="px-[18px] py-10 text-center text-[13px] text-muted">{tab === 'posts' ? e.noPosts : t.posts.home.emptyUnanswered}</p>}
        />
      </FeedColumns>
    );
  }
  const limited = Boolean(query.q) && !(await allowSearch({ ip: clientIp(await headers()), userId: user?.id ?? null }));
  const result = await explore(limited ? { ...query, q: '' } : query, { cursor: null, size: EXPLORE_BATCH_SIZES[0] }, { includeIntros: false });
  const [favoriteIds, coverVideos, top] = await Promise.all([
    user ? favoriteReeIds(user.id, result.items.map(ree => ree.id)) : undefined,
    introsFor(result.items.filter(ree => !ree.coverBlob).map(ree => ree.id)),
    weeklyMostAsked(),
  ]);
  const items = result.items.map(ree => ({ ...ree, video: coverVideos.get(ree.id) ?? null }));
  const renderedAt = Date.now();
  return (
    <FeedColumns title={t.common.nav.discover} tabs={tabs} rail={<ExploreRail rail={{ top }} signedIn={Boolean(user)} from="/explore" />}>
      <ExploreView query={query} result={{ ...result, items }} limited={limited} signedIn={Boolean(user)} favoriteIds={favoriteIds} viewerId={user?.id} renderedAt={renderedAt} />
    </FeedColumns>
  );
}

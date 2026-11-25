import type { Metadata } from 'next';
import { Suspense } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { EXPLORE_BATCH_SIZES } from '@/lib/constants';
import { parseExploreQuery } from '@/lib/domain/explore';
import { currentUser } from '@/lib/http/session';
import { explore } from '@/lib/services/explore';
import { favoriteReeIds } from '@/lib/services/ree-favorites';
import { rewardSettings } from '@/lib/services/invites';
import { ownShareableRee } from '@/lib/services/public-rees';
import { appBaseUrl } from '@/lib/http/cookies';
import { introsFor } from '@/lib/services/video';
import { publicPage, siteJsonLd, SITE_NAME, UNLISTED_ROBOTS } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { FeedColumns } from '@/components/shell/feed-columns';
import { ExploreView, RailSearch, SiteRail, type RailShare } from '@/components/discover/explore-view';
import { Icon } from '@/components/ui/icons';
import { JsonLd } from '@/components/site/json-ld';
import { feedTabOf, FEED_TABS, type FeedTab } from '@/lib/domain/post';
import { listFeed, unansweredCount } from '@/lib/services/posts';
import { listChannels } from '@/lib/services/channels';
import { ChannelList } from '@/components/posts/channel-list';
import { HomeComposer } from '@/components/posts/composer';
import { PostFeed } from '@/components/posts/post-feed';
import { RouteLoading } from '@/components/shell/route-loading';
import '@/components/ui/tabs.css';

/** 首页 shows this many Rees until there are posts; 发现 has them all. */
const HOME_REES = 6;
/** Once there are posts, the right column links this many of the most active Rees (GSC review 2026-11, A9: the page's HTML had no Ree links at all). */
const RAIL_REES = 5;

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** 首页's tabs: the three feeds, then 频道 (the channels, `?tab=channels`, whose `?q=` searches channel names). */
const HOME_TABS = [...FEED_TABS, 'channels'] as const;

/** The words a post search on 首页 looks for (`?q=`, v6; was 发现's 帖子 tab), or null. */
function searchOf(params: Record<string, string | string[] | undefined>): string | null {
  const q = typeof params.q === 'string' ? params.q.trim().slice(0, 200) : '';
  return q || null;
}

/** The site's front page keeps its title, description and canonical `/` (and the site's structured data); the rest of the old home is `/about`. A post search's results are not themselves a search result. */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const [{ t, locale }, params] = await Promise.all([serverMessages(), searchParams]);
  const page = publicPage({ path: '/', title: `${t.site.home.title} · ${SITE_NAME}`, absoluteTitle: true, description: t.site.seo.description, locale });
  return searchOf(params) ? { ...page, robots: UNLISTED_ROBOTS } : page;
}

/**
 * `/` -- 首页 (v6): the feed in the three-column frame. Signed in, it opens
 * on the composer and the feed; a visitor first sees one welcome card --
 * what RE0 does in a line, one button to sign in and ask, and the way to
 * 了解 RE0 (`/about`, the rest of the old home). The feed is public posts
 * under three tabs (为你推荐 / 最新 / 待回答, `?tab=`), rendered on the
 * server so the page carries indexable questions and answers, and a fourth,
 * 频道 (`?tab=channels`), lists the channels `#tags` made, its own `?q=`
 * searching their names; elsewhere `?q=` searches posts by their words (the right column's box, or the centre
 * column's below 1200px where that column folds away). While there are no
 * posts at all yet, a short list of the most active public Rees stands in
 * with the way to Rees, which alone has the whole list; once there are,
 * the right column lists the most active ones instead. A visitor's h1 is
 * the welcome card's line.
 *
 * The feed streams in behind the route's loading state: this page has no
 * loading.tsx of its own, and app/loading.tsx is gone so that public Ree and
 * post pages can answer a real 404 (GSC review 2026-11, A8).
 */
export default function HomePage(props: Props) {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Home {...props} />
    </Suspense>
  );
}

async function Home({ searchParams }: Props) {
  const [user, { t, locale }, params] = await Promise.all([currentUser(), serverMessages(), searchParams]);
  const q = searchOf(params);
  const channelsTab = params.tab === 'channels';
  const tab: FeedTab = q ? 'latest' : feedTabOf(params.tab);
  const query = parseExploreQuery({});
  const [feed, waiting, active, channels, own, rewards] = await Promise.all([
    channelsTab ? { items: [], next: null } : listFeed(tab, { viewerId: user?.id, q }),
    unansweredCount(),
    explore(query, { cursor: null, size: EXPLORE_BATCH_SIZES[0] }, { includeIntros: false }),
    channelsTab ? listChannels({ q }) : null,
    user ? ownShareableRee(user.id) : null,
    user ? rewardSettings() : null,
  ]);
  /* 为你推荐 with nothing answered yet reads as 最新; no posts at all, a few Rees. */
  const shown = !channelsTab && !q && tab === 'for_you' && feed.items.length === 0 ? await listFeed('latest', { viewerId: user?.id }) : feed;
  const showRees = !channelsTab && !q && tab !== 'unanswered' && shown.items.length === 0;
  const result = showRees ? active : null;
  const rees = result?.items.slice(0, HOME_REES) ?? [];
  /* Without the stand-in list, the right column carries the Ree links. */
  const popular = showRees ? undefined : active.items.slice(0, RAIL_REES);
  const [favoriteIds, coverVideos] = result
    ? await Promise.all([
        user ? favoriteReeIds(user.id, rees.map((ree) => ree.id)) : undefined,
        introsFor(rees.filter((ree) => !ree.coverBlob).map((ree) => ree.id)),
      ])
    : [undefined, new Map()];
  /* The 分享 card: the most active public Ree's share page as the example (a live link), the user's own Ree to share, and what an invitation pays while it pays anything. */
  const exampleSlug = active.items[0]?.slug;
  const share: RailShare = {
    example: exampleSlug ? { slug: exampleSlug, url: `${appBaseUrl()}/s/${exampleSlug}` } : null,
    own,
    inviteCredits: rewards?.invitesEnabled && rewards.inviteCredits > 0 ? rewards.inviteCredits : null,
  };
  const v = t.site.visitor;
  const ph = t.posts.home;
  const searchLabel = t.posts.explore.searchPosts;
  const now = Date.now();
  /* The tab shown as current: 频道 even while searching it; no feed tab during a post search. */
  const current = channelsTab ? 'channels' : q ? null : tab;
  const tabs = (
    <div className="cl-tabs" role="tablist" aria-label={t.posts.tabs.label}>
      {HOME_TABS.map((key) => (
        <Link key={key} href={key === 'for_you' ? '/' : `/?tab=${key}`} role="tab" aria-selected={current === key} className={`cl-tab${current === key ? ' active' : ''}`} scroll={false}>
          {t.posts.tabs[key]}
          {key === 'unanswered' && waiting > 0 && <span>{formatNumber(waiting, locale)}</span>}
        </Link>
      ))}
    </div>
  );
  return (
    <>
      <JsonLd data={siteJsonLd(t.site.seo.description)} />
      <FeedColumns title={t.common.nav.homeFeed} heading={Boolean(user)} tabs={tabs} rail={<SiteRail search={{ action: '/', label: searchLabel, defaultValue: q ?? '' }} popular={popular} share={share} signedIn={Boolean(user)} />}>
        {/* Where the right column has folded away (under 1200px), its search sits here. */}
        {!channelsTab && (
          <div className="xcol-search">
            <RailSearch action="/" label={searchLabel} defaultValue={q ?? ''} />
          </div>
        )}
        {!user && !q && (
          <div className="px-[18px]">
            <section className="xwelcome" aria-labelledby="home-intro">
              <div className="xwelcome-text">
                <h1 id="home-intro">{v.welcomeTitle}</h1>
                <p>{v.welcomeBody}</p>
              </div>
              <div className="xwelcome-actions">
                <Link rel="nofollow" href={`/login?returnTo=${encodeURIComponent('/?compose=public')}`} className="btn btn-sm">
                  {v.introAsk}
                </Link>
                <Link href="/about" className="text-link">
                  {t.common.nav.about}
                  <Icon name="arrow" className="size-3.5" />
                </Link>
              </div>
            </section>
          </div>
        )}
        {q && !channelsTab && (
          <div className="xsearch-head">
            <p>{fill(ph.searchResults, { q })}</p>
            <Link href="/" className="text-link">
              {ph.searchClear}
            </Link>
          </div>
        )}
        {user && !q && <HomeComposer signedIn />}
        {channels ? (
          <ChannelList key={q ?? ''} q={q} initial={channels} now={now} />
        ) : (
          <PostFeed
            key={`${tab}:${q ?? ''}`}
            tab={shown === feed ? tab : 'latest'}
            q={q}
            initial={shown}
            now={now}
            signedIn={Boolean(user)}
            empty={q ? <p className="px-[18px] py-10 text-center text-[13px] text-muted">{t.posts.explore.noPosts}</p> : tab === 'unanswered' ? <p className="px-[18px] py-10 text-center text-[13px] text-muted">{ph.emptyUnanswered}</p> : null}
          />
        )}
        {result && (
          <>
            <p className="px-[18px] pt-6 text-[13px] text-muted">{ph.empty}</p>
            <ExploreView query={query} result={{ ...result, items: rees.map((ree) => ({ ...ree, video: coverVideos.get(ree.id) ?? null })), nextCursor: null }} limited={false} signedIn={Boolean(user)} favoriteIds={favoriteIds} viewerId={user?.id} renderedAt={now} variant="home" />
            <p className="px-[18px] pt-2 pb-10 text-center text-[13px]">
              <Link href="/explore" className="text-link">
                {t.site.visitor.allRees} →
              </Link>
            </p>
          </>
        )}
      </FeedColumns>
    </>
  );
}

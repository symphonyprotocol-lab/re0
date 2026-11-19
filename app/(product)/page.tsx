import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { EXPLORE_BATCH_SIZES } from '@/lib/constants';
import { parseExploreQuery } from '@/lib/domain/explore';
import { currentUser } from '@/lib/http/session';
import { explore, weeklyMostAsked } from '@/lib/services/explore';
import { favoriteReeIds } from '@/lib/services/ree-favorites';
import { welcomeCredits } from '@/lib/services/signup-reward';
import { introsFor } from '@/lib/services/video';
import { publicPage, siteJsonLd, SITE_NAME } from '@/lib/seo';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { FeedColumns } from '@/components/shell/feed-columns';
import { ExploreRail, ExploreView } from '@/components/discover/explore-view';
import { Icon } from '@/components/ui/icons';
import { JsonLd } from '@/components/site/json-ld';
import { feedTabOf, FEED_TABS, type FeedTab } from '@/lib/domain/post';
import { listFeed, unansweredCount } from '@/lib/services/posts';
import { HomeComposer } from '@/components/posts/composer';
import { PostFeed } from '@/components/posts/post-feed';

/** 首页 shows this many Rees until there are posts; 发现 has them all. */
const HOME_REES = 6;

/** The site's front page keeps its title, description and canonical `/` (and the site's structured data); the rest of the old home is `/about`. */
export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await serverMessages();
  return publicPage({ path: '/', title: `${t.site.home.title} · ${SITE_NAME}`, absoluteTitle: true, description: t.site.seo.description, locale });
}

/**
 * `/` -- 首页 (docs/design/discover-posts.html, v5): the feed in the
 * three-column frame. Signed in, it opens straight on the feed; a visitor
 * first sees a short introduction -- the old home page's headline, two
 * lines, sign-in, create a Ree, and the way to 了解 RE0 (`/about`, the rest
 * of the old home). The feed is public posts under three tabs (为你推荐 /
 * 最新 / 待回答, `?tab=`), rendered on the server so the page carries
 * indexable questions and answers. While there are no posts at all yet, a
 * short list of the most active public Rees stands in with the way to 发现,
 * which alone has the whole list. A visitor's h1 is the introduction's
 * headline, as on the old home.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [user, { t, locale }, params] = await Promise.all([currentUser(), serverMessages(), searchParams]);
  const tab: FeedTab = feedTabOf(params.tab);
  const query = parseExploreQuery({});
  const [feed, waiting, top, welcome] = await Promise.all([
    listFeed(tab, { viewerId: user?.id }),
    unansweredCount(),
    weeklyMostAsked(),
    user ? null : welcomeCredits(),
  ]);
  /* 为你推荐 with nothing answered yet reads as 最新; no posts at all, a few Rees. */
  const shown = tab === 'for_you' && feed.items.length === 0 ? await listFeed('latest', { viewerId: user?.id }) : feed;
  const showRees = tab !== 'unanswered' && shown.items.length === 0;
  const result = showRees ? await explore(query, { cursor: null, size: EXPLORE_BATCH_SIZES[0] }, { includeIntros: false }) : null;
  const rees = result?.items.slice(0, HOME_REES) ?? [];
  const [favoriteIds, coverVideos] = result
    ? await Promise.all([
        user ? favoriteReeIds(user.id, rees.map((ree) => ree.id)) : undefined,
        introsFor(rees.filter((ree) => !ree.coverBlob).map((ree) => ree.id)),
      ])
    : [undefined, new Map()];
  const h = t.site.home;
  const v = t.site.visitor;
  const ph = t.posts.home;
  const now = Date.now();
  const tabs = (
    <div className="cl-tabs" role="tablist" aria-label={t.posts.tabs.label}>
      {FEED_TABS.map((key) => (
        <Link key={key} href={key === 'for_you' ? '/' : `/?tab=${key}`} role="tab" aria-selected={tab === key} className={`cl-tab${tab === key ? ' active' : ''}`} scroll={false}>
          {t.posts.tabs[key]}
          {key === 'unanswered' && waiting > 0 && <span>{formatNumber(waiting, locale)}</span>}
        </Link>
      ))}
    </div>
  );
  const unansweredCard = waiting > 0 && (
    <section className="rail-card">
      <h3>{ph.unansweredCard}</h3>
      <p className="text-[12px] text-muted">{fill(ph.unansweredBody, { n: formatNumber(waiting, locale) })}</p>
      <Link href="/?tab=unanswered" className="text-link mt-2 inline-flex text-[12px]">
        {ph.unansweredGo} →
      </Link>
    </section>
  );
  return (
    <>
      <JsonLd data={siteJsonLd(t.site.seo.description)} />
      <FeedColumns title={t.common.nav.homeFeed} heading={Boolean(user)} tabs={tabs} rail={<ExploreRail rail={{ top }} signedIn={Boolean(user)} from="/" extra={unansweredCard || null} />}>
        {!user && (
          <div className="px-[18px]">
            <section className="xintro" aria-labelledby="home-intro">
              <h1 id="home-intro">
                {h.headline1}
                {h.headline2}
                <em>{h.headlineEm}</em>
              </h1>
              <p>
                {v.introLede1}
                <br />
                {v.introLede2}
              </p>
              <div className="xintro-actions">
                <Link href="/login" className="btn btn-sm">
                  {v.introAsk}
                </Link>
                <Link href={`/login?returnTo=${encodeURIComponent('/rees/new')}`} className="btn-secondary btn-sm">
                  <Icon name="plus" className="size-4" />
                  {t.site.nav.create}
                </Link>
                <Link href="/about" className="text-link">
                  {t.common.nav.about}
                  <Icon name="arrow" className="size-3.5" />
                </Link>
              </div>
              <small>
                {welcome && welcome.credits > 0 ? `${fill(h.trialCredits, { welcomeCredits: formatNumber(welcome.credits, locale) })} · ` : ''}
                {v.introMore}
              </small>
            </section>
          </div>
        )}
        <HomeComposer signedIn={Boolean(user)} />
        <PostFeed
          key={tab}
          tab={shown === feed ? tab : 'latest'}
          initial={shown}
          now={now}
          signedIn={Boolean(user)}
          empty={tab === 'unanswered' ? <p className="px-[18px] py-10 text-center text-[13px] text-muted">{ph.emptyUnanswered}</p> : null}
        />
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

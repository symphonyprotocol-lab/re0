import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { EXPLORE_BATCH_SIZES } from '@/lib/constants';
import { parseExploreQuery } from '@/lib/domain/explore';
import { currentUser } from '@/lib/http/session';
import { currentAnonymousChatLimits } from '@/lib/services/anonymous-chat-settings';
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
 * of the old home). Until people can post, the feed is the most active
 * public Rees, the same list as 发现.
 */
export default async function HomePage() {
  const [user, { t, locale }] = await Promise.all([currentUser(), serverMessages()]);
  const query = parseExploreQuery({});
  const [result, top, limits, welcome] = await Promise.all([
    explore(query, { cursor: null, size: EXPLORE_BATCH_SIZES[0] }, { includeIntros: false }),
    weeklyMostAsked(),
    user ? null : currentAnonymousChatLimits(),
    user ? null : welcomeCredits(),
  ]);
  const [favoriteIds, coverVideos] = await Promise.all([
    user ? favoriteReeIds(user.id, result.items.map((ree) => ree.id)) : undefined,
    introsFor(result.items.filter((ree) => !ree.coverBlob).map((ree) => ree.id)),
  ]);
  const items = result.items.map((ree) => ({ ...ree, video: coverVideos.get(ree.id) ?? null }));
  const h = t.site.home;
  const v = t.site.visitor;
  return (
    <>
      <JsonLd data={siteJsonLd(t.site.seo.description)} />
      <FeedColumns title={t.common.nav.homeFeed} rail={<ExploreRail rail={{ top, freeRounds: limits?.visitorRoundsPerDay ?? null }} signedIn={Boolean(user)} from="/" />}>
        {!user && (
          <div className="px-[18px]">
            <section className="xintro" aria-labelledby="home-intro">
              <h2 id="home-intro">
                {h.headline1}
                {h.headline2}
                <em>{h.headlineEm}</em>
              </h2>
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
        <ExploreView query={query} result={{ ...result, items }} limited={false} signedIn={Boolean(user)} favoriteIds={favoriteIds} viewerId={user?.id} renderedAt={Date.now()} variant="home" />
      </FeedColumns>
    </>
  );
}

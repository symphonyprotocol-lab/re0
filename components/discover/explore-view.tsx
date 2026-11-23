'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useCallback, useEffect, useRef, useState, useTransition, type MouseEvent } from 'react';
import { EXPLORE_RESULTS, REE_CATEGORIES, ROUNDTABLE_REES, SYNTHESIS_ENABLED, SYNTHESIS_MIN_ANSWERS } from '@/lib/constants';
import { explorePath, type ExploreQuery, type ExploreSort } from '@/lib/domain/explore';
import type { ExploreResult, ReeCard } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { FeedRee } from '@/components/discover/feed-ree';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { RoundtableEntry } from '@/components/discover/roundtable-entry';
import { rememberExploreReturn, takePublicReturn } from '@/components/discover/public-visit';
import { explorePageCount, explorePagePath } from '@/components/discover/explore-pages';
import { useLoadOnScroll } from '@/components/ui/use-load-on-scroll';
import '@/components/site/site.css';
import '@/components/discover/explore.css';

interface Loaded {
  items: ReeCard[];
  nextCursor: string | null;
  favorites: string[];
}

/**
 * The list as it was when a card was opened, so coming back from that
 * public page shows the same batches at the same place instead of only the
 * first one (module state: it lives as long as the tab's client app).
 */
let kept: (Loaded & { path: string; scrollY: number }) | null = null;

/**
 * `/explore`'s body (prototype discovery.js `page`); the search, category
 * and sort are a URL, so results can be shared and restored, and the list
 * loads more as it scrolls. Styled by explore.css with the prototype's
 * class names.
 */
/** A Ree in the right column's 我收藏的 Ree card (ree-favorites.ts listFavoriteRees). */
export interface RailRee {
  id: string;
  slug: string;
  name: string;
  avatarBlob: string | null;
  color: string;
  ownerName: string;
}

export function ExploreView({ query, result, limited, signedIn, favoriteIds, viewerId, renderedAt, page = 1, intro, variant = 'explore' }: {
  query: ExploreQuery;
  result: ExploreResult;
  /** Which numbered page (`?page=`, explore-pages.ts) the server's batch is; the list scrolls on from it. */
  page?: number;
  /** `/explore`'s h1 and the line under it (the sticky head only names the section). */
  intro?: { title: string; body: string };
  limited: boolean;
  signedIn: boolean;
  favoriteIds?: string[];
  viewerId?: string;
  renderedAt: number;
  /** `home`: 首页's list of Rees under its introduction -- no search, categories or result line. */
  variant?: 'explore' | 'home';
}) {
  const { t, locale } = useI18n();
  const e = t.discover.explore;
  const router = useRouter();
  const [q, setQ] = useState(query.q);
  /* The box follows the URL (back, forward, a new search) unless the viewer has typed since the last search went out. */
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) setQ(query.q);
  }, [query.q]);
  const n = (value: number) => formatNumber(value, locale);
  const current = explorePagePath(query, page);
  /*
   * A new list (search, category, sort) is a navigation; while it runs the
   * old list stays, marked busy, and the Search button spins. A later one
   * replaces an earlier one still in flight (the router drops the earlier
   * reply), so a slow answer never lands over a newer search.
   */
  const [pending, startList] = useTransition();
  const [pendingQ, setPendingQ] = useState('');
  const go = (changes: Partial<ExploreQuery>) => {
    const next = { ...query, ...changes };
    typed.current = false;
    setPendingQ(next.q);
    startList(() => router.push(explorePath(query, changes), { scroll: false }));
  };
  const searching = pending && Boolean(pendingQ);
  const toolbar = useRef<HTMLElement>(null);
  const resultsHead = useRef<HTMLDivElement>(null);

  /* The list grows past the server's first batch; a new search, category or sort (a new `result`) starts it again. */
  const initial = useCallback((): Loaded => ({ items: result.items, nextCursor: result.nextCursor, favorites: favoriteIds ?? [] }), [result, favoriteIds]);
  const [loaded, setLoaded] = useState<Loaded>(initial);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const shownResult = useRef(result);
  const inFlight = useRef<string | null>(null);
  useEffect(() => {
    if (shownResult.current === result) return;
    shownResult.current = result;
    setLoaded(initial());
    inFlight.current = null;
    setLoading(false);
    setFailed(false);
  }, [result, initial]);

  /* The results head just under the sticky toolbar (prototype discovery.js `scrollToResults`). */
  const scrollToResults = useCallback(() => {
    const bar = toolbar.current;
    const head = resultsHead.current;
    if (!bar || !head) return;
    const stickyTop = Number.parseFloat(getComputedStyle(bar).top) || 0;
    const top = window.scrollY + head.getBoundingClientRect().top - bar.getBoundingClientRect().height - stickyTop;
    window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  }, []);

  /* Coming back from a public page: the batches loaded then, at the same place; otherwise the results head. */
  useEffect(() => {
    if (!takePublicReturn(current)) return;
    const back = kept;
    if (!back || back.path !== current) {
      requestAnimationFrame(scrollToResults);
      return;
    }
    /* The first batch and its favourites as the server has them now (one may have been saved on that page), the later batches as they were. */
    if (back.items.length > result.items.length) {
      const fresh = new Set(result.items.map((ree) => ree.id));
      setLoaded({
        items: [...result.items, ...back.items.filter((ree) => !fresh.has(ree.id))],
        nextCursor: back.nextCursor,
        favorites: [...(favoriteIds ?? []), ...back.favorites.filter((id) => !fresh.has(id))],
      });
    }
    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo({ top: back.scrollY, behavior: 'instant' })));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  /* An old link's `size` no longer applies: show the page's own URL. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('size')) router.replace(current, { scroll: false });
  }, [current, router]);

  /* The toolbar sticks under the site header, whose height changes with the width (prototype discovery.js `afterRender`). */
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const header = document.querySelector('.marketing-header');
    const element = root.current;
    if (!header || !element) return;
    const measure = () => element.style.setProperty('--site-header', `${header.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  /* The next batch, after the last card's key; a reply for a list the viewer has since left is dropped. */
  const listQuery = limited ? { ...query, q: '' } : query;
  const listPath = explorePath(listQuery);
  const loadMore = useCallback(async () => {
    const cursor = loaded.nextCursor;
    if (!cursor || inFlight.current === cursor) return;
    inFlight.current = cursor;
    setLoading(true);
    setFailed(false);
    const from = shownResult.current;
    try {
      const params = new URLSearchParams(listPath.split('?')[1] ?? '');
      params.set('cursor', cursor);
      const response = await fetch(`/api/explore?${params}`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(String(response.status));
      const next = (await response.json()) as ExploreResult & { favoriteIds?: string[] };
      if (shownResult.current !== from) return;
      setLoaded((before) => {
        if (before.nextCursor !== cursor) return before;
        const seen = new Set(before.items.map((ree) => ree.id));
        return {
          items: [...before.items, ...next.items.filter((ree) => !seen.has(ree.id))],
          nextCursor: next.nextCursor,
          favorites: [...before.favorites, ...(next.favoriteIds ?? [])],
        };
      });
    } catch {
      if (shownResult.current === from) setFailed(true);
    } finally {
      inFlight.current = null;
      if (shownResult.current === from) setLoading(false);
    }
  }, [listPath, loaded.nextCursor]);

  /* The footer under the grid asks for the next batch as it nears the viewport (use-load-on-scroll.ts). */
  const { sentinel, observing } = useLoadOnScroll<HTMLDivElement>(loadMore, Boolean(loaded.nextCursor) && !loading && !failed);

  /* Remember the list as a card is opened, and that the Ree's page goes back here (outside its URL: public-visit.tsx). */
  const keep = (event: MouseEvent) => {
    kept = { path: current, ...loaded, scrollY: window.scrollY };
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const slug = link?.getAttribute('href')?.match(/\/r\/([^/?#]+)/)?.[1];
    if (slug) rememberExploreReturn(slug, current);
  };
  /* A plain click on a category link is a list change like the others (busy list, spinner); the link itself is there for crawlers and new tabs. */
  const follow = (event: MouseEvent, changes: Partial<ExploreQuery>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(changes);
  };
  /* Numbered pages for whoever does not scroll (a crawler): the server's batch is page `page`; once the list has grown past it they no longer match what is shown. */
  const pages = result.mode === 'browse' ? explorePageCount(result.total) : 1;
  const pager = variant === 'explore' && pages > 1 && loaded.items.length <= result.items.length ? (
    <nav className="discovery-pager" aria-label={e.pagesLabel}>
      {page > 1 && (
        <Link href={explorePagePath(query, page - 1)} rel="prev" className="text-link">
          ← {e.previousPage}
        </Link>
      )}
      <span>{fill(e.pageOf, { page: n(page), pages: n(pages) })}</span>
      {page < pages && (
        <Link href={explorePagePath(query, page + 1)} rel="next" className="text-link">
          {e.nextPage} →
        </Link>
      )}
    </nav>
  ) : null;

  const favorites = new Set(loaded.favorites);
  const banner = (
    <div className="knowledge-banner">
      <div>
        <h3>{e.banner}</h3>
        <p>{e.bannerBody}</p>
      </div>
      <Link rel={signedIn ? undefined : 'nofollow'} href={signedIn ? '/rees/new' : `/login?returnTo=${encodeURIComponent('/rees/new')}`} className="btn secondary">
        <Icon name="plus" />
        {e.create}
      </Link>
    </div>
  );
  const [resultsBefore, resultsAfter] = e.results.split('{n}');

  return (
    <div ref={root} className="discovery-page">
      {intro && (
        <header className="discovery-intro">
          <h1>{intro.title}</h1>
          <p>{intro.body}</p>
        </header>
      )}
      {variant === 'explore' && (
      <section ref={toolbar} className="discovery-toolbar" aria-label={e.label}>
        <div className="discovery-search-row">
          <form
            role="search"
            className="search-box"
            onSubmit={(event) => {
              event.preventDefault();
              go({ q: q.trim() });
            }}
          >
            <Icon name="search" />
            <input
              id="explore-input"
              name="q"
              value={q}
              maxLength={4000}
              autoComplete="off"
              aria-label={e.label}
              placeholder={e.placeholder}
              onChange={(event) => {
                typed.current = true;
                setQ(event.target.value);
              }}
            />
            {query.q && (
              <button type="button" className="icon-btn" aria-label={e.clear} onClick={() => go({ q: '' })}>
                <Icon name="close" />
              </button>
            )}
            {/* The label keeps its place (hidden, not removed) so the button does not change width while it spins. */}
            <button type="submit" className="btn discovery-submit" aria-busy={searching} disabled={searching && q.trim() === pendingQ}>
              <span className="discovery-submit-label">{e.submit}</span>
              {searching && <span className="discovery-spinner" aria-hidden="true" />}
            </button>
          </form>
          <label className="discovery-select">
            <span>{e.sort}</span>
            <select value={query.sort} aria-label={e.sort} onChange={(event) => go({ sort: event.target.value as ExploreSort })}>
              {(['active', 'answers', 'free'] as const).map((sort) => (
                <option key={sort} value={sort}>
                  {e.sorts[sort]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <nav className="filter-row" aria-label={e.categoriesLabel}>
          {[null, ...REE_CATEGORIES].map((category) => (
            <Link
              key={category ?? 'all'}
              href={explorePath({ category })}
              scroll={false}
              aria-current={query.category === category ? 'page' : undefined}
              onClick={(event) => follow(event, { category })}
              className={`filter${query.category === category ? ' active' : ''}`}
            >
              {category ? t.common.categories[category] : t.discover.allCategories}
            </Link>
          ))}
        </nav>
      </section>
      )}

      {limited && <p className="mt-4 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">{e.limited}</p>}

      {variant === 'explore' && (
      <div ref={resultsHead} className="discovery-results-head">
        <p role="status" aria-live="polite">
          {searching && (
            <span className="discovery-searching">
              <span className="discovery-spinner" aria-hidden="true" />
              {fill(e.searching, { q: pendingQ })}
            </span>
          )}
          {query.q && !limited && <strong>“{query.q}” · </strong>}
          {resultsBefore}
          <strong>{n(result.total)}</strong>
          {resultsAfter}
          {result.total > loaded.items.length && <span>{fill(e.shown, { n: n(loaded.items.length) })}</span>}
          <span className="discovery-results-note">{result.mode === 'search' ? fill(e.searchNote, { n: EXPLORE_RESULTS }) : e.browseNote}</span>
        </p>
      </div>
      )}

      {SYNTHESIS_ENABLED && result.mode === 'search' && result.items.length >= SYNTHESIS_MIN_ANSWERS && (
        <RoundtableEntry question={query.q} rees={result.items.slice(0, ROUNDTABLE_REES)} signedIn={signedIn} />
      )}

      {loaded.items.length > 0 ? (
          <div>
            <div id="explore-results" className="discovery-feed" data-stale={pending || undefined} aria-label={e.list} aria-busy={loading || pending} onClickCapture={keep}>
              {loaded.items.map((ree) => (
                <FeedRee
                  key={ree.id}
                  ree={ree}
                  from={current}
                  favorite={favorites.has(ree.id)}
                  viewerId={viewerId}
                  pinned={ree.pinned && result.mode === 'browse' && query.sort === 'active'}
                  now={renderedAt}
                />
              ))}
            </div>
            <div ref={sentinel} className="discovery-results-footer">
              {loaded.nextCursor ? (
                failed ? (
                  <p role="alert">
                    {e.loadFailed}
                    <button type="button" className="btn secondary" onClick={() => void loadMore()}>
                      {e.retry}
                    </button>
                  </p>
                ) : loading ? (
                  <p role="status">
                    <span className="discovery-spinner" aria-hidden="true" />
                    {e.loading}
                  </p>
                ) : (
                  !observing && (
                    <button type="button" className="btn secondary" onClick={() => void loadMore()}>
                      {e.loadMore}
                    </button>
                  )
                )
              ) : (
                result.mode === 'browse' && <p>{fill(e.end, { n: n(result.total) })}</p>
              )}
            </div>
            {pager}
            {/* Below 1100px the right column is hidden (columns.css); the banner stays at the end of the list. */}
            <div className="discovery-feed-banner">{banner}</div>
          </div>
      ) : (
        <>
          <div className="card empty" data-stale={pending || undefined} aria-busy={pending}>
            <Icon name="search" />
            <h2>{e.emptyTitle}</h2>
            <p>{e.emptyBody}</p>
            <button type="button" className="btn secondary" onClick={() => go({ q: '', category: null, sort: 'active' })}>
              {e.reset}
            </button>
          </div>
          {banner}
        </>
      )}
    </div>
  );
}

/**
 * 首页's and Rees' right column (v6): one search box where the page has none
 * of its own (首页 searches posts), the most active public Rees on 首页 (so
 * its HTML always links some Rees; GSC review 2026-11, A9), the signed-in
 * user's saved Rees on Rees,
 * the create-a-Ree card -- the one place a visitor is asked to create one --
 * and the small links. Below 1200px the column folds away; 首页 then shows
 * its search at the top of the centre column (RailSearch `inline`).
 */
export function SiteRail({ search, popular, saved, signedIn }: { search?: { action: string; label: string; defaultValue?: string }; popular?: RailRee[]; saved?: RailRee[]; signedIn: boolean }) {
  const { t } = useI18n();
  const e = t.discover.explore;
  return (
    <div className="discovery-page">
      {search && <RailSearch action={search.action} label={search.label} defaultValue={search.defaultValue} />}
      {popular && popular.length > 0 && (
        <section className="rail-card" aria-labelledby="rail-popular-heading">
          <h3 id="rail-popular-heading">{e.railPopular}</h3>
          <ol>
            {popular.map((ree) => (
              <li key={ree.id}>
                <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" />
                <Link href={`/r/${ree.slug}`} className="min-w-0 hover:text-blue">
                  <strong>{ree.name}</strong>
                  <small>{ree.ownerName}</small>
                </Link>
              </li>
            ))}
          </ol>
          <Link href="/explore" className="text-link mt-3 inline-flex text-[12px]">
            {t.site.visitor.allRees} →
          </Link>
        </section>
      )}
      {saved && saved.length > 0 && (
        <div className="rail-card">
          <h3>{e.railSaved}</h3>
          <ol>
            {saved.map((ree) => (
              <li key={ree.id}>
                <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" />
                <Link href={`/r/${ree.slug}`} className="min-w-0 hover:text-blue">
                  <strong>{ree.name}</strong>
                  <small>{ree.ownerName}</small>
                </Link>
              </li>
            ))}
          </ol>
          <Link href="/saved" className="text-link mt-3 inline-flex text-[12px]">
            {e.railSavedAll} →
          </Link>
        </div>
      )}
      <div className="knowledge-banner">
        <div>
          <h3>{e.banner}</h3>
          <p>{e.bannerBody}</p>
        </div>
        <Link rel={signedIn ? undefined : 'nofollow'} href={signedIn ? '/rees/new' : `/login?returnTo=${encodeURIComponent('/rees/new')}`} className="btn-secondary btn-sm">
          <Icon name="plus" className="size-4" />
          {e.create}
        </Link>
      </div>
      <p className="px-2 text-[11px] text-muted">
        <Link href="/pricing" className="hover:text-blue">{t.common.nav.pricing}</Link> · <Link href="/about" className="hover:text-blue">{t.common.nav.about}</Link> · <Link href="/legal/privacy" className="hover:text-blue">{t.site.visitor.privacy}</Link> · <Link href="/legal/terms" className="hover:text-blue">{t.site.visitor.terms}</Link>
      </p>
    </div>
  );
}

/** One single-line search box (38px, explore.css); `defaultValue` keeps the words of the search being shown. */
export function RailSearch({ action, label, defaultValue = '', className = 'search-box' }: { action: string; label: string; defaultValue?: string; className?: string }) {
  return (
    <form action={action} role="search" className={className} aria-label={label}>
      <Icon name="search" className="size-4" />
      <input name="q" defaultValue={defaultValue} placeholder={label} aria-label={label} className="min-w-0 flex-1 bg-transparent outline-none" />
    </form>
  );
}

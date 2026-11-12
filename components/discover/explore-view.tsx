'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { EXPLORE_RESULTS, REE_CATEGORIES, ROUNDTABLE_REES, SYNTHESIS_ENABLED, SYNTHESIS_MIN_ANSWERS } from '@/lib/constants';
import { explorePath, type ExploreQuery, type ExploreSort } from '@/lib/domain/explore';
import type { ExploreResult, ReeCard } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeCardView } from '@/components/discover/ree-card';
import { RoundtableEntry } from '@/components/discover/roundtable-entry';
import { takePublicReturn } from '@/components/discover/public-visit';
import '@/components/site/site.css';
import '@/components/discover/explore.css';

/** How far below the viewport the next batch starts loading. */
const PRELOAD_MARGIN = '800px 0px';

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
export function ExploreView({ query, result, limited, signedIn, favoriteIds, viewerId }: {
  query: ExploreQuery;
  result: ExploreResult;
  limited: boolean;
  signedIn: boolean;
  favoriteIds?: string[];
  viewerId?: string;
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
  const current = explorePath(query);
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

  /* An old link's `page` or `size` no longer applies: show the canonical URL. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('page') || params.has('size')) router.replace(current, { scroll: false });
  }, [current, router]);

  /* The toolbar sticks under the site header, whose height changes with the width (prototype discovery.js `afterRender`). */
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const header = document.querySelector('.marketing-header');
    const root = page.current;
    if (!header || !root) return;
    const measure = () => root.style.setProperty('--site-header', `${header.getBoundingClientRect().height}px`);
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

  /*
   * The sentinel under the grid asks for the next batch as it nears the
   * viewport. A fresh observer after every batch reports at once if the
   * sentinel is still in reach (a tall screen), so the list fills it.
   * Without IntersectionObserver, a "load more" button does the same.
   */
  const sentinel = useRef<HTMLDivElement>(null);
  const [observing, setObserving] = useState(true);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setObserving(false);
      return;
    }
    const target = sentinel.current;
    if (!target || !loaded.nextCursor || loading || failed) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: PRELOAD_MARGIN });
    observer.observe(target);
    return () => observer.disconnect();
  }, [loaded.nextCursor, loading, failed, loadMore]);

  /* Remember the list as a card is opened. */
  const keep = () => {
    kept = { path: current, ...loaded, scrollY: window.scrollY };
  };

  const favorites = new Set(loaded.favorites);
  const [resultsBefore, resultsAfter] = e.results.split('{n}');

  return (
    <div ref={page} className="discovery-page">
      <header className="discovery-page-head">
        <div>
          <p className="eyebrow">{e.eyebrow}</p>
          <h1>{e.title}</h1>
          <p>{e.body}</p>
        </div>
      </header>

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
        <div className="filter-row" role="group" aria-label={e.categoriesLabel}>
          {[null, ...REE_CATEGORIES].map((category) => (
            <button
              key={category ?? 'all'}
              type="button"
              aria-pressed={query.category === category}
              onClick={() => go({ category })}
              className={`filter${query.category === category ? ' active' : ''}`}
            >
              {category ? t.common.categories[category] : t.discover.allCategories}
            </button>
          ))}
        </div>
      </section>

      {limited && <p className="mt-4 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">{e.limited}</p>}

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

      {SYNTHESIS_ENABLED && result.mode === 'search' && result.items.length >= SYNTHESIS_MIN_ANSWERS && (
        <RoundtableEntry question={query.q} rees={result.items.slice(0, ROUNDTABLE_REES)} signedIn={signedIn} returnTo={current} />
      )}

      {loaded.items.length > 0 ? (
        <>
          <div id="explore-results" className="dot-grid" data-stale={pending || undefined} aria-label={e.list} aria-busy={loading || pending} onClickCapture={keep}>
            {loaded.items.map((ree) => (
              <ReeCardView
                key={ree.id}
                ree={ree}
                from={current}
                favorite={favorites.has(ree.id)}
                viewerId={viewerId}
                pinned={ree.pinned && result.mode === 'browse' && query.sort === 'active'}
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
        </>
      ) : (
        <div className="card empty" data-stale={pending || undefined} aria-busy={pending}>
          <Icon name="search" />
          <h2>{e.emptyTitle}</h2>
          <p>{e.emptyBody}</p>
          <button type="button" className="btn secondary" onClick={() => go({ q: '', category: null, sort: 'active' })}>
            {e.reset}
          </button>
        </div>
      )}

      <div className="knowledge-banner">
        <div>
          <h3>{e.banner}</h3>
          <p>{e.bannerBody}</p>
        </div>
        <Link href={signedIn ? '/rees/new' : `/login?returnTo=${encodeURIComponent('/rees/new')}`} className="btn secondary">
          <Icon name="plus" />
          {e.create}
        </Link>
      </div>
    </div>
  );
}

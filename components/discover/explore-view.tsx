'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { EXPLORE_PAGE_SIZES, EXPLORE_RESULTS, REE_CATEGORIES } from '@/lib/constants';
import { explorePath, type ExploreQuery, type ExploreSort } from '@/lib/domain/explore';
import type { ExploreResult } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeCardView } from '@/components/discover/ree-card';
import { takePublicReturn } from '@/components/discover/public-visit';
import '@/components/site/site.css';
import '@/components/discover/explore.css';

/** Page numbers around the current one, gaps as null (prototype `discoveryPageNumbers`). */
function pageNumbers(page: number, pages: number): (number | null)[] {
  const values = [...new Set([1, page - 1, page, page + 1, pages])].filter((value) => value > 0 && value <= pages).sort((a, b) => a - b);
  return values.flatMap((value, index) => (index && value - values[index - 1]! > 1 ? [null, value] : [value]));
}

/**
 * `/explore`'s body (prototype discovery.js `page`); every control is a URL,
 * so results can be shared and restored. Styled by explore.css with the
 * prototype's class names.
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
  const [jump, setJump] = useState(String(result.page));
  useEffect(() => setQ(query.q), [query.q]);
  useEffect(() => setJump(String(result.page)), [result.page]);
  const n = (value: number) => formatNumber(value, locale);
  const pages = Math.max(1, Math.ceil(result.total / result.size));
  const current = explorePath({ ...query, page: result.page });
  const favorites = favoriteIds && new Set(favoriteIds);
  const from = result.total ? (result.page - 1) * result.size + 1 : 0;
  const to = Math.min(result.page * result.size, result.total);
  const go = (changes: Partial<ExploreQuery>) => router.push(explorePath(query, changes), { scroll: false });
  const toolbar = useRef<HTMLElement>(null);
  const resultsHead = useRef<HTMLDivElement>(null);

  /* The results head just under the sticky toolbar (prototype discovery.js `scrollToResults`). */
  const scrollToResults = useCallback(() => {
    const bar = toolbar.current;
    const head = resultsHead.current;
    if (!bar || !head) return;
    const stickyTop = Number.parseFloat(getComputedStyle(bar).top) || 0;
    const top = window.scrollY + head.getBoundingClientRect().top - bar.getBoundingClientRect().height - stickyTop;
    window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  }, []);

  /* On load past page 1, or coming back from a public page. */
  useEffect(() => {
    const back = takePublicReturn(current);
    if (result.page > 1 || back) requestAnimationFrame(scrollToResults);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, []);

  /* After the pager or the page jump moved to another page of the same results. */
  const shown = useRef({ list: explorePath({ ...query, page: 1 }), page: result.page });
  useEffect(() => {
    const list = explorePath({ ...query, page: 1 });
    const before = shown.current;
    shown.current = { list, page: result.page };
    if (before.list === list && before.page !== result.page) requestAnimationFrame(scrollToResults);
  }, [query, result.page, scrollToResults]);

  /* A `page` past the end (or before the start) was clamped by the server: show the canonical URL. */
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('page');
    if (raw !== null && Number(raw) !== result.page) router.replace(current, { scroll: false });
  }, [current, result.page, router]);

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

  const [resultsBefore, resultsAfter] = e.results.split('{n}');

  const pager = (compact: boolean) =>
    pages > 1 && (
      <nav aria-label={compact ? e.topPagination : e.pagination} className={`discovery-pagination${compact ? ' is-compact' : ''}`}>
        <PageLink page={result.page - 1} pages={pages} query={query} label={e.previous}>
          <Icon name="chevronRight" />
        </PageLink>
        {compact ? (
          <span className="mono">
            {result.page} / {pages}
          </span>
        ) : (
          pageNumbers(result.page, pages).map((value, index) =>
            value === null ? (
              <span key={`gap-${index}`} className="pagination-ellipsis">
                …
              </span>
            ) : value === result.page ? (
              <span key={value} aria-current="page" className="is-current">
                {value}
              </span>
            ) : (
              <PageLink key={value} page={value} pages={pages} query={query} label={fill(e.page, { n: value })}>
                {value}
              </PageLink>
            ),
          )
        )}
        <PageLink page={result.page + 1} pages={pages} query={query} label={e.next}>
          <Icon name="chevronRight" />
        </PageLink>
        {!compact && (
          <form
            id="discovery-page-jump"
            onSubmit={(event) => {
              event.preventDefault();
              go({ page: Math.min(pages, Math.max(1, Math.floor(Number(jump)) || 1)) });
            }}
          >
            <label htmlFor="explore-page">{e.jump}</label>
            <input
              id="explore-page"
              name="page"
              type="number"
              min={1}
              max={pages}
              required
              aria-label={e.jumpLabel}
              value={jump}
              onChange={(event) => setJump(event.target.value)}
            />
            {e.jumpSuffix && <span>{e.jumpSuffix}</span>}
            <button type="submit">{e.go}</button>
          </form>
        )}
      </nav>
    );

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
              onChange={(event) => setQ(event.target.value)}
            />
            {query.q && (
              <button type="button" className="icon-btn" aria-label={e.clear} onClick={() => go({ q: '' })}>
                <Icon name="close" />
              </button>
            )}
            <button type="submit" className="btn">
              {e.submit}
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
          <label className="discovery-select">
            <span>{e.perPage}</span>
            <select value={result.size} aria-label={e.perPage} onChange={(event) => go({ size: Number(event.target.value) })}>
              {EXPLORE_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {fill(e.perPageOption, { n: size })}
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
          {query.q && !limited && <strong>“{query.q}” · </strong>}
          {resultsBefore}
          <strong>{n(result.total)}</strong>
          {resultsAfter}
          {result.total > 0 && <span>{fill(e.showing, { from: n(from), to: n(to) })}</span>}
          <span className="discovery-results-note">{result.mode === 'search' ? fill(e.searchNote, { n: EXPLORE_RESULTS }) : e.browseNote}</span>
        </p>
        {pager(true)}
      </div>

      {result.items.length > 0 ? (
        <div id="explore-results" className="dot-grid" aria-label={e.list}>
          {result.items.map((ree) => (
            <ReeCardView key={ree.id} ree={ree} from={current} favorite={favorites?.has(ree.id)} viewerId={viewerId} />
          ))}
        </div>
      ) : (
        <div className="card empty">
          <Icon name="search" />
          <h2>{e.emptyTitle}</h2>
          <p>{e.emptyBody}</p>
          <button type="button" className="btn secondary" onClick={() => go({ q: '', category: null, sort: 'active' })}>
            {e.reset}
          </button>
        </div>
      )}

      {result.total > 0 && (
        <div className="discovery-results-footer">
          <span>{fill(e.pageOf, { page: result.page, pages })}</span>
          {pager(false)}
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

function PageLink({ page, pages, query, label, children }: { page: number; pages: number; query: ExploreQuery; label: string; children: ReactNode }) {
  if (page < 1 || page > pages)
    return (
      <span aria-disabled="true" className="is-disabled">
        {children}
      </span>
    );
  return (
    <Link href={explorePath(query, { page })} scroll={false} aria-label={label}>
      {children}
    </Link>
  );
}

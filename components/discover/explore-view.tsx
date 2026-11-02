'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { EXPLORE_PAGE_SIZES, EXPLORE_RESULTS, REE_CATEGORIES } from '@/lib/constants';
import { explorePath, type ExploreQuery, type ExploreSort } from '@/lib/domain/explore';
import type { ExploreResult } from '@/lib/services/explore';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ReeCardView } from '@/components/discover/ree-card';
import { takePublicReturn } from '@/components/discover/public-visit';

/** Page numbers around the current one, gaps as null (prototype `discoveryPageNumbers`). */
function pageNumbers(page: number, pages: number): (number | null)[] {
  const values = [...new Set([1, page - 1, page, page + 1, pages])].filter((value) => value > 0 && value <= pages).sort((a, b) => a - b);
  return values.flatMap((value, index) => (index && value - values[index - 1]! > 1 ? [null, value] : [value]));
}

/** `/explore`'s body (prototype discovery.js `page`); every control is a URL, so results can be shared and restored. */
export function ExploreView({ query, result, limited, signedIn }: { query: ExploreQuery; result: ExploreResult; limited: boolean; signedIn: boolean }) {
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

  const pager = (compact: boolean) =>
    pages > 1 && (
      <nav aria-label={compact ? e.topPagination : e.pagination} className="flex flex-wrap items-center gap-1 text-[12px]">
        <PageLink page={result.page - 1} pages={pages} query={query} label={e.previous}>
          <Icon name="chevronLeft" className="size-3.5" />
        </PageLink>
        {compact ? (
          <span className="px-2 font-mono">
            {result.page} / {pages}
          </span>
        ) : (
          pageNumbers(result.page, pages).map((value, index) =>
            value === null ? (
              <span key={`gap-${index}`} className="px-1 text-muted">
                …
              </span>
            ) : value === result.page ? (
              <span key={value} aria-current="page" className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg bg-ink px-2 font-mono text-white">
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
          <Icon name="chevronRight" className="size-3.5" />
        </PageLink>
        {!compact && (
          <form
            className="ml-2 flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              go({ page: Math.min(pages, Math.max(1, Math.floor(Number(jump)) || 1)) });
            }}
          >
            <label htmlFor="explore-page" className="text-muted">
              {e.jump}
            </label>
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
              className="h-8 w-14 rounded-lg border border-line px-2 font-mono"
            />
            {e.jumpSuffix && <span className="text-muted">{e.jumpSuffix}</span>}
            <button type="submit" className="btn-secondary btn-sm">
              {e.go}
            </button>
          </form>
        )}
      </nav>
    );

  return (
    <main className={`mx-auto w-full max-w-[1200px] px-4 pb-16 sm:px-6 ${signedIn ? 'pt-6 md:px-8' : 'pt-10'}`}>
      <header>
        <span className="eyebrow">{e.eyebrow}</span>
        <h1 className="mt-2 text-[28px] font-extrabold tracking-tight sm:text-[34px]">{e.title}</h1>
        <p className="mt-1 text-[13px] text-muted">{e.body}</p>
      </header>

      <section ref={toolbar} className={`sticky z-10 -mx-4 mt-6 border-b border-line bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 ${signedIn ? 'top-16 md:-mx-8 md:px-8' : 'top-[108px] md:top-16'}`} aria-label={e.label}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <form
            role="search"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-line bg-white px-3 focus-within:border-blue"
            onSubmit={(event) => {
              event.preventDefault();
              go({ q: q.trim() });
            }}
          >
            <Icon name="search" className="size-4 flex-none text-muted" />
            <input
              id="explore-input"
              name="q"
              value={q}
              maxLength={4000}
              autoComplete="off"
              aria-label={e.label}
              placeholder={e.placeholder}
              className="h-11 min-w-0 flex-1 bg-transparent text-[14px] outline-none"
              onChange={(event) => setQ(event.target.value)}
            />
            {query.q && (
              <button type="button" className="icon-btn" aria-label={e.clear} onClick={() => go({ q: '' })}>
                <Icon name="close" />
              </button>
            )}
            <button type="submit" className="btn btn-sm">
              {e.submit}
            </button>
          </form>
          <div className="flex gap-2">
            <label className="flex flex-1 items-center gap-2 text-[11px] text-muted lg:flex-none">
              {e.sort}
              <select className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-white px-2 text-[12px] text-ink" value={query.sort} aria-label={e.sort} onChange={(event) => go({ sort: event.target.value as ExploreSort })}>
                {(['active', 'answers', 'free'] as const).map((sort) => (
                  <option key={sort} value={sort}>
                    {e.sorts[sort]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 items-center gap-2 text-[11px] text-muted lg:flex-none">
              {e.perPage}
              <select className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-white px-2 text-[12px] text-ink" value={result.size} aria-label={e.perPage} onChange={(event) => go({ size: Number(event.target.value) })}>
                {EXPLORE_PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {fill(e.perPageOption, { n: size })}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]" role="group" aria-label={e.categoriesLabel}>
          {[null, ...REE_CATEGORIES].map((category) => (
            <button
              key={category ?? 'all'}
              type="button"
              aria-pressed={query.category === category}
              onClick={() => go({ category })}
              className={`h-8 flex-none rounded-full border px-3 text-[12px] ${query.category === category ? 'border-ink bg-ink text-white' : 'border-line bg-white text-[#3b4361] hover:border-blue hover:text-blue'}`}
            >
              {category ? t.common.categories[category] : t.discover.allCategories}
            </button>
          ))}
        </div>
      </section>

      {limited && <p className="mt-4 rounded-lg border border-[#f1d4d4] bg-[#fff3f3] px-3 py-2 text-[12px] text-red">{e.limited}</p>}

      <div ref={resultsHead} className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-[12px] text-muted">
          {query.q && !limited && <strong className="text-ink">“{query.q}” · </strong>}
          {fill(e.results, { n: n(result.total) })}
          {result.total > 0 && fill(e.showing, { from: n(from), to: n(to) })}
          <span className="ml-2 hidden text-[#a3a9bb] md:inline">{result.mode === 'search' ? fill(e.searchNote, { n: EXPLORE_RESULTS }) : e.browseNote}</span>
        </p>
        {pager(true)}
      </div>

      {result.items.length > 0 ? (
        <div id="explore-results" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {result.items.map((ree) => (
            <ReeCardView key={ree.id} ree={ree} from={current} />
          ))}
        </div>
      ) : (
        <div className="card mt-4 flex flex-col items-center px-6 py-14 text-center">
          <Icon name="search" className="size-7 text-[#a3a9bb]" />
          <h2 className="mt-4 text-[16px] font-bold">{e.emptyTitle}</h2>
          <p className="mt-1 text-[12px] text-muted">{e.emptyBody}</p>
          <button type="button" className="btn-secondary mt-5" onClick={() => go({ q: '', category: null, sort: 'active' })}>
            {e.reset}
          </button>
        </div>
      )}

      {result.total > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-[12px] text-muted">
          <span>{fill(e.pageOf, { page: result.page, pages })}</span>
          {pager(false)}
        </div>
      )}

      <div className="card mt-10 flex flex-col items-start justify-between gap-4 bg-gradient-to-r from-soft to-white p-6 sm:flex-row sm:items-center">
        <div>
          <h3 className="text-[16px] font-bold">{e.banner}</h3>
          <p className="mt-1 text-[12px] text-muted">{e.bannerBody}</p>
        </div>
        <Link href={signedIn ? '/rees/new' : `/login?returnTo=${encodeURIComponent('/rees/new')}`} className="btn-secondary">
          <Icon name="plus" />
          {e.create}
        </Link>
      </div>
    </main>
  );
}

function PageLink({ page, pages, query, label, children }: { page: number; pages: number; query: ExploreQuery; label: string; children: ReactNode }) {
  if (page < 1 || page > pages)
    return (
      <span aria-disabled="true" className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-[#c4cce0]">
        {children}
      </span>
    );
  return (
    <Link href={explorePath(query, { page })} scroll={false} aria-label={label} className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg border border-line bg-white px-2 font-mono hover:border-blue hover:text-blue">
      {children}
    </Link>
  );
}

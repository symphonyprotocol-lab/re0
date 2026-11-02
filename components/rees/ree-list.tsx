'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react';
import { REE_PAGE_SIZES } from '@/lib/constants';
import { pageNumbers, type ListResult } from '@/lib/domain/list';
import { REE_BATCH_MAX, visibilityPlan, type VisibilityPlan, type VisibilityRow } from '@/lib/domain/ree';
import type { ReeListItem, ReeSelectionItem, ReeSort, ReeVisibility } from '@/lib/services/rees';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ConfirmModal } from '@/components/ui/modal';
import { ReeAvatar } from '@/components/ui/ree-avatar';
import { useToast } from '@/components/ui/toast';
import { PlayIntroButton, VideoPlaceholder, VideoPoster } from '@/components/video/video-cover';
import type { IntroProps } from '@/lib/domain/video';

interface Query {
  q: string;
  visibility: ReeVisibility;
  sort: ReeSort;
  size: number;
  page: number;
  view: 'cards' | 'list';
}

const SORT_PARAMS: Record<ReeSort, { sort?: string; order?: string }> = {
  default: {},
  name_asc: { sort: 'name', order: 'asc' },
  name_desc: { sort: 'name', order: 'desc' },
  sources_desc: { sort: 'sources', order: 'desc' },
  sources_asc: { sort: 'sources', order: 'asc' },
  answers_desc: { sort: 'answers', order: 'desc' },
  answers_asc: { sort: 'answers', order: 'asc' },
};

type SortKey = 'name' | 'sources' | 'answers';
type Selected = Map<string, { name: string; isPublic: boolean; moderated: boolean }>;

/** A Ree's state for the owner: taken down wins over its public flag (prototype owned-rees.js `list`). */
function stateOf(ree: { isPublic: boolean; moderatedAt: Date | string | null }): 'public' | 'private' | 'moderated' {
  return ree.moderatedAt ? 'moderated' : ree.isPublic ? 'public' : 'private';
}

const STATE_ICONS = { public: 'globe', private: 'lock', moderated: 'shield' } as const;

/**
 * `/rees`: the server filters, sorts and pages; this only writes the choice
 * into the URL (so refresh and back/forward restore it). Changing a filter,
 * the sort or the page size goes back to page 1; an out-of-range page is
 * pulled back by the server and the URL follows it.
 *
 * The list view adds the prototype's multi-select (owned-rees.js, README
 * "我的 Ree 的多选与批量公开 / 私有"): the selection survives paging, sorting
 * and the page size, and is cleared when the search, the visibility filter
 * or the view changes, so nothing hidden is changed by mistake.
 */
export function ReeList({
  result,
  totals,
  query,
  videos = {},
}: {
  result: ListResult<ReeListItem>;
  totals: { rees: number; public: number; private: number; sources: number; answers: number };
  query: Query;
  /** Step 7: introductions by Ree id; a Ree with one gets its opening still and a play button. */
  videos?: Record<string, IntroProps>;
}) {
  const { t, locale } = useI18n();
  const r = t.rees;
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [q, setQ] = useState(query.q);
  const [jump, setJump] = useState(String(result.page));
  const [selected, setSelected] = useState<Selected>(() => new Map());
  const [review, setReview] = useState<{ isPublic: boolean; plan: VisibilityPlan } | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  useEffect(() => setQ(query.q), [query.q]);
  useEffect(() => setJump(String(result.page)), [result.page]);
  const n = (value: number) => formatNumber(value, locale);

  const hrefFor = (changes: Partial<Query>) => {
    const next = { ...query, ...changes };
    const params = new URLSearchParams();
    if (next.q) params.set('q', next.q);
    if (next.visibility !== 'all') params.set('visibility', next.visibility);
    const sort = SORT_PARAMS[next.sort];
    if (sort.sort) params.set('sort', sort.sort);
    if (sort.order) params.set('order', sort.order);
    if (next.view === 'list') params.set('view', 'list');
    if (next.size !== REE_PAGE_SIZES[0]) params.set('size', String(next.size));
    if (next.page > 1) params.set('page', String(next.page));
    const search = params.toString();
    return search ? `${pathname}?${search}` : pathname;
  };
  const go = (changes: Partial<Query>) => start(() => router.push(hrefFor(changes), { scroll: false }));

  /* An out-of-range page: the server showed the last one, the address follows it (prototype `afterRender`). */
  const shownHref = hrefFor({ page: result.page });
  useEffect(() => {
    if (query.page !== result.page) router.replace(shownHref, { scroll: false });
  }, [query.page, result.page, shownHref, router]);

  /* A new search, filter or view starts a new selection; leaving the list view drops it. */
  const scope = JSON.stringify([query.view, query.q, query.visibility]);
  const scopeRef = useRef(scope);
  useEffect(() => {
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    setSelected(new Map());
  }, [scope]);

  const pages = Math.max(1, Math.ceil(result.total / result.size));
  const from = result.total ? (result.page - 1) * result.size + 1 : 0;
  const to = Math.min(result.page * result.size, result.total);
  const list = query.view === 'list';

  /* ------------------------------------------------------------ selection */

  const rows: VisibilityRow[] = [...selected].map(([id, ree]) => ({ id, isPublic: ree.isPublic, moderated: ree.moderated }));
  const publicPlan = visibilityPlan(rows, selected.keys(), true);
  const privatePlan = visibilityPlan(rows, selected.keys(), false);
  const pageSelected = result.items.filter((ree) => selected.has(ree.id)).length;
  const allOnPage = result.items.length > 0 && pageSelected === result.items.length;
  const someOnPage = pageSelected > 0 && !allOnPage;
  const otherPages = selected.size - pageSelected;

  const toggleRow = (ree: ReeListItem, checked: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(ree.id, { name: ree.name, isPublic: ree.isPublic, moderated: Boolean(ree.moderatedAt) });
      else next.delete(ree.id);
      return next;
    });
  const togglePage = (checked: boolean) =>
    setSelected((current) => {
      const next = new Map(current);
      for (const ree of result.items) {
        if (checked) next.set(ree.id, { name: ree.name, isPublic: ree.isPublic, moderated: Boolean(ree.moderatedAt) });
        else next.delete(ree.id);
      }
      return next;
    });
  const selectAllResults = async () => {
    setSelectingAll(true);
    const params = new URLSearchParams({ select: '1' });
    if (query.q) params.set('q', query.q);
    if (query.visibility !== 'all') params.set('status', query.visibility);
    const response = await api<{ items?: ReeSelectionItem[] }>(`/api/rees?${params}`);
    setSelectingAll(false);
    if (!response.ok || !response.data.items) return toast(t.common.errors.generic);
    if (response.data.items.length < result.total) toast(fill(r.selection.tooMany, { n: n(REE_BATCH_MAX) }));
    setSelected(new Map(response.data.items.map((ree) => [ree.id, { name: ree.name, isPublic: ree.isPublic, moderated: ree.moderated }])));
  };

  const confirmBatch = async () => {
    if (!review || saving) return;
    setSaving(true);
    const response = await api<VisibilityPlan & { error?: string }>('/api/rees/batch', {
      method: 'POST',
      json: { ids: [...selected.keys()], isPublic: review.isPublic },
    });
    setSaving(false);
    if (!response.ok) {
      setReview(null);
      return toast(r.batch.failed);
    }
    const label = review.isPublic ? r.batch.labels.public : r.batch.labels.private;
    const skipped = response.data.blocked.length;
    toast(fill(skipped ? r.batch.doneSkipped : r.batch.done, { n: n(response.data.changes.length), label, skipped: n(skipped) }));
    setReview(null);
    setSelected(new Map());
    start(() => router.refresh());
  };

  /** A checkbox whose mixed state follows the page selection. */
  const pageCheckbox = (label: string, className = '') => (
    <input
      type="checkbox"
      className={className}
      aria-label={label}
      checked={allOnPage}
      disabled={!result.items.length}
      ref={(node) => {
        if (node) node.indeterminate = someOnPage;
      }}
      onChange={(event) => togglePage(event.target.checked)}
    />
  );

  /* ---------------------------------------------------------------- parts */

  const statusTag = (ree: ReeListItem, className = '') => {
    const state = stateOf(ree);
    return (
      <span className={`tag ${state === 'moderated' ? 'border-[#f1d4d4] bg-[#fff3f3] text-red' : ''} ${className}`}>
        <Icon name={STATE_ICONS[state]} className="size-3" />
        {r.status[state]}
      </span>
    );
  };

  const sortHeader = (key: SortKey, label: string, className: string) => {
    const by = SORT_PARAMS[query.sort];
    const active = by.sort === key;
    const order = active ? by.order : null;
    const nextOrder = active ? (order === 'asc' ? 'desc' : 'asc') : key === 'name' ? 'asc' : 'desc';
    const accessible = fill(nextOrder === 'asc' ? r.sortAsc : r.sortDesc, { field: r.sortBy[key] });
    return (
      <th scope="col" className={className} aria-sort={order === 'asc' ? 'ascending' : order === 'desc' ? 'descending' : 'none'}>
        <button
          type="button"
          className={`inline-flex items-center gap-1 font-semibold hover:text-ink ${active ? 'text-ink' : ''}`}
          aria-label={accessible}
          title={accessible}
          onClick={() => go({ sort: `${key}_${nextOrder}` as ReeSort, page: 1 })}
        >
          {label}
          <Icon name="chevronDown" className={`size-3 ${active ? (order === 'asc' ? 'rotate-180' : '') : 'opacity-40'}`} />
        </button>
      </th>
    );
  };

  const pageLink = (page: number, label: string, children: ReactNode) =>
    page < 1 || page > pages ? (
      <span aria-disabled="true" className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-[#c4cad8]">
        {children}
      </span>
    ) : (
      <Link
        href={hrefFor({ page })}
        scroll={false}
        aria-label={label}
        className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg border border-line bg-white px-2 font-mono hover:border-blue hover:text-blue"
      >
        {children}
      </Link>
    );

  const pager = (compact: boolean) =>
    pages > 1 && (
      <nav aria-label={compact ? r.pager.top : r.pager.bottom} className="flex flex-wrap items-center gap-1 text-[12px]">
        {pageLink(result.page - 1, r.pager.previous, <Icon name="chevronLeft" className="size-3.5" />)}
        {compact ? (
          <span className="px-2 font-mono text-ink">
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
              <span key={value}>{pageLink(value, fill(r.pager.page, { n: value }), value)}</span>
            ),
          )
        )}
        {pageLink(result.page + 1, r.pager.next, <Icon name="chevronRight" className="size-3.5" />)}
        {!compact && (
          <form
            className="ml-2 flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              go({ page: Math.min(pages, Math.max(1, Math.floor(Number(jump)) || 1)) });
            }}
          >
            <label htmlFor="rees-page" className="text-muted">
              {t.common.pager.jump}
            </label>
            <input
              id="rees-page"
              type="number"
              min={1}
              max={pages}
              value={jump}
              aria-label={r.pager.jumpLabel}
              onChange={(event) => setJump(event.target.value)}
              className="h-8 w-14 rounded-lg border border-line bg-white px-2 font-mono text-ink"
            />
            <button type="submit" className="btn-secondary btn-sm">
              {r.pager.go}
            </button>
          </form>
        )}
      </nav>
    );

  const selectionBar = (
    <div className="mt-3 rounded-xl border border-line bg-white px-4 py-3 text-[12px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 font-semibold">
            {pageCheckbox(r.selection.page)}
            {r.selection.page}
          </label>
          <span role="status" aria-live="polite" className="flex items-baseline gap-2">
            {fill(r.selection.selected, { n: n(selected.size) })}
            {otherPages > 0 && <small className="text-[11px] text-muted">{fill(r.selection.otherPages, { n: n(otherPages) })}</small>}
          </span>
          {selected.size > 0 && (
            <button type="button" className="text-link text-[12px]" onClick={() => setSelected(new Map())}>
              {r.selection.clear}
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selected.size > 0 && selected.size < result.total && (
            <button type="button" className="text-link text-[12px]" onClick={() => void selectAllResults()} disabled={selectingAll}>
              {fill(r.selection.all, { n: n(result.total) })}
            </button>
          )}
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={!publicPlan.changes.length}
            onClick={() => setReview({ isPublic: true, plan: publicPlan })}
          >
            <Icon name="globe" className="size-3.5" />
            {r.selection.makePublic}
          </button>
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={!privatePlan.changes.length}
            onClick={() => setReview({ isPublic: false, plan: privatePlan })}
          >
            <Icon name="lock" className="size-3.5" />
            {r.selection.makePrivate}
          </button>
        </div>
      </div>
      {publicPlan.blocked.length > 0 && <p className="mt-2 text-[11px] text-muted">{fill(r.selection.blockedNote, { n: n(publicPlan.blocked.length) })}</p>}
    </div>
  );

  const reviewBody = review && (
    <div className="flex flex-col gap-2">
      <p>{fill(r.batch.summary, { selected: n(selected.size), n: n(review.plan.changes.length) })}</p>
      <ul className="list-disc pl-5 text-ink">
        {review.plan.changes.slice(0, 5).map((id) => (
          <li key={id} className="truncate">
            {selected.get(id)?.name}
          </li>
        ))}
      </ul>
      {review.plan.changes.length > 5 && <p>{fill(r.batch.more, { n: n(review.plan.changes.length - 5) })}</p>}
      {review.plan.unchanged.length > 0 && <p>{fill(r.batch.unchanged, { n: n(review.plan.unchanged.length) })}</p>}
      {review.plan.blocked.length > 0 && <p>{fill(r.batch.blocked, { n: n(review.plan.blocked.length) })}</p>}
      <p>{review.isPublic ? r.batch.publicNote : r.batch.privateNote}</p>
    </div>
  );

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-8 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">{r.eyebrow}</p>
          <h1 className="mt-2 flex items-baseline gap-2 text-[28px] font-extrabold tracking-tight">
            {r.title}
            <span className="font-mono text-[14px] font-medium text-muted">{n(totals.rees)}</span>
          </h1>
          <p className="mt-2 text-[13px] text-muted">{r.lede}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Step 7: the video studio (prototype `#/videos`) is reached from here. */}
          <Link href="/videos" className="btn-secondary">
            <Icon name="film" />
            {t.video.library.entry}
          </Link>
          <Link href="/rees/new" className="btn">
            <Icon name="plus" />
            {r.create}
          </Link>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[
          [r.stats.sources, n(totals.sources), r.stats.sourcesUnit, r.stats.sourcesHint],
          [r.stats.answers, n(totals.answers), r.stats.answersUnit, r.stats.answersHint],
          [r.stats.public, n(totals.public), r.stats.publicUnit, fill(r.stats.publicHint, { private: n(totals.private) })],
        ].map(([label, value, unit, hint]) => (
          <div key={label} className="card p-5">
            <p className="text-[12px] font-semibold text-muted">{label}</p>
            <p className="mt-2 flex items-baseline gap-1">
              <strong className="font-mono text-[26px] font-semibold">{value}</strong>
              <span className="text-[11px] text-muted">{unit}</span>
            </p>
            <p className="mt-1 text-[11px] text-muted">{hint}</p>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-1 overflow-x-auto" role="tablist">
          {(['all', 'public', 'private'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={query.visibility === value}
              onClick={() => go({ visibility: value, page: 1 })}
              className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold whitespace-nowrap ${
                query.visibility === value ? 'bg-soft text-blue' : 'text-muted hover:text-ink'
              }`}
            >
              {r.filters[value]}
            </button>
          ))}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              go({ q: q.trim(), page: 1 });
            }}
          >
            <label className="relative min-w-0 flex-1 lg:w-[320px]">
              <span className="sr-only">{r.searchLabel}</span>
              <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[#a3a9bb]" />
              <input className="input pl-9" type="search" value={q} placeholder={r.search} onChange={(event) => setQ(event.target.value)} />
            </label>
            <button type="submit" className="btn-secondary" aria-label={r.searchLabel}>
              <Icon name="arrow" />
            </button>
          </form>
          <label className="flex items-center gap-1.5 text-[12px] text-muted">
            {t.common.pager.perPage}
            <select
              className="rounded-md border border-line bg-white px-2 py-1.5 text-[12px] text-ink"
              aria-label={r.perPageLabel}
              value={query.size}
              onChange={(event) => go({ size: Number(event.target.value), page: 1 })}
            >
              {REE_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[12px] text-muted">
        <span>
          {result.total ? fill(r.total, { total: n(result.total), from: n(from), to: n(to) }) : r.totalEmpty}
          {query.q && ` · ${fill(r.searchEcho, { q: query.q })}`}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5">
            {r.sortLabel}
            <select className="rounded-md border border-line bg-white px-2 py-1.5 text-[12px] text-ink" value={query.sort} onChange={(event) => go({ sort: event.target.value as ReeSort, page: 1 })}>
              {(Object.keys(SORT_PARAMS) as ReeSort[]).map((value) => (
                <option key={value} value={value}>
                  {r.sorts[value]}
                </option>
              ))}
            </select>
          </label>
          <div className="flex rounded-lg border border-line bg-white p-0.5" role="group" aria-label={r.views.label}>
            {(['cards', 'list'] as const).map((view) => (
              <button
                key={view}
                type="button"
                aria-pressed={query.view === view}
                onClick={() => go({ view })}
                className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-semibold ${query.view === view ? 'bg-soft text-blue' : 'text-muted'}`}
              >
                <Icon name={view} className="size-3.5" />
                {r.views[view]}
              </button>
            ))}
          </div>
          {pager(true)}
        </div>
      </div>
      {list && result.items.length > 0 && selectionBar}

      <div className={`mt-4 transition-opacity ${pending ? 'opacity-60' : ''}`}>
        {result.items.length === 0 ? (
          <div className="card flex flex-col items-center gap-3 px-4 py-14 text-center">
            <ReeAvatar size="lg" />
            <strong className="text-[15px]">{totals.rees ? r.emptyTitle : r.firstTitle}</strong>
            <p className="max-w-[380px] text-[12px] text-muted">{totals.rees ? r.emptyBody : r.firstBody}</p>
            {totals.rees ? (
              <button type="button" className="btn-secondary btn-sm" onClick={() => go({ q: '', visibility: 'all', page: 1 })}>
                {t.common.actions.clear}
              </button>
            ) : (
              <Link href="/rees/new" className="btn btn-sm">
                <Icon name="plus" />
                {r.firstCreate}
              </Link>
            )}
          </div>
        ) : !list ? (
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {result.items.map((ree) => (
              <li key={ree.id} className="card flex flex-col overflow-hidden">
                {videos[ree.id] ? (
                  <div className="relative border-b border-line">
                    <Link href={`/rees/${ree.id}/settings`} className="block" aria-label={ree.name}>
                      <VideoPoster ree={ree} video={videos[ree.id]!} />
                    </Link>
                    {statusTag(ree, 'absolute top-3 left-3 bg-white')}
                    <PlayIntroButton video={videos[ree.id]!} name={ree.name} href={`/rees/${ree.id}/video`} linkLabel={t.video.dialog.studio} className="absolute top-3 right-3" />
                  </div>
                ) : (
                  /* The same "暂无视频介绍" placeholder as explore (prototype discovery-video.js). */
                  <Link href={`/rees/${ree.id}/settings`} className="relative block border-b border-line" aria-label={ree.name}>
                    <VideoPlaceholder ree={ree} />
                    {statusTag(ree, 'absolute top-3 right-3 bg-white')}
                  </Link>
                )}
                <div className="flex flex-1 flex-col gap-3 p-4">
                  <p className="line-clamp-2 min-h-[2.6em] text-[12px] text-muted" title={ree.description}>
                    {ree.description || '—'}
                  </p>
                  <div className="flex flex-wrap gap-3 text-[11px] text-muted">
                    <Link href={`/rees/${ree.id}/knowledge`} className="flex items-center gap-1 hover:text-blue" aria-label={fill(r.rowLabels.knowledge, { name: ree.name })}>
                      <Icon name="file" className="size-3.5" />
                      {fill(r.sourcesShort, { count: n(ree.sources) })}
                    </Link>
                    <Link href={`/rees/${ree.id}/statistics`} className="flex items-center gap-1 hover:text-blue" aria-label={fill(r.rowLabels.statistics, { name: ree.name })}>
                      <Icon name="chat" className="size-3.5" />
                      {fill(r.answersShort, { count: n(ree.answers) })}
                    </Link>
                  </div>
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
                    <Link href={`/rees/${ree.id}/video`} className="text-link text-[12px]">
                      <Icon name="film" className="size-3.5" />
                      {videos[ree.id] ? r.video.edit : r.video.create}
                    </Link>
                    <Link href={`/rees/${ree.id}/settings`} className="btn-secondary btn-sm">
                      {r.open}
                      <Icon name="arrow" className="size-3.5" />
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full table-fixed text-left text-[12px]">
              <thead className="hidden border-b border-line bg-wash text-[11px] text-muted md:table-header-group">
                <tr>
                  <th scope="col" className="w-[44px] py-3 pl-4">
                    {pageCheckbox(r.selection.pageAll, 'align-middle')}
                  </th>
                  {sortHeader('name', r.columns.name, 'px-3 py-3')}
                  <th scope="col" className="w-[110px] px-3 py-3 font-semibold">
                    {r.columns.visibility}
                  </th>
                  {sortHeader('sources', r.columns.sources, 'w-[120px] px-3 py-3')}
                  {sortHeader('answers', r.columns.answers, 'w-[110px] px-3 py-3')}
                  <th scope="col" className="w-[230px] px-3 py-3 font-semibold">
                    {r.columns.actions}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {result.items.map((ree) => (
                  <tr
                    key={ree.id}
                    className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 md:table-row md:px-0 md:py-0 ${selected.has(ree.id) ? 'bg-soft/60' : ''}`}
                  >
                    <td className="md:py-3 md:pl-4">
                      <input
                        type="checkbox"
                        className="align-middle"
                        aria-label={fill(r.selection.row, { name: ree.name })}
                        checked={selected.has(ree.id)}
                        onChange={(event) => toggleRow(ree, event.target.checked)}
                      />
                    </td>
                    <td className="min-w-0 flex-1 md:w-auto md:px-3 md:py-3">
                      <Link href={`/rees/${ree.id}/settings`} className="flex min-w-0 items-center gap-3">
                        <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" />
                        <span className="min-w-0">
                          <strong className="block truncate text-[13px] hover:text-blue" title={ree.name}>
                            {ree.name}
                          </strong>
                          <span className="block truncate text-muted" title={ree.description}>
                            {ree.description || '—'}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="md:px-3">{statusTag(ree)}</td>
                    <td className="md:px-3">
                      <Link href={`/rees/${ree.id}/knowledge`} className="font-mono font-semibold hover:text-blue" aria-label={fill(r.rowLabels.knowledge, { name: ree.name })}>
                        {n(ree.sources)}
                      </Link>
                      <span className="ml-1 text-muted md:ml-0 md:block">{fill(r.readyCount, { ready: n(ree.readySources) })}</span>
                    </td>
                    <td className="md:px-3">
                      <Link href={`/rees/${ree.id}/statistics`} className="font-mono font-semibold hover:text-blue" aria-label={fill(r.rowLabels.statistics, { name: ree.name })}>
                        {n(ree.answers)}
                      </Link>
                    </td>
                    <td className="ml-auto md:ml-0 md:px-3">
                      <div className="flex items-center gap-1">
                        <Link href={`/rees/${ree.id}/knowledge`} className="btn-secondary btn-sm" aria-label={fill(r.rowLabels.knowledge, { name: ree.name })}>
                          {r.manageKnowledge}
                        </Link>
                        <Link href={`/rees/${ree.id}/video`} className="btn-ghost" aria-label={fill(r.video.label, { name: ree.name })}>
                          <Icon name="film" className="size-3.5" />
                          {t.video.tab}
                        </Link>
                        <Link
                          href={`/rees/${ree.id}/settings`}
                          className="icon-btn"
                          aria-label={fill(r.rowLabels.settings, { name: ree.name })}
                          title={fill(r.rowLabels.settings, { name: ree.name })}
                        >
                          <Icon name="settings" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {result.total > 0 && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-[12px] text-muted">
          <span>{r.pager.pageOnly}</span>
          {pager(false)}
        </div>
      )}
      <ConfirmModal
        open={review !== null}
        title={review ? fill(review.isPublic ? r.batch.titlePublic : r.batch.titlePrivate, { n: n(review.plan.changes.length) }) : ''}
        body={reviewBody}
        confirmLabel={review?.isPublic ? r.batch.confirmPublic : r.batch.confirmPrivate}
        busy={saving}
        onClose={() => !saving && setReview(null)}
        onConfirm={() => void confirmBatch()}
      />
    </main>
  );
}

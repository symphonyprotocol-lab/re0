'use client';

import { ReePublication, ReePublicationStatus } from '@/components/rees/ree-publication';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { usePathname } from 'next/navigation';
import { useNavigationRouter as useRouter } from '@/components/shell/navigation-provider';
import { useEffect, useRef, useState, useTransition, type MouseEvent, type ReactNode } from 'react';
import { REE_PAGE_SIZES } from '@/lib/constants';
import { pageNumbers, type ListResult } from '@/lib/domain/list';
import { REE_BATCH_MAX, visibilityPlan, type VisibilityPlan, type VisibilityRow } from '@/lib/domain/ree';
import type { IntroProps } from '@/lib/domain/video';
import type { ReeListItem, ReeSelectionItem, ReeSort, ReeVisibility } from '@/lib/services/rees';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { ConfirmModal } from '@/components/ui/modal';
import { useToast } from '@/components/ui/toast';
import { ReeCardCover } from '@/components/rees/ree-card-cover';
import { DotAvatar, PIcon } from '@/components/rees/proto-icon';
import { Icon } from '@/components/ui/icons';
import { ReeCardMetrics } from '@/components/discover/ree-card-metrics';
import './ree-pages.css';
import './owned-rees.css';
import '@/components/discover/ree-video-card.css';

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

function OwnedCover({ ree, video }: { ree: ReeListItem; video?: IntroProps }) {
  const { t } = useI18n();
  const r = t.rees;
  const state = stateOf(ree);
  return (
    <ReeCardCover ree={ree} href={`/rees/${ree.id}/settings`} label={fill(r.openLabel, { name: ree.name })} video={video}>
      {(state === 'private' || state === 'moderated') && (
        <span className="creator-cover-status">
          <PIcon name={STATE_ICONS[state]} />
          {r.status[state]}
        </span>
      )}
    </ReeCardCover>
  );
}

/**
 * A click anywhere on a list row opens the Ree, as its name link does. The
 * link stays the row's one tab stop; the click is forwarded to it so Next's
 * navigation feedback and modifier keys behave the same. The selection cell,
 * the row's own controls and text selections are left alone.
 */
function openRow(event: MouseEvent<HTMLTableRowElement>) {
  if (event.defaultPrevented || event.button !== 0) return;
  const target = event.target as Element;
  if (target.closest('a, button, input, select, textarea, label, [role="button"], .owned-ree-list-selection')) return;
  if (window.getSelection()?.toString()) return;
  const link = event.currentTarget.querySelector<HTMLAnchorElement>('a.owned-ree-list-name');
  link?.dispatchEvent(new window.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
  }));
}

/** A Ree's state for the owner: taken down wins over its public flag (prototype owned-rees.js `list`). */
function stateOf(ree: { isPublic: boolean; isPublished: boolean; moderatedAt: Date | string | null }): 'published' | 'unpublished' | 'private' | 'moderated' {
  return ree.moderatedAt ? 'moderated' : !ree.isPublic ? 'private' : ree.isPublished ? 'published' : 'unpublished';
}

const STATE_ICONS = { published: 'globe', unpublished: 'lock', private: 'lock', moderated: 'shield' } as const;

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
  coverVideos,
  guide,
}: {
  result: ListResult<ReeListItem>;
  totals: { rees: number; public: number; private: number; sources: number; answers: number };
  query: Query;
  coverVideos: Record<string, IntroProps | undefined>;
  /** The starter task guide (components/rees/task-guide.tsx), under the heading while it is shown. */
  guide?: ReactNode;
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
  const pageCheckbox = (label: string) => (
    <input
      type="checkbox"
      data-owned-ree-page-check=""
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

  const statusLabel = (ree: ReeListItem) => {
    const state = stateOf(ree);
    return (
      <span className={`owned-ree-status ${state}`}>
        <PIcon name={STATE_ICONS[state]} />
        {r.status[state]}
      </span>
    );
  };

  const sortHeader = (key: SortKey, label: string) => {
    const by = SORT_PARAMS[query.sort];
    const active = by.sort === key;
    const order = active ? by.order : null;
    const nextOrder = active ? (order === 'asc' ? 'desc' : 'asc') : key === 'name' ? 'asc' : 'desc';
    const accessible = fill(nextOrder === 'asc' ? r.sortAsc : r.sortDesc, { field: r.sortBy[key] });
    return (
      <th className={`owned-ree-heading-${key}`} scope="col" aria-sort={order === 'asc' ? 'ascending' : order === 'desc' ? 'descending' : 'none'}>
        <button
          type="button"
          className="owned-ree-sort-button"
          aria-label={accessible}
          title={accessible}
          onClick={() => go({ sort: `${key}_${nextOrder}` as ReeSort, page: 1 })}
        >
          {label}
          <PIcon name={active ? 'down' : 'sort'} />
        </button>
      </th>
    );
  };

  const pageLink = (page: number, label: string, children: ReactNode) =>
    page < 1 || page > pages ? (
      <span className="is-disabled" aria-disabled="true">
        {children}
      </span>
    ) : (
      <Link href={hrefFor({ page })} scroll={false} aria-label={label}>
        {children}
      </Link>
    );

  const pager = (compact: boolean) =>
    pages > 1 && (
      <nav className={`discovery-pagination ${compact ? 'is-compact' : ''}`} aria-label={compact ? r.pager.top : r.pager.bottom}>
        {pageLink(result.page - 1, r.pager.previous, <PIcon name="chevron" />)}
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
              <span key={value} className="is-current" aria-current="page">
                {value}
              </span>
            ) : (
              <Link key={value} href={hrefFor({ page: value })} scroll={false} aria-label={fill(r.pager.page, { n: value })}>
                {value}
              </Link>
            ),
          )
        )}
        {pageLink(result.page + 1, r.pager.next, <PIcon name="chevron" />)}
        {!compact && (
          <form
            id="owned-ree-jump"
            onSubmit={(event) => {
              event.preventDefault();
              go({ page: Math.min(pages, Math.max(1, Math.floor(Number(jump)) || 1)) });
            }}
          >
            <label htmlFor="owned-ree-page">{r.pager.jump}</label>
            <input
              id="owned-ree-page"
              name="page"
              type="number"
              min={1}
              max={pages}
              value={jump}
              aria-label={r.pager.jumpLabel}
              required
              onChange={(event) => setJump(event.target.value)}
            />
            <button type="submit">{r.pager.go}</button>
          </form>
        )}
      </nav>
    );

  const selectionBar = (
    <div id="owned-ree-bulk-host">
      <div className="owned-ree-bulk-bar">
        <div className="owned-ree-bulk-summary">
          <label>
            {pageCheckbox(r.selection.pageAll)}
            <span>{r.selection.page}</span>
          </label>
          <span role="status" aria-live="polite">
            {fill(r.selection.selected, { n: n(selected.size) })}
            {otherPages > 0 && <small>{fill(r.selection.otherPages, { n: n(otherPages) })}</small>}
          </span>
          {selected.size > 0 && (
            <button type="button" className="text-link" onClick={() => setSelected(new Map())}>
              {r.selection.clear}
            </button>
          )}
        </div>
        <div className="owned-ree-bulk-actions">
          {selected.size > 0 && selected.size < result.total && (
            <button type="button" className="text-link" onClick={() => void selectAllResults()} disabled={selectingAll}>
              {fill(r.selection.all, { n: n(result.total) })}
            </button>
          )}
          <button type="button" className="btn secondary sm" disabled={!publicPlan.changes.length} onClick={() => setReview({ isPublic: true, plan: publicPlan })}>
            <PIcon name="globe" />
            {r.selection.makePublic}
          </button>
          <button type="button" className="btn secondary sm" disabled={!privatePlan.changes.length} onClick={() => setReview({ isPublic: false, plan: privatePlan })}>
            <PIcon name="lock" />
            {r.selection.makePrivate}
          </button>
        </div>
      </div>
      {publicPlan.blocked.length > 0 && <p className="owned-ree-bulk-note">{fill(r.selection.blockedNote, { n: n(publicPlan.blocked.length) })}</p>}
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

  const [totalBefore, totalAfter] = r.total.split('{total}');
  /* While the next page loads, the current results fade (the prototype renders synchronously). */
  const fade = pending ? { opacity: 0.6 } : undefined;

  return (
    <main className="page owned-rees-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">{r.eyebrow}</p>
          <h1>
            {r.title}
            <span className="owned-ree-count mono">{n(totals.rees)}</span>
          </h1>
          <p>{r.lede}</p>
        </div>
        <div className="owned-ree-head-actions">
          <Link href="/rees/new" className="btn">
            <PIcon name="plus" />
            {r.create}
          </Link>
        </div>
      </div>

      {guide}

      <div className="metric-grid">
        {([
          [r.stats.sources, n(totals.sources), r.stats.sourcesUnit, r.stats.sourcesHint, '/workspace/sources'],
          [r.stats.answers, n(totals.answers), r.stats.answersUnit, r.stats.answersHint, '/workspace/answers'],
          [r.stats.public, n(totals.public), r.stats.publicUnit, fill(r.stats.publicHint, { private: n(totals.private) }), '/rees?visibility=published'],
        ] as const).map(([label, value, unit, hint, href]) => (
          <Link key={label} href={href} className="card metric">
            <p>{label}</p>
            <div className="value">
              {value}
              <small>{unit}</small>
            </div>
            <small>{hint}</small>
          </Link>
        ))}
      </div>

      <div id="owned-ree-list-start" className="owned-ree-list-start" />
      <section className="owned-ree-toolbar" id="owned-ree-results" aria-label={r.toolbar}>
        <div className="owned-ree-controls">
          <div className="filter-row" role="group" aria-label={r.filters.label}>
            {(['all', 'public', 'private', 'published', 'unpublished'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`filter ${query.visibility === value ? 'active' : ''}`}
                aria-pressed={query.visibility === value}
                onClick={() => go({ visibility: value, page: 1 })}
              >
                {r.filters[value]}
              </button>
            ))}
          </div>
          <form
            className="search-small"
            id="owned-ree-search"
            onSubmit={(event) => {
              event.preventDefault();
              go({ q: q.trim(), page: 1 });
            }}
          >
            <PIcon name="search" />
            <input name="q" value={q} maxLength={200} aria-label={r.searchLabel} placeholder={r.search} onChange={(event) => setQ(event.target.value)} />
            <button type="submit" aria-label={r.searchSubmit}>
              <PIcon name="arrow" />
            </button>
          </form>
          <label className="discovery-select">
            <span>{t.common.pager.perPage}</span>
            <select id="owned-ree-size" aria-label={r.perPageLabel} value={query.size} onChange={(event) => go({ size: Number(event.target.value), page: 1 })}>
              {REE_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="discovery-results-head">
          <p>
            {totalBefore}
            <strong>{n(result.total)}</strong>
            {totalAfter}
            {result.total > 0 && fill(r.range, { from: n(from), to: n(to) })}
            {query.q && ` · ${fill(r.searchEcho, { q: query.q })}`}
          </p>
          <div className="owned-ree-results-tools">
            <label className="owned-ree-sort-control">
              <span>{r.sortLabel}</span>
              <select id="owned-ree-sort" aria-label={r.sortAria} value={query.sort} onChange={(event) => go({ sort: event.target.value as ReeSort, page: 1 })}>
                {(Object.keys(SORT_PARAMS) as ReeSort[]).map((value) => (
                  <option key={value} value={value}>
                    {r.sorts[value]}
                  </option>
                ))}
              </select>
            </label>
            <div className="owned-ree-view-switch" role="group" aria-label={r.views.label}>
              {(['cards', 'list'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={query.view === view}
                  aria-label={view === 'cards' ? r.views.cardsLabel : r.views.listLabel}
                  title={view === 'cards' ? r.views.cardsLabel : r.views.listLabel}
                  onClick={() => go({ view })}
                >
                  <PIcon name={view === 'cards' ? 'grid' : 'list'} />
                  <span>{r.views[view]}</span>
                </button>
              ))}
            </div>
            {pager(true)}
          </div>
        </div>
        {list && selectionBar}
      </section>

      {result.items.length === 0 ? (
          <section className="card empty owned-ree-empty" style={fade}>
            <PIcon name="dot" />
            <h2>{totals.rees ? r.emptyTitle : r.firstTitle}</h2>
            <p>{totals.rees ? r.emptyBody : r.firstBody}</p>
            {totals.rees ? (
              <Link href={hrefFor({ q: '', visibility: 'all', page: 1 })} scroll={false} className="btn secondary">
                {r.clearFilters}
              </Link>
            ) : (
              <Link href="/rees/new" className="btn">
                {r.firstCreate}
              </Link>
            )}
          </section>
        ) : !list ? (
          <div className="dot-grid" style={fade}>
            {result.items.map((ree) => (
              <article key={ree.id} className="dot-card owned-card creator-dot-card ree-video-card" aria-label={ree.name}>
                <OwnedCover ree={ree} video={coverVideos[ree.id]} />
                <div className="ree-card-info">
                  <p className="description">{ree.description}</p>
                  <div className="card-actions">
                    <Link href={`/rees/${ree.id}/knowledge`} className="dot-sources" aria-label={fill(r.rowLabels.knowledge, { name: ree.name })}>
                      <Icon name="file" />
                      {fill(t.discover.card.sources, { n: n(ree.sources) })}
                    </Link>
                    <Link href={`/rees/${ree.id}/statistics`} className="ree-card-statistics" aria-label={fill(r.rowLabels.statistics, { name: ree.name })}>
                      <ReeCardMetrics answers={ree.answers} positiveRate={ree.positiveRate} />
                    </Link>
                  </div>
                  <ReePublicationStatus ree={ree} />
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="card owned-ree-list-wrap" style={fade}>
            <table className="owned-ree-table">
              <caption className="owned-ree-sr-only">{r.caption}</caption>
              <thead>
                <tr>
                  <th className="owned-ree-heading-selection" scope="col">
                    {pageCheckbox(r.selection.pageAll)}
                  </th>
                  {sortHeader('name', r.columns.name)}
                  <th className="owned-ree-heading-status" scope="col">
                    {r.columns.visibility}
                  </th>
                  {sortHeader('sources', r.columns.sources)}
                  {sortHeader('answers', r.columns.answers)}
                  <th className="owned-ree-heading-actions" scope="col">
                    {r.columns.actions}
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((ree) => (
                  <tr key={ree.id} className={`owned-ree-list-row${selected.has(ree.id) ? ' is-selected' : ''}`} onClick={openRow}>
                    <td className="owned-ree-list-selection">
                      <label>
                        <input
                          type="checkbox"
                          data-owned-ree-check=""
                          aria-label={fill(r.selection.row, { name: ree.name })}
                          checked={selected.has(ree.id)}
                          onChange={(event) => toggleRow(ree, event.target.checked)}
                        />
                      </label>
                    </td>
                    <td className="owned-ree-list-identity">
                      <Link href={`/rees/${ree.id}/settings`} className="owned-ree-list-name" aria-label={fill(r.openLabel, { name: ree.name })}>
                        <DotAvatar avatar={ree.avatarBlob} color={ree.color} small />
                        <span>
                          <strong title={ree.name}>{ree.name}</strong>
                          <small title={ree.description}>{ree.description}</small>
                        </span>
                      </Link>
                    </td>
                    <td className="owned-ree-list-status">{statusLabel(ree)}</td>
                    <td className="owned-ree-list-sources">
                      <span className="owned-ree-mobile-label">{r.columns.sources}</span>
                      <Link href={`/rees/${ree.id}/knowledge`} className="owned-ree-count-link" aria-label={fill(r.rowLabels.knowledge, { name: ree.name })}>
                        {n(ree.sources)}
                      </Link>
                      <small>{fill(r.readyCount, { ready: n(ree.readySources) })}</small>
                    </td>
                    <td className="owned-ree-list-answers">
                      <span className="owned-ree-mobile-label">{r.columns.answers}</span>
                      <Link href={`/rees/${ree.id}/statistics`} className="owned-ree-count-link" aria-label={fill(r.rowLabels.statistics, { name: ree.name })}>
                        {n(ree.answers)}
                      </Link>
                    </td>
                    <td className="owned-ree-list-actions">
                      <ReePublication ree={ree} showStatus={false} />
                      <Link href={`/rees/${ree.id}/knowledge`} className="btn secondary sm" aria-label={fill(r.rowLabels.knowledge, { name: ree.name })}>
                        {r.manageKnowledge}
                      </Link>
                      <Link href={`/rees/${ree.id}/video`} className="text-link" aria-label={fill(r.video.label, { name: ree.name })}>
                        <PIcon name="film" />
                        {r.videoLink}
                      </Link>
                      <Link
                        href={`/rees/${ree.id}/settings`}
                        className="icon-btn"
                        aria-label={fill(r.rowLabels.settings, { name: ree.name })}
                        title={fill(r.rowLabels.settings, { name: ree.name })}
                      >
                        <PIcon name="settings" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <div className="discovery-results-footer">
        <span>{r.pager.pageOnly}</span>
        {pager(false)}
      </div>
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

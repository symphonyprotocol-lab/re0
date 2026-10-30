'use client';
import { describeReviewNote } from '@/lib/domain/review';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DeleteAssetControl, type DeleteAssetAction } from '@/components/dashboard/asset-delete';
import { ReviewPipeline } from '@/components/dashboard/asset-manage';
import { RebuildAssetControl, type RebuildAssetAction } from '@/components/dashboard/asset-rebuild';
import type { BuildQuote } from '@/lib/application/plans/build-quota';
import { Badge, PANEL, SearchField, StatusLabel, type StatusTone } from '@/components/dashboard/ui';
import { LinkPending } from '@/components/dashboard/link-pending';
import { ArrowRightIcon, FileTextIcon } from '@/components/ui/icons';
import type { ReviewPipelineEntry } from '@/lib/domain/asset';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * Which of the list's buckets a row falls in. The design's four-way status
 * marker (`StatusTone`) is kept for the label; the bucket splits the
 * `blocked` tone in two, because requirement.md 5.2 asks for a 需修改 filter
 * of its own and a suspended asset is not one the owner can fix by
 * editing.
 */
export type AssetBucket = 'live' | 'pending' | 'blocked' | 'exempt';

export type AssetFilter = 'all' | 'public' | 'private' | 'pending' | 'blocked';

/** Rows a page of the list shows; the filters and the search narrow the whole list first. */
export const ASSETS_PAGE_SIZE = 10;

const PAGER =
  'inline-flex h-[29px] items-center rounded-md border border-line bg-card px-2.5 text-[11px] font-medium text-ink hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-card';

/** One row of the live list, mapped by the page from the workspace's rows. */
export interface AssetListRow {
  id: string;
  slug: string;
  title: string;
  /** The asset's kind, worded (`t.channels.kinds`). */
  kindLabel: string;
  /** Where the row opens: the detail page, or an article's or episode's editor. */
  href: string;
  version: string | null;
  /** In a public channel, or its owner's alone (agent-first-proposal.md 6.2). */
  scope: 'public' | 'private';
  /** The channel the asset is in, linking to its dashboard page; null when in none. */
  channel: { title: string; href: string } | null;
  chunks: number;
  /** Calls served from the asset, all time and this UTC month (builds excluded). */
  calls: { total: number; thisMonth: number };
  /** StatusLabel tone + its translated label, derived from lifecycle+index. */
  status: StatusTone;
  statusLabel: string;
  bucket: AssetBucket;
  updated: string;
  initial: string;
  /** The files page of an upload asset; null for every other source. */
  filesHref: string | null;
  /** The files link's label -- PDF or Markdown -- when there is one. */
  filesLabel: string | null;
  /** A reviewer's feedback the owner has to act on, untranslated. */
  note: string | null;
  /** Where a running build is, already worded; null when nothing is building. */
  buildNote: string | null;
  /** Where a public asset stands in the publishing pipeline; null when it is not in it. */
  pipeline: ReviewPipelineEntry[] | null;
  /** Rebuild is not offered: archived, or a build cannot be paid for. */
  rebuildDisabled: boolean;
}

/** Deterministic tile colour from the slug: stable across renders and rows. */
const TILE_COLORS = ['#0f9d77', '#5865f2', '#d97706', '#0ea5e9', '#9333ea', '#e11d48'];
function tileColor(slug: string): string {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length]!;
}

function matches(row: AssetListRow, filter: AssetFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'public':
    case 'private':
      return row.scope === filter;
    default:
      return row.bucket === filter;
  }
}

/**
 * Asset table with its toolbar -- design source frame `fiSE2`, live rows.
 *
 * `deleteAction` and `rebuildAction` are offered only to a member who may
 * manage assets (requirement.md 3.3: owners and admins); each action
 * re-checks the role, so the props decide what is drawn, not what is
 * allowed. Everyone else gets the read-only view requirement.md 5.2 asks for.
 */
export function AssetList({
  rows: allRows,
  deleteAction,
  rebuildAction,
  rebuildQuote,
}: {
  rows: AssetListRow[];
  deleteAction?: DeleteAssetAction;
  rebuildAction?: RebuildAssetAction;
  /** What a refresh may cost; the row's control says it before queueing. Required with `rebuildAction`. */
  rebuildQuote?: BuildQuote;
}) {
  const { locale, t } = useI18n();
  const l = t.dashboard.assets;
  const m = l.manage;
  const number = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [filter, setFilterOnly] = useState<AssetFilter>('all');
  const [term, setTermOnly] = useState('');
  /* Ten rows a page, counted after the filter and the search; either one
     narrowing the list starts it again from the first page. */
  const [page, setPage] = useState(1);
  const setFilter = (next: AssetFilter) => {
    setFilterOnly(next);
    setPage(1);
  };
  const setTerm = (next: string) => {
    setTermOnly(next);
    setPage(1);
  };

  /* requirement.md 5.2: 全部 / 公开 / 私有 / 审核中 / 需修改, plus the paused
     and failed bucket so nothing an owner has to act on is unreachable. */
  const filters: { id: AssetFilter; label: string }[] = [
    { id: 'all', label: l.filters.all },
    { id: 'public', label: m.filters.public },
    { id: 'private', label: m.filters.private },
    { id: 'pending', label: m.filters.pending },
    { id: 'blocked', label: m.filters.blocked },
  ];

  /* Room on the right for the controls that sit beside a row: the files
     link of an upload asset, refresh, and delete. */
  const controls =
    (deleteAction ? 1 : 0) + (rebuildAction ? 1 : 0) + (allRows.some((row) => row.filesHref) ? 1 : 0);
  const controlPad =
    controls === 3 ? 'pr-[144px]' : controls === 2 ? 'pr-[104px]' : controls === 1 ? 'pr-[64px]' : '';

  const rows = useMemo(() => {
    const needle = term.trim().toLowerCase();
    return allRows.filter((asset) => {
      const matchesTerm =
        needle === '' ||
        asset.title.toLowerCase().includes(needle) ||
        asset.slug.toLowerCase().includes(needle);
      return matches(asset, filter) && matchesTerm;
    });
  }, [filter, term, allRows]);
  const pages = Math.max(1, Math.ceil(rows.length / ASSETS_PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = rows.slice((current - 1) * ASSETS_PAGE_SIZE, current * ASSETS_PAGE_SIZE);

  return (
    <section className={`${PANEL} overflow-hidden p-0.5`}>
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line px-[18px] pt-3.5 pb-4">
        <div className="flex min-w-[220px] flex-1 items-center">
          <SearchField placeholder={l.searchPlaceholder} value={term} onChange={setTerm} />
        </div>
        <div className="flex flex-wrap gap-0 rounded-md bg-mutedbg p-[3px]">
          {filters.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              aria-pressed={filter === option.id}
              className={`h-[29px] rounded-md px-[9px] text-[11px] transition-colors ${
                filter === option.id
                  ? 'bg-card text-ink shadow-md'
                  : 'text-muted hover:text-ink'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {!deleteAction && !rebuildAction ? (
        <p className="border-b border-line px-[18px] py-2.5 text-[11px] text-muted">
          {m.readOnly}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <div className="min-w-[700px]">
          <div
            className={`grid grid-cols-[minmax(0,1fr)_104px_74px_84px_94px_92px_18px] items-center bg-subtle px-[18px] py-3 text-[11px] font-medium text-muted ${controlPad}`}
          >
            {l.columns.map((column) => (
              <span key={column}>{column}</span>
            ))}
            <span />
          </div>

          {visible.map((asset) => {
            /* Every row opens the owner's own detail page -- readiness,
               version, queue -- which is also where the public page is
               linked from once the asset is routable; an article or an
               episode opens its editor instead. */
            const cells: ReactNode = (
              <>
                <span className="flex min-w-0 items-center gap-2.5 pr-3">
                  <span
                    aria-hidden
                    className="flex size-[34px] shrink-0 items-center justify-center rounded-lg text-[13px] font-medium text-white"
                    style={{ backgroundColor: tileColor(asset.slug) }}
                  >
                    {asset.initial}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex items-center gap-1.5 text-[13px] text-ink">
                      <span className="truncate">{asset.title}</span>
                    </span>
                    <span className="truncate text-[10px] text-muted">
                      {asset.kindLabel} · {asset.slug}
                      {asset.version ? ` · ${asset.version}` : ''}
                    </span>
                  </span>
                </span>

                <span className="flex min-w-0 flex-col items-start gap-1 pr-3">
                  <Badge tone={asset.scope === 'public' ? 'public' : 'private'}>
                    {asset.scope === 'public' ? l.scopePublic : l.scopePrivate}
                  </Badge>
                  {asset.channel ? (
                    <span className="max-w-full truncate text-[10px] text-muted">{asset.channel.title}</span>
                  ) : null}
                </span>

                <span className="text-[12px] text-steel">
                  {number.format(asset.chunks)}
                </span>

                <span className="flex flex-col gap-0.5" title={l.callsHint}>
                  <span className="text-[12px] text-steel">{number.format(asset.calls.total)}</span>
                  <span className="text-[10px] text-muted">
                    {fill(l.callsThisMonth, { calls: number.format(asset.calls.thisMonth) })}
                  </span>
                </span>

                <span className="flex min-w-0 flex-col gap-1">
                  <StatusLabel tone={asset.status}>{asset.statusLabel}</StatusLabel>
                  {asset.buildNote ? (
                    <span className="truncate text-[10px] text-muted" title={asset.buildNote}>
                      {asset.buildNote}
                    </span>
                  ) : null}
                </span>

                <span className="text-[12px] text-muted">{asset.updated}</span>

                <LinkPending size={14} className="text-brandink">
                  <ArrowRightIcon size={14} className="text-muted" />
                </LinkPending>
              </>
            );
            /* Room on the right for the controls, which sit beside the row
               rather than inside it -- see DeleteAssetControl. */
            const rowClass = `grid grid-cols-[minmax(0,1fr)_104px_74px_84px_94px_92px_18px] items-center border-t border-line px-[18px] py-[19px] ${controlPad}`;

            return (
              <div key={asset.id} className="relative">
                <Link
                  href={asset.href}
                  className={`${rowClass} transition-colors hover:bg-subtle`}
                >
                  {cells}
                </Link>
                {/* requirement.md 5.2: a public asset shows its publishing
                    steps and the platform's note, if it left one. */}
                {asset.pipeline || asset.note ? (
                  <div className="border-t border-line/60 bg-subtle/60 px-[18px] py-2.5 pl-[62px]">
                    {asset.pipeline ? (
                      <ReviewPipeline entries={asset.pipeline} note={asset.note} compact />
                    ) : (
                      <p className="text-[10.5px] leading-[1.5] text-rose">
                        {describeReviewNote(asset.note ?? '', t.dashboard.assets.rulesReasons)}
                      </p>
                    )}
                  </div>
                ) : null}
                {controls > 0 ? (
                  <span className="absolute top-[19px] right-[18px] flex h-[34px] items-center gap-2">
                    {asset.filesHref ? (
                      <Link
                        href={asset.filesHref}
                        aria-label={asset.filesLabel ?? l.files}
                        title={asset.filesLabel ?? l.files}
                        className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-md border border-line bg-card text-muted transition-colors hover:bg-subtle hover:text-ink"
                      >
                        <FileTextIcon size={14} />
                      </Link>
                    ) : null}
                    {rebuildAction && rebuildQuote ? (
                      <RebuildAssetControl
                        assetId={asset.id}
                        action={rebuildAction}
                        quote={rebuildQuote}
                        disabled={asset.rebuildDisabled}
                      />
                    ) : null}
                    {deleteAction ? (
                      <DeleteAssetControl
                        action={deleteAction}
                        target={{
                          id: asset.id,
                          publicId: asset.slug,
                          title: asset.title,
                          initial: asset.initial,
                          color: tileColor(asset.slug),
                        }}
                      />
                    ) : null}
                  </span>
                ) : null}
              </div>
            );
          })}

          {rows.length === 0 ? (
            <p className="border-t border-line px-[18px] py-10 text-center text-[13px] text-muted">
              {l.empty}
            </p>
          ) : null}

          {/* Always there, even on one page: the owner sees the page size and the count without scrolling. */}
          {rows.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-[18px] py-3">
              <p className="text-[11px] text-muted">
                {fill(l.pager.page, { page: current, pages })} ·{' '}
                {fill(l.pager.showing, { shown: visible.length, total: number.format(rows.length) })}
              </p>
              <span className="flex items-center gap-2">
                <button type="button" disabled={current <= 1} onClick={() => setPage(current - 1)} className={PAGER}>
                  {l.pager.prev}
                </button>
                <button type="button" disabled={current >= pages} onClick={() => setPage(current + 1)} className={PAGER}>
                  {l.pager.next}
                </button>
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { FilterSelect } from '@/components/admin/list-controls';
import { CreatePlatformAssetControl } from '@/components/admin/platform-asset-dialog';
import {
  PlatformDeleteControl,
  PlatformRefreshControl,
} from '@/components/admin/platform-asset-controls';
import {
  CONSOLE_PANEL,
  ConsoleButton,
  ConsolePageHeader,
  EmptyRow,
  ExportLink,
  IconLink,
  ListToolbar,
  Monogram,
  Pagination,
  Panel,
  Pill,
  TabBar,
  TableScroller,
  TD,
  TH,
  TitleCell,
} from '@/components/admin/ui';
import { EyeIcon, GlobeIcon, RefreshIcon } from '@/components/ui/icons';
import {
  listPlatformAssets,
  platformAssetSummary,
  PLATFORM_STATUS_FILTERS,
  type PlatformStatusFilter,
} from '@/lib/application/administration';
import { isIngestionConfigured } from '@/lib/application/ingestion';
import { requireAdminCapability } from '@/lib/http/admin';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import {
  bytes,
  initialsOf,
  oneOf,
  PAGE_SIZE,
  pageNumber,
  pageWindow,
  searchTerm,
  utcStamp,
} from '../list-params';
import {
  createPlatformAssetAction,
  deletePlatformAssetAction,
  preparePlatformUploadAction,
  refreshPlatformAssetAction,
} from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.platformAssets.title };
}

/** How each lifecycle state reads on screen. Platform assets skip review. */
const LIFECYCLE_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  draft: 'neutral',
  published: 'ok',
  suspended: 'danger',
  archived: 'neutral',
};

/**
 * Assets re0 publishes itself -- design source frame `d5LpW4`.
 *
 * Reads the real `asset` table, filtered to `is_platform_asset`. A new
 * asset sits in `draft` with no version until a refresh has fetched its
 * source and indexed one, so the empty state says which of the two is missing:
 * nothing created yet, nothing matching the filters, or -- when the deployment
 * has no embedding provider or object storage -- a refresh that could not build
 * anything if it were queued.
 */
export default async function AdminPlatformAssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, params, t] = await Promise.all([
    requireAdminCapability('platformAssets'),
    searchParams,
    getMessages(),
  ]);
  const p = t.admin.platformAssets;
  const query = searchTerm(params.q);
  const status = oneOf(params.status, PLATFORM_STATUS_FILTERS, 'all');
  const page = pageNumber(params.page);

  /* Whether a queued refresh could build anything in this deployment. */
  const ingestionReady = await isIngestionConfigured();

  const [{ rows, total, counts }, summary] = await Promise.all([
    listPlatformAssets({ query, status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    platformAssetSummary(),
  ]);

  const view = pageWindow({ page, total, rows: rows.length });

  const link = (next: { status?: PlatformStatusFilter; page?: number }) => {
    const search = new URLSearchParams();
    if (query) search.set('q', query);
    const target = next.status ?? status;
    if (target !== 'all') search.set('status', target);
    if ((next.page ?? 1) > 1) search.set('page', String(next.page));
    return search.size > 0
      ? `/admin/platform-assets?${search.toString()}`
      : '/admin/platform-assets';
  };

  if (total > 0 && page > view.pageCount) redirect(link({ page: view.pageCount }));

  const number = (value: number) => value.toLocaleString('en-US');

  const stats = [
    {
      label: p.stats.published,
      value: number(summary.published),
      caption: fill(p.stats.publishedCaption, { total: number(counts.all) }),
    },
    {
      label: p.stats.synced,
      value: number(summary.syncedToday),
      caption:
        summary.queuedRefreshes > 0
          ? fill(p.stats.syncedCaption, { queued: number(summary.queuedRefreshes) })
          : p.stats.syncedCaptionNone,
    },
    {
      label: p.stats.calls,
      value: number(summary.callsThisMonth),
      /*
       * Nothing writes `usage_event` yet, so this is a true zero rather than a
       * missing figure -- and the operator is told which, because a zero with
       * no explanation is indistinguishable from a broken counter.
       */
      caption: summary.callsThisMonth === 0 ? p.stats.callsCaptionNotReady : p.stats.callsCaption,
    },
  ];

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={p.title} description={p.description} />

      <section className="flex flex-col gap-2.5">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {stats.map((stat) => (
            <article
              key={stat.label}
              className={`${CONSOLE_PANEL} flex items-start gap-2.5 rounded-[9px] p-4`}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[8px] bg-brandsoft text-brand">
                <GlobeIcon size={16} />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[18px] leading-[1.3] font-semibold tracking-[-0.03em] text-ink">
                  {stat.value}
                </span>
                <span className="truncate text-[11px] tracking-[-0.023em] text-muted">
                  {stat.label}
                </span>
                <span className="text-[11px] leading-[1.5] tracking-[-0.023em] text-faint">
                  {stat.caption}
                </span>
              </span>
            </article>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <CreatePlatformAssetControl
            action={createPlatformAssetAction}
            prepare={preparePlatformUploadAction}
          />
          <ConsoleButton href="/admin/refresh-queue">
            <RefreshIcon size={14} />
            {p.queueLink}
          </ConsoleButton>
        </div>
      </section>

      <TabBar
        activeId={status}
        tabs={PLATFORM_STATUS_FILTERS.map((id) => ({
          id,
          label: p.tabs[id],
          count: counts[id],
          href: link({ status: id, page: 1 }),
        }))}
      />

      <Panel>
        {/* GET, so a filtered list is a URL an operator can keep or share. */}
        <form method="get">
          <ListToolbar placeholder={p.searchPlaceholder} name="q" defaultValue={query}>
            <FilterSelect
              name="status"
              label={p.statusFilter}
              value={status}
              options={PLATFORM_STATUS_FILTERS.map((id) => ({
                id,
                label: id === 'all' ? t.admin.filters.all : p.tabs[id],
              }))}
            />
            <ConsoleButton type="submit">{t.admin.administrators.searchSubmit}</ConsoleButton>
            <ExportLink
              resource="platform-assets"
              query={query}
              status={status}
              label={t.admin.actions.export}
            />
          </ListToolbar>
        </form>

        <TableScroller>
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead>
              <tr>
                {p.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
                <th scope="col" className={`${TH} w-[86px]`}>
                  <span className="sr-only">{t.admin.actions.more}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow
                  columns={p.columns.length + 1}
                  message={counts.all === 0 ? p.empty : p.emptyFiltered}
                  note={
                    ingestionReady
                      ? counts.all === 0
                        ? t.admin.notReady.platformAssets
                        : undefined
                      : t.admin.notReady.ingestion
                  }
                />
              ) : null}
              {rows.map((asset) => (
                <tr key={asset.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <TitleCell
                      title={asset.title}
                      meta={asset.publicId}
                      leading={<Monogram initial={initialsOf(asset.title)} />}
                    />
                  </td>
                  <td className={TD}>{sourceLabel(asset.sourceType, asset.sourceCount, p)}</td>
                  <td className={TD}>{asset.documents.toLocaleString('en-US')}</td>
                  <td className={`${TD} whitespace-nowrap`}>{bytes(asset.storageBytes)}</td>
                  <td className={`${TD} whitespace-nowrap`}>
                    {asset.lastSyncedAt ? utcStamp(asset.lastSyncedAt) : p.neverSynced}
                  </td>
                  <td className={TD}>
                    <span className="flex flex-col items-start gap-1">
                      <Pill tone={LIFECYCLE_TONE[asset.lifecycleStatus] ?? 'neutral'}>
                        {label(p.lifecycle, asset.lifecycleStatus)}
                      </Pill>
                      {/* The index state is a separate fact from the lifecycle
                          one (requirement.md 6.2) and only shown when it is not
                          the ready one the lifecycle pill already implies. */}
                      {asset.indexStatus === 'ready' ? null : (
                        <span className="text-[11px] tracking-[-0.023em] text-faint">
                          {label(p.indexStatus, asset.indexStatus)}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="flex items-center gap-1.5">
                      <IconLink
                        label={p.view}
                        href={`/admin/platform-assets/${asset.id}`}
                      >
                        <EyeIcon size={14} />
                      </IconLink>
                      <PlatformRefreshControl
                        action={refreshPlatformAssetAction}
                        disabled={asset.lifecycleStatus === 'archived'}
                        target={{
                          id: asset.id,
                          publicId: asset.publicId,
                          title: asset.title,
                          initial: initialsOf(asset.title),
                          sourceLabel: sourceLabel(asset.sourceType, asset.sourceCount, p),
                        }}
                      />
                      <PlatformDeleteControl
                        action={deletePlatformAssetAction}
                        target={{
                          id: asset.id,
                          publicId: asset.publicId,
                          title: asset.title,
                          initial: initialsOf(asset.title),
                          sourceLabel: sourceLabel(asset.sourceType, asset.sourceCount, p),
                        }}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>

        <Pagination
          summary={fill(p.showing, { from: view.from, to: view.to, total })}
          pages={view.pages}
          activePage={page}
          pageCount={view.pageCount}
          href={(target) => link({ page: target })}
          labels={t.admin.actions}
        />
      </Panel>
    </div>
  );
}

/**
 * An asset's source, as one cell.
 *
 * An asset may have more than one source (requirement.md 6.1) and the column
 * has room for one, so a second one is counted rather than dropped -- a cell
 * that silently shows the first of three is a cell that lies about coverage.
 */
function sourceLabel(
  type: string | null,
  count: number,
  p: Dictionary['admin']['platformAssets'],
): string {
  if (!type) return '—';
  const name = label(p.sourceTypes, type);
  return count > 1 ? `${name} · ${fill(p.sourceCount, { count })}` : name;
}

/**
 * A translated enum value, falling back to the raw one.
 *
 * The columns hold Postgres enums, and a build whose dictionary is behind the
 * schema should print `deleting` rather than nothing at all.
 */
function label(dictionary: Record<string, string>, value: string): string {
  return dictionary[value] ?? value;
}

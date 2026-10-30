import type { Metadata } from 'next';
import Link from 'next/link';
import { AssetList, type AssetBucket, type AssetListRow } from '@/components/dashboard/asset-list';
import { LiveRefresh } from '@/components/dashboard/live-refresh';
import { describeBuild } from '@/lib/dashboard/build-progress';
import {
  ActionButton,
  Notice,
  PageHeader,
  StatTile,
  type StatusTone,
} from '@/components/dashboard/ui';
import { ASSET_KINDS, isAssetKind, type AssetKind } from '@/lib/domain/asset-kind';
import { isWizardEditorialKind } from '@/lib/domain/editorial';
import { fill } from '@/lib/i18n/format';
import {
  BadgeCheckIcon,
  DatabaseIcon,
  FileTextIcon,
  PlusIcon,
  ShieldCheckIcon,
} from '@/components/ui/icons';
import {
  canDeleteAssets,
  canManageAssets,
  assetUsageCounts,
  listWorkspaceAssets,
  type WorkspaceAssetRow,
} from '@/lib/application/assets';
import { isPublicChannel } from '@/lib/application/channels';
import { quoteBuild } from '@/lib/application/plans';
import { rebuildBlocked, reviewPipeline } from '@/lib/domain/asset';
import { requireSession } from '@/lib/http/session';
import { getMessages, translations } from '@/lib/i18n/server';
import { deleteWorkspaceAssetAction } from './actions';
import { rebuildAssetAction } from './[assetId]/actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.assets.title };
}

const STAT_ICONS = [DatabaseIcon, BadgeCheckIcon, FileTextIcon];

/**
 * Lifecycle plus index state collapse to the design's four-way marker: live
 * (published and queryable), pending (still indexing), blocked (suspended
 * or failed), exempt (a draft with nothing queued). Nothing waits for
 * review since 2026-10-23.
 */
function bucketOf(row: WorkspaceAssetRow): AssetBucket {
  if (row.lifecycleStatus === 'suspended' || row.indexStatus === 'failed') return 'blocked';
  if (row.lifecycleStatus === 'published' && row.indexStatus === 'ready') return 'live';
  if (row.indexStatus === 'processing' || row.indexStatus === 'pending') return 'pending';
  return 'exempt';
}

function toneOf(bucket: AssetBucket): StatusTone {
  return bucket;
}

/** The list's address with these filters; either may be left off. */
function listHref(filter: string | undefined, kind: AssetKind | null): string {
  const params = new URLSearchParams();
  if (filter === 'unfiled') params.set('filter', filter);
  if (kind) params.set('kind', kind);
  const query = params.toString();
  return query ? `/dashboard/assets?${query}` : '/dashboard/assets';
}

/**
 * `?filter=unfiled` keeps the assets in no channel, `?kind=` one asset kind
 * (agent-first-proposal.md 4.4: 全部资产（按类型筛选）、未归入频道的资产);
 * the two combine. Articles and audio episodes are assets like any other:
 * created from the wizard, listed here, opened in their editor.
 */
export default async function DashboardAssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; kind?: string }>;
}) {
  const [session, { locale, t }, query] = await Promise.all([
    requireSession('/dashboard/assets'),
    translations(),
    searchParams,
  ]);
  const l = t.dashboard.assets;
  const m = l.manage;
  const manager = canManageAssets(session.workspace.role);

  const [allAssets, quote] = await Promise.all([
    listWorkspaceAssets(session.workspace.id),
    /* asset-build-billing.md 4.1: the worst case over page-fetching
       sources decides whether the per-row refresh is offered at all. */
    manager ? quoteBuild({ workspaceId: session.workspace.id, fetchesPages: true }) : null,
  ]);
  const kindFilter = isAssetKind(query.kind) ? query.kind : null;
  const assets = allAssets.filter(
    (row) =>
      (query.filter !== 'unfiled' || row.channel === null) && (kindFilter === null || row.kind === kindFilter),
  );
  const kinds = t.channels.kinds as Record<AssetKind, string>;
  const usage = await assetUsageCounts(assets.map((row) => row.id));
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  /* The editor schedules in UTC and says so; the list does too. */
  const scheduledDate = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

  const published = assets.filter(
    (row) => row.lifecycleStatus === 'published' && row.indexStatus === 'ready',
  ).length;
  const totalChunks = assets.reduce((sum, row) => sum + row.totalChunks, 0);

  const stats = [
    { key: 'total', value: number.format(assets.length), label: l.stats.total },
    { key: 'published', value: number.format(published), label: l.stats.published },
    { key: 'chunks', value: number.format(totalChunks), label: l.stats.chunks },
  ];

  /* The label says the specific thing where the tone cannot: paused by the
     owner, suspended by the platform, or a failed build. */
  const statusLabel = (row: WorkspaceAssetRow, bucket: AssetBucket): string => {
    if (bucket === 'blocked') {
      if (row.lifecycleStatus === 'suspended') return row.pausedByOwner ? m.statuses.paused : m.statuses.suspended;
      return m.statuses.failed;
    }
    return l.statuses[bucket];
  };

  const rows: AssetListRow[] = assets.map((row) => {
    /* An article or episode that is not live is a draft, not a build in
       waiting: nothing is queued for it until it is published, perhaps on a
       schedule. Once live it reads like any asset. */
    const editorial = isWizardEditorialKind(row.kind);
    const measured = bucketOf(row);
    const draft = editorial && !row.building && (measured === 'pending' || measured === 'exempt');
    const bucket: AssetBucket = draft ? 'exempt' : measured;
    const scheduled = editorial && row.publishAt
      ? fill(l.editorialStates.scheduled, { date: `${scheduledDate.format(row.publishAt)} UTC` })
      : null;
    /* requirement.md 5.2: an asset in a public channel that is not yet live
       shows where its build stands in the publishing pipeline. */
    const shared = isPublicChannel(row.channel);
    const inPipeline = shared && bucket !== 'live' && row.lifecycleStatus !== 'archived';
    return {
      id: row.id,
      slug: row.publicId,
      title: row.title,
      kindLabel: kinds[row.kind] ?? row.kind,
      href: editorial ? `/dashboard/assets/${row.id}/edit` : `/dashboard/assets/${row.id}`,
      version: row.versionLabel,
      scope: shared ? 'public' : 'private',
      channel: row.channel ? { title: row.channel.title, href: `/dashboard/channels/${row.channel.id}` } : null,
      paid: row.access === 'paid',
      chunks: row.totalChunks,
      calls: usage.get(row.id) ?? { total: 0, thisMonth: 0 },
      status: draft && scheduled ? 'pending' : toneOf(bucket),
      statusLabel: draft ? (scheduled ?? l.editorialStates.draft) : statusLabel(row, bucket),
      bucket,
      updated: row.updatedAt ? date.format(new Date(row.updatedAt)) : '—',
      initial: (row.title.trim()[0] ?? '?').toUpperCase(),
      filesHref: row.hasFiles ? `/dashboard/assets/${row.id}/files` : null,
      filesLabel: row.hasFiles ? (row.sourceType === 'markdown' ? m.filesMarkdown : l.files) : null,
      note: row.reviewNote,
      buildNote: row.building
        ? describeBuild(t.admin.refreshQueue, row.build)
        : draft
          ? null
          : scheduled,
      pipeline: inPipeline
        ? reviewPipeline({
            lifecycleStatus: row.lifecycleStatus,
            indexStatus: row.indexStatus,
            building: row.building,
          })
        : null,
      /* Affordability is said in the refresh confirmation, with the price. */
      /* A draft has nothing to build from; publishing it from the editor is what builds. */
      rebuildDisabled: draft || rebuildBlocked({ lifecycleStatus: row.lifecycleStatus, affordable: undefined }),
    };
  });

  return (
    <div className="flex flex-col gap-[18px]">
      {/* A building row's readout changes by the window; poll while one is open. */}
      <LiveRefresh active={assets.some((row) => row.building)} />
      <PageHeader
        eyebrow={session.workspace.name}
        title={l.title}
        description={l.description}
        action={
          manager ? (
            <ActionButton href="/dashboard/assets/new">
              <PlusIcon size={15} />
              {l.addAsset}
            </ActionButton>
          ) : undefined
        }
      />

      {/* Counters -- design source `fiSE2`. */}
      <section className="grid grid-cols-2 gap-[9px] sm:grid-cols-3">
        {stats.map((stat, index) => {
          const Icon = STAT_ICONS[index] ?? DatabaseIcon;
          return (
            <StatTile key={stat.key} icon={<Icon size={17} />} value={stat.value} label={stat.label} />
          );
        })}
      </section>

      <Notice
        tone="brand"
        icon={<ShieldCheckIcon size={18} />}
        title={l.reviewNotice}
      />

      {/* By kind: links, so the filter is in the address and survives a reload. */}
      <nav aria-label={l.kindsLabel} className="flex flex-wrap gap-0 self-start rounded-md bg-mutedbg p-[3px]">
        {[null, ...ASSET_KINDS].map((kind) => {
          const active = kind === kindFilter;
          return (
            <Link
              key={kind ?? 'all'}
              href={listHref(query.filter, kind)}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex h-[29px] items-center rounded-md px-[9px] text-[11px] transition-colors ${
                active ? 'bg-card text-ink shadow-md' : 'text-muted hover:text-ink'
              }`}
            >
              {kind ? kinds[kind] : l.kindAll}
            </Link>
          );
        })}
      </nav>

      {/* requirement.md 5.2: refresh and deletion are for the asset's
          owner side only; everyone else reads. */}
      <AssetList
        rows={rows}
        deleteAction={canDeleteAssets(session.workspace.role) ? deleteWorkspaceAssetAction : undefined}
        rebuildAction={manager ? rebuildAssetAction : undefined}
        rebuildQuote={quote ?? undefined}
      />

    </div>
  );
}

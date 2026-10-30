import type { Metadata } from 'next';
import { LibraryList, type LibraryBucket, type LibraryListRow } from '@/components/dashboard/library-list';
import { LiveRefresh } from '@/components/dashboard/live-refresh';
import { describeBuild } from '@/lib/dashboard/build-progress';
import {
  ActionButton,
  Notice,
  PageHeader,
  StatTile,
  type StatusTone,
} from '@/components/dashboard/ui';
import {
  BadgeCheckIcon,
  DatabaseIcon,
  FileTextIcon,
  PlusIcon,
  ShieldCheckIcon,
} from '@/components/ui/icons';
import {
  canDeleteLibraries,
  canManageLibraries,
  libraryUsageCounts,
  listWorkspaceLibraries,
  type WorkspaceLibraryRow,
} from '@/lib/application/libraries';
import { isPublicChannel } from '@/lib/application/channels';
import { quoteBuild } from '@/lib/application/plans';
import { rebuildBlocked, reviewPipeline } from '@/lib/domain/library';
import { requireSession } from '@/lib/http/session';
import { getMessages, translations } from '@/lib/i18n/server';
import { deleteWorkspaceLibraryAction } from './actions';
import { rebuildLibraryAction } from './[libraryId]/actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.libraries.title };
}

const STAT_ICONS = [DatabaseIcon, BadgeCheckIcon, FileTextIcon];

/**
 * Lifecycle plus index state collapse to the design's four-way marker: live
 * (published and queryable), pending (still indexing), blocked (suspended
 * or failed), exempt (a draft with nothing queued). Nothing waits for
 * review since 2026-10-23.
 */
function bucketOf(row: WorkspaceLibraryRow): LibraryBucket {
  if (row.lifecycleStatus === 'suspended' || row.indexStatus === 'failed') return 'blocked';
  if (row.lifecycleStatus === 'published' && row.indexStatus === 'ready') return 'live';
  if (row.indexStatus === 'processing' || row.indexStatus === 'pending') return 'pending';
  return 'exempt';
}

function toneOf(bucket: LibraryBucket): StatusTone {
  return bucket;
}

export default async function DashboardLibrariesPage() {
  const [session, { locale, t }] = await Promise.all([
    requireSession('/dashboard/assets'),
    translations(),
  ]);
  const l = t.dashboard.libraries;
  const m = l.manage;
  const manager = canManageLibraries(session.workspace.role);

  const [libraries, quote] = await Promise.all([
    listWorkspaceLibraries(session.workspace.id),
    /* library-build-billing.md 4.1: the worst case over page-fetching
       sources decides whether the per-row refresh is offered at all. */
    manager ? quoteBuild({ workspaceId: session.workspace.id, fetchesPages: true }) : null,
  ]);
  const usage = await libraryUsageCounts(libraries.map((row) => row.id));
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  const published = libraries.filter(
    (row) => row.lifecycleStatus === 'published' && row.indexStatus === 'ready',
  ).length;
  const totalChunks = libraries.reduce((sum, row) => sum + row.totalChunks, 0);

  const stats = [
    { key: 'total', value: number.format(libraries.length), label: l.stats.total },
    { key: 'published', value: number.format(published), label: l.stats.published },
    { key: 'chunks', value: number.format(totalChunks), label: l.stats.chunks },
  ];

  /* The label says the specific thing where the tone cannot: paused by the
     owner, suspended by the platform, or a failed build. */
  const statusLabel = (row: WorkspaceLibraryRow, bucket: LibraryBucket): string => {
    if (bucket === 'blocked') {
      if (row.lifecycleStatus === 'suspended') return row.pausedByOwner ? m.statuses.paused : m.statuses.suspended;
      return m.statuses.failed;
    }
    return l.statuses[bucket];
  };

  const rows: LibraryListRow[] = libraries.map((row) => {
    const bucket = bucketOf(row);
    /* requirement.md 5.2: an asset in a public channel that is not yet live
       shows where its build stands in the publishing pipeline. */
    const shared = isPublicChannel(row.channel);
    const inPipeline = shared && bucket !== 'live' && row.lifecycleStatus !== 'archived';
    return {
      id: row.id,
      slug: row.publicId,
      title: row.title,
      version: row.versionLabel,
      scope: shared ? 'public' : 'private',
      channel: row.channel ? { title: row.channel.title, href: `/dashboard/channels/${row.channel.id}` } : null,
      chunks: row.totalChunks,
      calls: usage.get(row.id) ?? { total: 0, thisMonth: 0 },
      status: toneOf(bucket),
      statusLabel: statusLabel(row, bucket),
      bucket,
      updated: row.updatedAt ? date.format(new Date(row.updatedAt)) : '—',
      initial: (row.title.trim()[0] ?? '?').toUpperCase(),
      filesHref: row.hasFiles ? `/dashboard/assets/${row.id}/files` : null,
      filesLabel: row.hasFiles ? (row.sourceType === 'markdown' ? m.filesMarkdown : l.files) : null,
      note: row.reviewNote,
      buildNote: row.building ? describeBuild(t.admin.refreshQueue, row.build) : null,
      pipeline: inPipeline
        ? reviewPipeline({
            lifecycleStatus: row.lifecycleStatus,
            indexStatus: row.indexStatus,
            building: row.building,
          })
        : null,
      /* Affordability is said in the refresh confirmation, with the price. */
      rebuildDisabled: rebuildBlocked({ lifecycleStatus: row.lifecycleStatus, affordable: undefined }),
    };
  });

  return (
    <div className="flex flex-col gap-[18px]">
      {/* A building row's readout changes by the window; poll while one is open. */}
      <LiveRefresh active={libraries.some((row) => row.building)} />
      <PageHeader
        eyebrow={session.workspace.name}
        title={l.title}
        description={l.description}
        action={
          manager ? (
            <ActionButton href="/dashboard/assets/new">
              <PlusIcon size={15} />
              {l.addLibrary}
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

      {/* requirement.md 5.2: refresh and deletion are for the library's
          owner side only; everyone else reads. */}
      <LibraryList
        rows={rows}
        deleteAction={canDeleteLibraries(session.workspace.role) ? deleteWorkspaceLibraryAction : undefined}
        rebuildAction={manager ? rebuildLibraryAction : undefined}
        rebuildQuote={quote ?? undefined}
      />

    </div>
  );
}

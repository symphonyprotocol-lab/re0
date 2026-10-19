import type { Metadata } from 'next';
import { LibraryList, type LibraryBucket, type LibraryListRow } from '@/components/dashboard/library-list';
import { LiveRefresh } from '@/components/dashboard/live-refresh';
import { describeBuild } from '@/lib/dashboard/build-progress';
import {
  LibraryOwnership,
  type LibraryOwnershipRow,
} from '@/components/dashboard/library-ownership';
import {
  ActionButton,
  Notice,
  PageHeader,
  StatTile,
  type StatusTone,
} from '@/components/dashboard/ui';
import {
  BadgeCheckIcon,
  ClockIcon,
  DatabaseIcon,
  FileTextIcon,
  PlusIcon,
  ShieldCheckIcon,
} from '@/components/ui/icons';
import { listWorkspaceClaims, ownershipForLibraries } from '@/lib/application/claims';
import {
  canDeleteLibraries,
  canManageLibraries,
  listWorkspaceLibraries,
  type WorkspaceLibraryRow,
} from '@/lib/application/libraries';
import { quoteBuild } from '@/lib/application/plans';
import { remainingDays } from '@/lib/domain/claim';
import { rebuildBlocked, reviewPipeline } from '@/lib/domain/library';
import { requireSession } from '@/lib/http/session';
import { getMessages, translations } from '@/lib/i18n/server';
import { deleteWorkspaceLibraryAction, releaseLibraryOwnershipAction } from './actions';
import { rebuildLibraryAction } from './[libraryId]/actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.libraries.title };
}

const STAT_ICONS = [DatabaseIcon, BadgeCheckIcon, ClockIcon, FileTextIcon];

/**
 * Lifecycle plus index state collapse to the design's four-way marker: live
 * (published and queryable), pending (anywhere in review or still indexing),
 * blocked (suspended, rejected or failed), exempt (a private draft that never
 * enters review). The bucket keeps `changes_requested` apart from the rest
 * of `blocked`, because it has a filter of its own (requirement.md 5.2).
 */
function bucketOf(row: WorkspaceLibraryRow): LibraryBucket {
  if (row.lifecycleStatus === 'changes_requested') return 'changes';
  if (row.lifecycleStatus === 'suspended' || row.indexStatus === 'failed') return 'blocked';
  if (row.lifecycleStatus === 'published' && row.indexStatus === 'ready') return 'live';
  if (
    row.lifecycleStatus === 'submitted' ||
    row.lifecycleStatus === 'reviewing' ||
    row.indexStatus === 'processing' ||
    row.indexStatus === 'pending'
  ) {
    return 'pending';
  }
  return 'exempt';
}

function toneOf(bucket: LibraryBucket): StatusTone {
  return bucket === 'changes' ? 'blocked' : bucket;
}

export default async function DashboardLibrariesPage() {
  const [session, { locale, t }] = await Promise.all([
    requireSession('/dashboard/libraries'),
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
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  const published = libraries.filter(
    (row) => row.lifecycleStatus === 'published' && row.indexStatus === 'ready',
  ).length;
  const inReview = libraries.filter(
    (row) => row.lifecycleStatus === 'submitted' || row.lifecycleStatus === 'reviewing',
  ).length;
  const totalChunks = libraries.reduce((sum, row) => sum + row.totalChunks, 0);

  const stats = [
    { key: 'total', value: number.format(libraries.length), label: l.stats.total },
    { key: 'published', value: number.format(published), label: l.stats.published },
    { key: 'review', value: number.format(inReview), label: l.stats.review },
    { key: 'chunks', value: number.format(totalChunks), label: l.stats.chunks },
  ];

  /* The label says the specific thing where the tone cannot: sent back,
     paused by the owner, suspended by a reviewer, or a failed build. */
  const statusLabel = (row: WorkspaceLibraryRow, bucket: LibraryBucket): string => {
    if (bucket === 'changes') return m.statuses.changes;
    if (bucket === 'blocked') {
      if (row.lifecycleStatus === 'suspended') return row.pausedByOwner ? m.statuses.paused : m.statuses.suspended;
      return m.statuses.failed;
    }
    return l.statuses[bucket];
  };

  const rows: LibraryListRow[] = libraries.map((row) => {
    const bucket = bucketOf(row);
    /* requirement.md 5.2: every public library that is not yet live shows
       where it is in the publishing pipeline. */
    const inPipeline =
      row.visibility === 'public' && bucket !== 'live' && row.lifecycleStatus !== 'archived';
    return {
      id: row.id,
      slug: row.publicId,
      title: row.title,
      version: row.versionLabel,
      scope: row.visibility,
      chunks: row.totalChunks,
      status: toneOf(bucket),
      statusLabel: statusLabel(row, bucket),
      bucket,
      updated: row.updatedAt ? date.format(new Date(row.updatedAt)) : '—',
      initial: (row.title.trim()[0] ?? '?').toUpperCase(),
      filesHref: row.hasFiles ? `/dashboard/libraries/${row.id}/files` : null,
      filesLabel: row.hasFiles ? (row.sourceType === 'markdown' ? m.filesMarkdown : l.files) : null,
      note: row.reviewNote,
      buildNote: row.building ? describeBuild(t.admin.refreshQueue, row.build) : null,
      pipeline: inPipeline
        ? reviewPipeline({
            visibility: row.visibility,
            lifecycleStatus: row.lifecycleStatus,
            indexStatus: row.indexStatus,
            building: row.building,
          })
        : null,
      /* Affordability is said in the refresh confirmation, with the price. */
      rebuildDisabled: rebuildBlocked({ lifecycleStatus: row.lifecycleStatus, affordable: undefined }),
    };
  });

  /*
   * requirement.md 5.2: the list says where each public library stands with
   * this workspace. Ownership is a claim fact, not a library column, so it is
   * read through the claim use cases and rendered in its own panel.
   *
   * Two reads, because the panel's five states live in two places.
   * `listWorkspaceLibraries` is scoped to `owner_workspace_id`, so what it can
   * say is only `owned` or `claimed`; a claim still running, one that failed,
   * and a library back in the unowned pool are all on libraries this workspace
   * does not own, and only its claims know about them. Reading just the first
   * left three of the five states unreachable and `disputed` hardcoded false.
   */
  const publicLibraries = libraries.filter((row) => row.visibility === 'public');
  const [ownership, claims] = await Promise.all([
    ownershipForLibraries(session.workspace.id, publicLibraries.map((row) => row.id)),
    listWorkspaceClaims(session.workspace.id),
  ]);
  const now = new Date();
  const ownershipRows: LibraryOwnershipRow[] = publicLibraries.map((row) => {
    const view = ownership.get(row.id) ?? { kind: 'unclaimed' as const };
    return {
      id: row.id,
      publicId: row.publicId,
      title: row.title,
      kind: view.kind,
      claimedAt: view.kind === 'claimed' && view.claimedAt ? date.format(view.claimedAt) : null,
      remainingDays: view.kind === 'pending' ? remainingDays(view.expiresAt, now) : null,
      failureReason: view.kind === 'failed' ? view.failureReason : null,
      claimId: view.kind === 'pending' || view.kind === 'failed' ? view.claimId : null,
      /* We own these, so no other workspace's ownership is in the way. */
      disputed: false,
    };
  });

  /*
   * The claims on libraries we do not own, newest first, one row per library.
   * A settled claim -- expired or revoked -- leaves the library claimable
   * again, which is what `unclaimed` offers; a verified one on a library the
   * owner-scoped list did not return means ownership moved on, and there is
   * nothing here for this workspace to do about it.
   */
  const owned = new Set(libraries.map((row) => row.id));
  const seen = new Set<string>();
  for (const claim of claims) {
    if (owned.has(claim.libraryId) || seen.has(claim.libraryId)) continue;
    seen.add(claim.libraryId);
    if (claim.status === 'verified') continue;
    ownershipRows.push({
      id: claim.libraryId,
      publicId: claim.libraryPublicId,
      title: claim.libraryTitle,
      kind:
        claim.status === 'pending' ? 'pending' : claim.status === 'failed' ? 'failed' : 'unclaimed',
      claimedAt: null,
      remainingDays: claim.status === 'pending' ? remainingDays(claim.expiresAt, now) : null,
      failureReason: claim.status === 'failed' ? claim.failureReason : null,
      claimId: claim.id,
      disputed: claim.disputed,
    });
  }

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
            <ActionButton href="/dashboard/libraries/new">
              <PlusIcon size={15} />
              {l.addLibrary}
            </ActionButton>
          ) : undefined
        }
      />

      {/* Counters -- design source `fiSE2`. */}
      <section className="grid grid-cols-2 gap-[9px] sm:grid-cols-4">
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
        title={l.reviewNoticeTitle}
        body={l.reviewNoticeBody}
      />

      {/* requirement.md 5.2: refresh and deletion are for the library's
          owner side only; everyone else reads. */}
      <LibraryList
        rows={rows}
        deleteAction={canDeleteLibraries(session.workspace.role) ? deleteWorkspaceLibraryAction : undefined}
        rebuildAction={manager ? rebuildLibraryAction : undefined}
        rebuildQuote={quote ?? undefined}
      />

      <LibraryOwnership
        rows={ownershipRows}
        releaseAction={
          canDeleteLibraries(session.workspace.role) ? releaseLibraryOwnershipAction : undefined
        }
      />
    </div>
  );
}

/**
 * A workspace's own libraries, for the dashboard. Read-only projections of
 * rows other flows own: creation goes through the import wizard, review
 * through the console, refresh through the workflow queue.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BuildProgress, IngestionStage } from '@/lib/domain/ingestion';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import type { LifecycleStatus, IndexStatus, Visibility } from '@/lib/domain';
import { isOwnerPause, UPLOAD_SOURCE_TYPES } from '@/lib/domain/library';

export interface WorkspaceLibraryRow {
  id: string;
  publicId: string;
  title: string;
  visibility: Visibility;
  lifecycleStatus: LifecycleStatus;
  indexStatus: IndexStatus;
  versionLabel: string | null;
  totalChunks: number;
  storageBytes: number;
  updatedAt: string | null;
  /** True for a library whose source is uploaded files, which has a files page. */
  hasFiles: boolean;
  /** The source's type, for the label of that page; null for a library with no source. */
  sourceType: string | null;
  /** The latest reviewer's note, when the library is waiting on the owner. */
  reviewNote: string | null;
  /** A build is pending or running right now. */
  building: boolean;
  /** Where the running build is (lib/domain/ingestion.ts `BuildProgress`); null while pending or idle. */
  build: { stage: IngestionStage | null; progress: BuildProgress | null } | null;
  /** True when the library is suspended by its owner's own pause, which the owner may lift. */
  pausedByOwner: boolean;
  /** Carries the expert-library tag (expert-library-prd.md 4.3), whether or not it is earning right now. */
  expert: boolean;
}

export async function listWorkspaceLibraries(workspaceId: string): Promise<WorkspaceLibraryRow[]> {
  const rows = await db()
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      title: schema.library.title,
      visibility: schema.library.visibility,
      lifecycleStatus: schema.library.lifecycleStatus,
      indexStatus: schema.library.indexStatus,
      storageBytes: schema.library.storageBytes,
      expertTaggedAt: schema.library.expertTaggedAt,
      lastSuccessfulRefreshAt: schema.library.lastSuccessfulRefreshAt,
      createdAt: schema.library.createdAt,
      versionLabel: schema.libraryVersion.label,
      totalChunks: schema.libraryVersion.totalChunks,
    })
    .from(schema.library)
    .leftJoin(schema.libraryVersion, eq(schema.libraryVersion.id, schema.library.currentVersionId))
    .where(OWNED_AND_LIVE(workspaceId))
    .orderBy(desc(schema.library.createdAt));

  /* The latest review row of each library that is sent back or suspended:
     the note is what the owner has to act on, and the row's stage says
     whether a suspension is the owner's own pause (`isOwnerPause`). */
  const blocked = rows.filter(
    (row) => row.lifecycleStatus === 'changes_requested' || row.lifecycleStatus === 'suspended',
  );
  const notes = new Map<string, string>();
  const ownerPaused = new Set<string>();
  if (blocked.length > 0) {
    const reviews = await db()
      .select({
        libraryId: schema.libraryReview.libraryId,
        stage: schema.libraryReview.stage,
        outcome: schema.libraryReview.outcome,
        feedback: schema.libraryReview.feedback,
      })
      .from(schema.libraryReview)
      .where(
        inArray(
          schema.libraryReview.libraryId,
          blocked.map((row) => row.id),
        ),
      )
      .orderBy(desc(schema.libraryReview.createdAt));
    const latest = new Set<string>();
    for (const review of reviews) {
      if (!latest.has(review.libraryId)) {
        latest.add(review.libraryId);
        if (isOwnerPause(review)) ownerPaused.add(review.libraryId);
      }
      if (!notes.has(review.libraryId) && review.feedback[0]) notes.set(review.libraryId, review.feedback[0]);
    }
  }

  const openOperations =
    rows.length === 0
      ? []
      : await db()
          .select({
            libraryId: schema.workflowOperation.libraryId,
            status: schema.workflowOperation.status,
            stage: schema.workflowOperation.stage,
            progress: schema.workflowOperation.progress,
          })
          .from(schema.workflowOperation)
          .where(
            and(
              inArray(schema.workflowOperation.operationType, ['ingest', 'refresh']),
              inArray(schema.workflowOperation.status, ['pending', 'running']),
              inArray(
                schema.workflowOperation.libraryId,
                rows.map((row) => row.id),
              ),
            ),
          );
  const building = new Set(openOperations.map((operation) => operation.libraryId));
  /* The running one's readout; a library with only a pending build has none yet. */
  const builds = new Map<string, WorkspaceLibraryRow['build']>();
  for (const operation of openOperations) {
    if (operation.status === 'running' && operation.libraryId) {
      builds.set(operation.libraryId, {
        stage: (operation.stage as IngestionStage | null) ?? null,
        progress: operation.progress ?? null,
      });
    }
  }

  const sourceTypes = new Map<string, string>();
  if (rows.length > 0) {
    const sources = await db()
      .select({ libraryId: schema.source.libraryId, type: schema.source.type })
      .from(schema.source)
      .where(
        inArray(
          schema.source.libraryId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(schema.source.id);
    for (const source of sources) {
      if (!sourceTypes.has(source.libraryId)) sourceTypes.set(source.libraryId, source.type);
    }
  }
  const uploadTypes: readonly string[] = UPLOAD_SOURCE_TYPES;

  return rows.map((row) => ({
    id: row.id,
    publicId: row.publicId,
    title: row.title,
    visibility: row.visibility,
    lifecycleStatus: row.lifecycleStatus,
    indexStatus: row.indexStatus,
    versionLabel: row.versionLabel,
    totalChunks: row.totalChunks ?? 0,
    storageBytes: row.storageBytes,
    updatedAt: (row.lastSuccessfulRefreshAt ?? row.createdAt)?.toISOString() ?? null,
    hasFiles: uploadTypes.includes(sourceTypes.get(row.id) ?? ''),
    sourceType: sourceTypes.get(row.id) ?? null,
    reviewNote: notes.get(row.id) ?? null,
    building: building.has(row.id),
    build: builds.get(row.id) ?? null,
    pausedByOwner: row.lifecycleStatus === 'suspended' && ownerPaused.has(row.id),
    expert: row.expertTaggedAt !== null,
  }));
}

/**
 * The workspace's libraries that still exist. A deleted one is a tombstone
 * (`deleted_at`), kept for billing history and shown nowhere -- and its
 * bytes no longer count against the workspace's storage.
 */
const OWNED_AND_LIVE = (workspaceId: string) =>
  and(eq(schema.library.ownerWorkspaceId, workspaceId), isNull(schema.library.deletedAt));

export async function countWorkspaceLibraries(workspaceId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.library)
    .where(OWNED_AND_LIVE(workspaceId));
  return row?.n ?? 0;
}



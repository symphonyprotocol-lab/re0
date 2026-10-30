/**
 * A workspace's own assets, for the dashboard. Read-only projections of
 * rows other flows own: creation goes through the import wizard, review
 * through the console, refresh through the workflow queue.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { BuildProgress, IngestionStage } from '@/lib/domain/ingestion';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import type { LifecycleStatus, IndexStatus } from '@/lib/domain';
import type { AssetAccess, AssetKind } from '@/lib/domain/asset-kind';
import { channelsOfAssets, type ChannelRef } from '@/lib/application/channels/membership';
import { isOwnerPause, UPLOAD_SOURCE_TYPES } from '@/lib/domain/asset';

export interface WorkspaceAssetRow {
  id: string;
  publicId: string;
  title: string;
  kind: AssetKind;
  access: AssetAccess;
  /** The channel the asset is in; null when it is in none and so only the owner's. */
  channel: ChannelRef | null;
  lifecycleStatus: LifecycleStatus;
  indexStatus: IndexStatus;
  versionLabel: string | null;
  totalChunks: number;
  storageBytes: number;
  updatedAt: string | null;
  /** True for an asset whose source is uploaded files, which has a files page. */
  hasFiles: boolean;
  /** The source's type, for the label of that page; null for an asset with no source. */
  sourceType: string | null;
  /** The latest reviewer's note, when the asset is suspended. */
  reviewNote: string | null;
  /** A build is pending or running right now. */
  building: boolean;
  /** Where the running build is (lib/domain/ingestion.ts `BuildProgress`); null while pending or idle. */
  build: { stage: IngestionStage | null; progress: BuildProgress | null } | null;
  /** True when the asset is suspended by its owner's own pause, which the owner may lift. */
  pausedByOwner: boolean;
  /** An article's or episode's scheduled publication (its `post_draft`); null for every other kind. */
  publishAt: Date | null;
}

export async function listWorkspaceAssets(workspaceId: string): Promise<WorkspaceAssetRow[]> {
  const rows = await db()
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      kind: schema.asset.kind,
      access: schema.asset.access,
      lifecycleStatus: schema.asset.lifecycleStatus,
      indexStatus: schema.asset.indexStatus,
      storageBytes: schema.asset.storageBytes,
      lastSuccessfulRefreshAt: schema.asset.lastSuccessfulRefreshAt,
      createdAt: schema.asset.createdAt,
      versionLabel: schema.assetVersion.label,
      totalChunks: schema.assetVersion.totalChunks,
      publishAt: schema.postDraft.publishAt,
    })
    .from(schema.asset)
    .leftJoin(schema.assetVersion, eq(schema.assetVersion.id, schema.asset.currentVersionId))
    .leftJoin(schema.postDraft, eq(schema.postDraft.assetId, schema.asset.id))
    .where(OWNED_AND_LIVE(workspaceId))
    .orderBy(desc(schema.asset.createdAt));

  /* The latest review row of each asset that is sent back or suspended:
     the note is what the owner has to act on, and the row's stage says
     whether a suspension is the owner's own pause (`isOwnerPause`). */
  const blocked = rows.filter((row) => row.lifecycleStatus === 'suspended');
  const channels = await channelsOfAssets(rows.map((row) => row.id));
  const notes = new Map<string, string>();
  const ownerPaused = new Set<string>();
  if (blocked.length > 0) {
    const reviews = await db()
      .select({
        assetId: schema.assetReview.assetId,
        stage: schema.assetReview.stage,
        outcome: schema.assetReview.outcome,
        feedback: schema.assetReview.feedback,
      })
      .from(schema.assetReview)
      .where(
        inArray(
          schema.assetReview.assetId,
          blocked.map((row) => row.id),
        ),
      )
      .orderBy(desc(schema.assetReview.createdAt));
    const latest = new Set<string>();
    for (const review of reviews) {
      if (!latest.has(review.assetId)) {
        latest.add(review.assetId);
        if (isOwnerPause(review)) ownerPaused.add(review.assetId);
      }
      if (!notes.has(review.assetId) && review.feedback[0]) notes.set(review.assetId, review.feedback[0]);
    }
  }

  const openOperations =
    rows.length === 0
      ? []
      : await db()
          .select({
            assetId: schema.workflowOperation.assetId,
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
                schema.workflowOperation.assetId,
                rows.map((row) => row.id),
              ),
            ),
          );
  const building = new Set(openOperations.map((operation) => operation.assetId));
  /* The running one's readout; an asset with only a pending build has none yet. */
  const builds = new Map<string, WorkspaceAssetRow['build']>();
  for (const operation of openOperations) {
    if (operation.status === 'running' && operation.assetId) {
      builds.set(operation.assetId, {
        stage: (operation.stage as IngestionStage | null) ?? null,
        progress: operation.progress ?? null,
      });
    }
  }

  const sourceTypes = new Map<string, string>();
  if (rows.length > 0) {
    const sources = await db()
      .select({ assetId: schema.source.assetId, type: schema.source.type })
      .from(schema.source)
      .where(
        inArray(
          schema.source.assetId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(schema.source.id);
    for (const source of sources) {
      if (!sourceTypes.has(source.assetId)) sourceTypes.set(source.assetId, source.type);
    }
  }
  const uploadTypes: readonly string[] = UPLOAD_SOURCE_TYPES;

  return rows.map((row) => ({
    id: row.id,
    publicId: row.publicId,
    title: row.title,
    kind: row.kind,
    access: row.access,
    channel: channels.get(row.id) ?? null,
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
    publishAt: row.publishAt,
  }));
}

/**
 * The workspace's assets that still exist. A deleted one is a tombstone
 * (`deleted_at`), kept for billing history and shown nowhere -- and its
 * bytes no longer count against the workspace's storage.
 */
const OWNED_AND_LIVE = (workspaceId: string) =>
  and(eq(schema.asset.ownerWorkspaceId, workspaceId), isNull(schema.asset.deletedAt));

export async function countWorkspaceAssets(workspaceId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.asset)
    .where(OWNED_AND_LIVE(workspaceId));
  return row?.n ?? 0;
}



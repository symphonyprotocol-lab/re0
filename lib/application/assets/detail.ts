/**
 * One of a workspace's own assets, in full, for the dashboard.
 *
 * The list answers "which assets do I have"; this answers the questions
 * the list cannot: is it ready to query, what is the current version, what
 * is queued or failed, and what the platform said about it. Read-only, like the
 * list -- the verbs live in their own modules (`rebuild.ts`, `files.ts`,
 * `delete.ts`). An asset this workspace does not own is null, the same as
 * one that does not exist (architecture.md 5.2).
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { isQueryable, type IndexStatus, type LifecycleStatus } from '@/lib/domain';
import type { AssetAccess, AssetKind } from '@/lib/domain/asset-kind';
import { channelsOfAssets, type ChannelRef } from '@/lib/application/channels/membership';
import { ref } from '@/lib/application/administration/column-ref';
import {
  isOwnerPause,
  isRefreshPolicy,
  isUploadSourceType,
  parseScopeOf,
  uploadedFilesOf,
  type ParseScope,
  type RefreshPolicy,
} from '@/lib/domain/asset';
import { BUILD_ENTRYPOINT } from '@/lib/domain/build-billing';
import type { BuildProgress, IngestionStage } from '@/lib/domain/ingestion';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { assetMaterials, type AssetMaterials } from './materials';

const HISTORY_LIMIT = 10;

export interface WorkspaceAssetDetail {
  id: string;
  publicId: string;
  title: string;
  description: string | null;
  language: string | null;
  kind: AssetKind;
  access: AssetAccess;
  /** The channel the asset is in; null when it is in none and so only the owner's. */
  channel: ChannelRef | null;
  lifecycleStatus: LifecycleStatus;
  indexStatus: IndexStatus;
  storageBytes: number;
  createdAt: string;
  lastSuccessfulRefreshAt: string | null;
  lastCheckedAt: string | null;
  /** requirement.md 6.2: published and the current version ready. */
  queryable: boolean;
  /** A build is pending or running right now. */
  building: boolean;
  /** Where the running build is (lib/domain/ingestion.ts `BuildProgress`); null while pending or idle. */
  build: { stage: IngestionStage | null; progress: BuildProgress | null } | null;
  currentVersion: { label: string; documents: number; chunks: number; publishedAt: string | null } | null;
  source: {
    type: string;
    location: string;
    fileCount: number | null;
    /** The owner's parse scope, as stored on the source (requirement.md 7.2 names). */
    scope: ParseScope;
    /** The stored cadence; null when the source has none or it is unreadable. */
    refreshPolicy: RefreshPolicy | null;
  } | null;
  /** The current version is indexed. */
  hasReadyVersion: boolean;
  /** True when the asset is suspended by its owner's own pause. */
  pausedByOwner: boolean;
  /** The rights declaration and the question set (lib/application/assets/materials.ts). */
  materials: AssetMaterials;
  versions: {
    id: string;
    label: string;
    indexStatus: string;
    documents: number;
    chunks: number;
    publishedAt: string | null;
    createdAt: string;
    isCurrent: boolean;
    /** Calls the build was billed (asset-build-billing.md 8); null when it was nobody's bill. */
    buildCalls: number | null;
  }[];
  operations: {
    id: string;
    operationType: string;
    status: string;
    attempts: number;
    error: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
  /** The owner's pauses and the platform's suspensions, newest first; older rows from the review era read too. */
  reviews: {
    id: string;
    stage: string;
    outcome: string | null;
    feedback: string[];
    decidedAt: string | null;
  }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function workspaceAssetDetail(input: {
  workspaceId: string;
  assetId: string;
}): Promise<WorkspaceAssetDetail | null> {
  if (!UUID.test(input.assetId)) return null;
  const database = db();
  const [record] = await database
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      description: schema.asset.description,
      language: schema.asset.language,
      kind: schema.asset.kind,
      access: schema.asset.access,
      lifecycleStatus: schema.asset.lifecycleStatus,
      indexStatus: schema.asset.indexStatus,
      storageBytes: schema.asset.storageBytes,
      createdAt: schema.asset.createdAt,
      lastSuccessfulRefreshAt: schema.asset.lastSuccessfulRefreshAt,
      lastCheckedAt: schema.asset.lastCheckedAt,
      currentVersionId: schema.asset.currentVersionId,
    })
    .from(schema.asset)
    .where(
      and(
        eq(schema.asset.id, input.assetId),
        eq(schema.asset.ownerWorkspaceId, input.workspaceId),
        isNull(schema.asset.deletedAt),
      ),
    )
    .limit(1);
  if (!record) return null;

  /* `ref` keeps the outer column qualified inside the correlated subquery;
     a bare column in a single-table select resolves against the inner FROM
     and counts nothing (column-ref.ts). */
  const documents = sql<number>`(
    select count(*)::int from ${schema.document}
    where ${ref(schema.document.versionId)} = ${ref(schema.assetVersion.id)}
  )`;

  const [sources, versions, operations, reviews, [open]] = await Promise.all([
    database
      .select({
        type: schema.source.type,
        location: schema.source.location,
        config: schema.source.config,
        refreshPolicy: schema.source.refreshPolicy,
      })
      .from(schema.source)
      .where(eq(schema.source.assetId, record.id))
      .orderBy(schema.source.id)
      .limit(1),
    database
      .select({
        id: schema.assetVersion.id,
        label: schema.assetVersion.label,
        indexStatus: schema.assetVersion.indexStatus,
        chunks: schema.assetVersion.totalChunks,
        publishedAt: schema.assetVersion.publishedAt,
        createdAt: schema.assetVersion.createdAt,
        documents,
        buildCalls: sql<number | null>`(
          select ${schema.usageEvent.calls} from ${schema.usageEvent}
          where ${ref(schema.usageEvent.versionId)} = ${ref(schema.assetVersion.id)}
            and ${ref(schema.usageEvent.entrypoint)} = ${BUILD_ENTRYPOINT}
          limit 1
        )`,
      })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.assetId, record.id))
      .orderBy(desc(schema.assetVersion.createdAt))
      .limit(HISTORY_LIMIT),
    database
      .select({
        id: schema.workflowOperation.id,
        operationType: schema.workflowOperation.operationType,
        status: schema.workflowOperation.status,
        attempts: schema.workflowOperation.attempts,
        error: schema.workflowOperation.error,
        createdAt: schema.workflowOperation.createdAt,
        updatedAt: schema.workflowOperation.updatedAt,
      })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.assetId, record.id))
      .orderBy(desc(schema.workflowOperation.createdAt))
      .limit(HISTORY_LIMIT),
    database
      .select({
        id: schema.assetReview.id,
        stage: schema.assetReview.stage,
        outcome: schema.assetReview.outcome,
        appealOf: schema.assetReview.appealOf,
        feedback: schema.assetReview.feedback,
        checklist: schema.assetReview.checklist,
        decidedAt: schema.assetReview.decidedAt,
      })
      .from(schema.assetReview)
      .where(eq(schema.assetReview.assetId, record.id))
      .orderBy(desc(schema.assetReview.createdAt))
      .limit(HISTORY_LIMIT),
    database
      .select({
        id: schema.workflowOperation.id,
        status: schema.workflowOperation.status,
        stage: schema.workflowOperation.stage,
        progress: schema.workflowOperation.progress,
      })
      .from(schema.workflowOperation)
      .where(
        and(
          eq(schema.workflowOperation.assetId, record.id),
          inArray(schema.workflowOperation.operationType, ['ingest', 'refresh']),
          inArray(schema.workflowOperation.status, ['pending', 'running']),
        ),
      )
      /* The running one first, when a retry is queued behind it. */
      .orderBy(desc(schema.workflowOperation.status))
      .limit(1),
  ]);

  const iso = (value: Date | null) => value?.toISOString() ?? null;
  const current = versions.find((version) => version.id === record.currentVersionId) ?? null;
  const source = sources[0] ?? null;
  const cadence = source?.refreshPolicy.cadence;

  return {
    id: record.id,
    publicId: record.publicId,
    title: record.title,
    description: record.description,
    language: record.language,
    kind: record.kind,
    access: record.access,
    channel: (await channelsOfAssets([record.id], database)).get(record.id) ?? null,
    lifecycleStatus: record.lifecycleStatus,
    indexStatus: record.indexStatus,
    storageBytes: record.storageBytes,
    createdAt: record.createdAt.toISOString(),
    lastSuccessfulRefreshAt: iso(record.lastSuccessfulRefreshAt),
    lastCheckedAt: iso(record.lastCheckedAt),
    queryable: isQueryable(record),
    building: open !== undefined,
    build:
      open && open.status === 'running'
        ? { stage: (open.stage as IngestionStage | null) ?? null, progress: open.progress ?? null }
        : null,
    currentVersion: current
      ? { label: current.label, documents: current.documents, chunks: current.chunks, publishedAt: iso(current.publishedAt) }
      : null,
    source: source
      ? {
          type: source.type,
          location: source.location,
          fileCount: isUploadSourceType(source.type) ? uploadedFilesOf(source.config).length : null,
          scope: parseScopeOf(source.config),
          refreshPolicy: isRefreshPolicy(cadence) ? cadence : null,
        }
      : null,
    hasReadyVersion: current?.indexStatus === 'ready',
    pausedByOwner: record.lifecycleStatus === 'suspended' && isOwnerPause(reviews[0]),
    materials: await assetMaterials(database, record.id),
    versions: versions.map((version) => ({
      id: version.id,
      label: version.label,
      indexStatus: version.indexStatus,
      documents: version.documents,
      chunks: version.chunks,
      publishedAt: iso(version.publishedAt),
      createdAt: version.createdAt.toISOString(),
      isCurrent: version.id === record.currentVersionId,
      buildCalls: version.buildCalls === null ? null : Number(version.buildCalls),
    })),
    operations: operations.map((operation) => ({
      ...operation,
      createdAt: operation.createdAt.toISOString(),
      updatedAt: operation.updatedAt.toISOString(),
    })),
    reviews: reviews.map((review) => ({
      id: review.id,
      stage: review.stage,
      outcome: review.outcome,
      feedback: review.feedback,
      decidedAt: iso(review.decidedAt),
    })),
  };
}

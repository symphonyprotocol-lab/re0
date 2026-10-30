/**
 * The platform's side of a user asset. requirement.md 5.3 and 7.4.
 *
 * Since 2026-10-23 a user asset publishes when its build lands, under
 * either visibility; what the console keeps is the compliance hand over
 * content that is live: a suspension (`reject`) and its lifting
 * (`approve`), each with a reason, decided by the domain rule
 * (`reviewActionAvailable`).
 *
 * Every decision writes two rows: a `asset_review` entry, which is the
 * note the owner reads on their dashboard, and an audit entry, which is
 * the record requirement.md 7.4 demands of every such action. The
 * lifecycle update is guarded on the status it was read at, so two
 * administrators deciding the same asset at once cannot both succeed.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { normalizeReason } from '@/lib/domain/admin';
import { uuidv7 } from '@/lib/domain/id';
import type { IndexStatus, LifecycleStatus } from '@/lib/domain';
import {
  PlatformAssetRefused,
  reviewActionAvailable,
  reviewTarget,
  type UserReviewAction,
} from '@/lib/domain/asset';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { exposure } from '@/lib/application/channels/visibility';
import { assetMaterials, type AssetMaterials } from '@/lib/application/assets/materials';
import { recordAudit } from './audit';
import { ref } from './column-ref';
import type { PlatformActor } from './manage-platform-assets';

const AUDIT_TARGET = 'user_library';
const DETAIL_LIMIT = 20;

/** `asset_review.stage` of a decision a person made in the console. */
export const MANUAL_REVIEW_STAGE = 'manual';

export interface UserAssetReviewView {
  id: string;
  /** `manual`, the owner's `owner`; older rows carry the review era's `rules`, `model` and `sample`. */
  stage: string;
  outcome: string | null;
  feedback: string[];
  reviewerEmail: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface UserAssetDetail {
  id: string;
  publicId: string;
  title: string;
  description: string | null;
  language: string | null;
  /** Listed in a public channel or not (channels/visibility.ts `exposure`). */
  visibility: 'public' | 'private';
  lifecycleStatus: LifecycleStatus;
  indexStatus: IndexStatus;
  storageBytes: number;
  createdAt: Date;
  lastSyncedAt: Date | null;
  ownerWorkspaceId: string | null;
  ownerName: string | null;
  currentVersionLabel: string | null;
  hasReadyVersion: boolean;
  documents: number;
  chunks: number;
  sources: { id: string; type: string; location: string; fileCount: number | null }[];
  versions: {
    id: string;
    label: string;
    indexStatus: string;
    documents: number;
    totalChunks: number;
    publishedAt: Date | null;
    createdAt: Date;
    isCurrent: boolean;
  }[];
  reviews: UserAssetReviewView[];
  /** The owner's declaration and question set (review-visibility-proposal.md 5). */
  materials: AssetMaterials;
  operations: {
    id: string;
    operationType: string;
    status: string;
    attempts: number;
    error: string | null;
    createdAt: Date;
  }[];
}

/** One user asset in full, or null for a platform or deleted one. */
export async function getUserAsset(assetId: string): Promise<UserAssetDetail | null> {
  if (!isUuid(assetId)) return null;
  const database = db();
  const [record] = await database
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      description: schema.asset.description,
      language: schema.asset.language,
      visibility: exposure(),
      lifecycleStatus: schema.asset.lifecycleStatus,
      indexStatus: schema.asset.indexStatus,
      storageBytes: schema.asset.storageBytes,
      createdAt: schema.asset.createdAt,
      lastSyncedAt: schema.asset.lastSuccessfulRefreshAt,
      ownerWorkspaceId: schema.asset.ownerWorkspaceId,
      currentVersionId: schema.asset.currentVersionId,
      isPlatformAsset: schema.asset.isPlatformAsset,
      deletedAt: schema.asset.deletedAt,
      ownerName: sql<string | null>`(
        select ${ref(schema.workspace.name)} from ${schema.workspace}
        where ${ref(schema.workspace.id)} = ${ref(schema.asset.ownerWorkspaceId)}
      )`,
    })
    .from(schema.asset)
    .where(eq(schema.asset.id, assetId))
    .limit(1);
  if (!record || record.isPlatformAsset || record.deletedAt) return null;

  const [sources, versions, reviews, operations, [current]] = await Promise.all([
    database
      .select({
        id: schema.source.id,
        type: schema.source.type,
        location: schema.source.location,
        config: schema.source.config,
      })
      .from(schema.source)
      .where(eq(schema.source.assetId, assetId))
      .orderBy(schema.source.id),
    database
      .select({
        id: schema.assetVersion.id,
        label: schema.assetVersion.label,
        indexStatus: schema.assetVersion.indexStatus,
        totalChunks: schema.assetVersion.totalChunks,
        publishedAt: schema.assetVersion.publishedAt,
        createdAt: schema.assetVersion.createdAt,
        documents: sql<number>`(
          select count(*)::int from ${schema.document}
          where ${ref(schema.document.versionId)} = ${ref(schema.assetVersion.id)}
        )`,
      })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.assetId, assetId))
      .orderBy(desc(schema.assetVersion.createdAt))
      .limit(DETAIL_LIMIT),
    database
      .select({
        id: schema.assetReview.id,
        stage: schema.assetReview.stage,
        outcome: schema.assetReview.outcome,
        feedback: schema.assetReview.feedback,
        decidedAt: schema.assetReview.decidedAt,
        createdAt: schema.assetReview.createdAt,
        reviewerEmail: sql<string | null>`(
          select ${ref(schema.administrator.email)} from ${schema.administrator}
          where ${ref(schema.administrator.id)} = ${ref(schema.assetReview.reviewerId)}
        )`,
      })
      .from(schema.assetReview)
      .where(eq(schema.assetReview.assetId, assetId))
      .orderBy(desc(schema.assetReview.createdAt))
      .limit(DETAIL_LIMIT),
    database
      .select({
        id: schema.workflowOperation.id,
        operationType: schema.workflowOperation.operationType,
        status: schema.workflowOperation.status,
        attempts: schema.workflowOperation.attempts,
        error: schema.workflowOperation.error,
        createdAt: schema.workflowOperation.createdAt,
      })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.assetId, assetId))
      .orderBy(desc(schema.workflowOperation.createdAt))
      .limit(DETAIL_LIMIT),
    record.currentVersionId
      ? database
          .select({
            id: schema.assetVersion.id,
            label: schema.assetVersion.label,
            indexStatus: schema.assetVersion.indexStatus,
            totalChunks: schema.assetVersion.totalChunks,
            documents: sql<number>`(
              select count(*)::int from ${schema.document}
              where ${ref(schema.document.versionId)} = ${ref(schema.assetVersion.id)}
            )`,
          })
          .from(schema.assetVersion)
          .where(eq(schema.assetVersion.id, record.currentVersionId))
          .limit(1)
      : Promise.resolve([] as { id: string; label: string; indexStatus: string; totalChunks: number; documents: number }[]),
  ]);

  return {
    id: record.id,
    publicId: record.publicId,
    title: record.title,
    description: record.description,
    language: record.language,
    visibility: record.visibility,
    lifecycleStatus: record.lifecycleStatus,
    indexStatus: record.indexStatus,
    storageBytes: record.storageBytes,
    createdAt: record.createdAt,
    lastSyncedAt: record.lastSyncedAt,
    ownerWorkspaceId: record.ownerWorkspaceId,
    ownerName: record.ownerName,
    currentVersionLabel: current?.label ?? null,
    hasReadyVersion: current?.indexStatus === 'ready',
    documents: current?.documents ?? 0,
    chunks: current?.totalChunks ?? 0,
    sources: sources.map((source) => ({
      id: source.id,
      type: source.type,
      location: source.location,
      fileCount: Array.isArray(source.config.files) ? source.config.files.length : null,
    })),
    versions: versions.map((version) => ({
      ...version,
      isCurrent: version.id === record.currentVersionId,
    })),
    reviews: reviews.map((review) => ({
      id: review.id,
      stage: review.stage,
      outcome: review.outcome,
      feedback: review.feedback,
      reviewerEmail: review.reviewerEmail,
      decidedAt: review.decidedAt,
      createdAt: review.createdAt,
    })),
    materials: await assetMaterials(database, record.id),
    operations,
  };
}

export interface ReviewResult {
  status: LifecycleStatus;
  publicId: string;
}

/**
 * One decision: suspend a live asset or restore a suspended one. The
 * reason is required -- it is what the owner reads on their dashboard and
 * what the audit log keeps -- and a restoration needs an indexed current
 * version, for the same reason platform publication does: the console must
 * never produce a published asset with an empty index.
 */
export async function reviewUserAsset(input: {
  actor: PlatformActor;
  assetId: string;
  action: UserReviewAction;
  reason: string;
}): Promise<ReviewResult> {
  const reason = normalizeReason(input.reason);
  if (!isUuid(input.assetId)) throw new PlatformAssetRefused('not_found', 'no such asset');

  const database = db();
  const [target] = await database
    .select({
      id: schema.asset.id,
      publicId: schema.asset.publicId,
      visibility: exposure(),
      lifecycleStatus: schema.asset.lifecycleStatus,
      currentVersionId: schema.asset.currentVersionId,
      isPlatformAsset: schema.asset.isPlatformAsset,
      deletedAt: schema.asset.deletedAt,
    })
    .from(schema.asset)
    .where(eq(schema.asset.id, input.assetId))
    .limit(1);
  if (!target || target.deletedAt) throw new PlatformAssetRefused('not_found', 'no such asset');
  if (target.isPlatformAsset) {
    throw new PlatformAssetRefused('not_user_asset', 'a platform asset is not reviewed');
  }

  if (!reviewActionAvailable(target.lifecycleStatus, input.action)) {
    throw new PlatformAssetRefused(
      target.lifecycleStatus === 'archived' ? 'archived' : 'invalid_transition',
      `cannot ${input.action} a ${target.visibility} ${target.lifecycleStatus} asset`,
    );
  }

  if (input.action === 'approve') {
    const ready = target.currentVersionId
      ? await database
          .select({ id: schema.assetVersion.id })
          .from(schema.assetVersion)
          .where(
            and(
              eq(schema.assetVersion.id, target.currentVersionId),
              eq(schema.assetVersion.indexStatus, 'ready'),
            ),
          )
          .limit(1)
      : [];
    if (ready.length === 0) {
      throw new PlatformAssetRefused('no_ready_version', 'approval requires an indexed version');
    }
  }

  const next = reviewTarget(input.action);
  const now = new Date();

  await database.transaction(async (tx) => {
    const updated = await tx
      .update(schema.asset)
      .set({ lifecycleStatus: next })
      .where(
        and(
          eq(schema.asset.id, target.id),
          eq(schema.asset.lifecycleStatus, target.lifecycleStatus),
          eq(schema.asset.isPlatformAsset, false),
        ),
      )
      .returning({ id: schema.asset.id });
    if (updated.length === 0) {
      throw new PlatformAssetRefused('invalid_transition', 'the asset moved while you decided');
    }
    await tx.insert(schema.assetReview).values({
      id: uuidv7(),
      assetId: target.id,
      versionId: target.currentVersionId,
      stage: MANUAL_REVIEW_STAGE,
      outcome: input.action,
      feedback: [reason],
      checklist: null,
      reviewerId: input.actor.administratorId ?? null,
      createdAt: now,
      decidedAt: now,
    });
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: `user_library.${input.action}`,
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: { publicId: target.publicId, lifecycleStatus: target.lifecycleStatus },
    afterValue: { publicId: target.publicId, lifecycleStatus: next },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { status: next, publicId: target.publicId };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

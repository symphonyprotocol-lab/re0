/**
 * The platform's side of a user library. requirement.md 5.3 and 7.4.
 *
 * Since 2026-10-23 a user library publishes when its build lands, under
 * either visibility; what the console keeps is the compliance hand over
 * content that is live: a suspension (`reject`) and its lifting
 * (`approve`), each with a reason, decided by the domain rule
 * (`reviewActionAvailable`).
 *
 * Every decision writes two rows: a `library_review` entry, which is the
 * note the owner reads on their dashboard, and an audit entry, which is
 * the record requirement.md 7.4 demands of every such action. The
 * lifecycle update is guarded on the status it was read at, so two
 * administrators deciding the same library at once cannot both succeed.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { normalizeReason } from '@/lib/domain/admin';
import { uuidv7 } from '@/lib/domain/id';
import type { IndexStatus, LifecycleStatus } from '@/lib/domain';
import {
  PlatformLibraryRefused,
  reviewActionAvailable,
  reviewTarget,
  type UserReviewAction,
} from '@/lib/domain/library';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { exposure } from '@/lib/application/channels/visibility';
import { libraryMaterials, type LibraryMaterials } from '@/lib/application/libraries/materials';
import { recordAudit } from './audit';
import { ref } from './column-ref';
import type { PlatformActor } from './manage-platform-libraries';

const AUDIT_TARGET = 'user_library';
const DETAIL_LIMIT = 20;

/** `library_review.stage` of a decision a person made in the console. */
export const MANUAL_REVIEW_STAGE = 'manual';

export interface UserLibraryReviewView {
  id: string;
  /** `manual`, the owner's `owner`; older rows carry the review era's `rules`, `model` and `sample`. */
  stage: string;
  outcome: string | null;
  feedback: string[];
  reviewerEmail: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface UserLibraryDetail {
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
  reviews: UserLibraryReviewView[];
  /** The owner's declaration and question set (review-visibility-proposal.md 5). */
  materials: LibraryMaterials;
  operations: {
    id: string;
    operationType: string;
    status: string;
    attempts: number;
    error: string | null;
    createdAt: Date;
  }[];
}

/** One user library in full, or null for a platform or deleted one. */
export async function getUserLibrary(libraryId: string): Promise<UserLibraryDetail | null> {
  if (!isUuid(libraryId)) return null;
  const database = db();
  const [record] = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      title: schema.library.title,
      description: schema.library.description,
      language: schema.library.language,
      visibility: exposure(),
      lifecycleStatus: schema.library.lifecycleStatus,
      indexStatus: schema.library.indexStatus,
      storageBytes: schema.library.storageBytes,
      createdAt: schema.library.createdAt,
      lastSyncedAt: schema.library.lastSuccessfulRefreshAt,
      ownerWorkspaceId: schema.library.ownerWorkspaceId,
      currentVersionId: schema.library.currentVersionId,
      isPlatformLibrary: schema.library.isPlatformLibrary,
      deletedAt: schema.library.deletedAt,
      ownerName: sql<string | null>`(
        select ${ref(schema.workspace.name)} from ${schema.workspace}
        where ${ref(schema.workspace.id)} = ${ref(schema.library.ownerWorkspaceId)}
      )`,
    })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId))
    .limit(1);
  if (!record || record.isPlatformLibrary || record.deletedAt) return null;

  const [sources, versions, reviews, operations, [current]] = await Promise.all([
    database
      .select({
        id: schema.source.id,
        type: schema.source.type,
        location: schema.source.location,
        config: schema.source.config,
      })
      .from(schema.source)
      .where(eq(schema.source.libraryId, libraryId))
      .orderBy(schema.source.id),
    database
      .select({
        id: schema.libraryVersion.id,
        label: schema.libraryVersion.label,
        indexStatus: schema.libraryVersion.indexStatus,
        totalChunks: schema.libraryVersion.totalChunks,
        publishedAt: schema.libraryVersion.publishedAt,
        createdAt: schema.libraryVersion.createdAt,
        documents: sql<number>`(
          select count(*)::int from ${schema.document}
          where ${ref(schema.document.versionId)} = ${ref(schema.libraryVersion.id)}
        )`,
      })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, libraryId))
      .orderBy(desc(schema.libraryVersion.createdAt))
      .limit(DETAIL_LIMIT),
    database
      .select({
        id: schema.libraryReview.id,
        stage: schema.libraryReview.stage,
        outcome: schema.libraryReview.outcome,
        feedback: schema.libraryReview.feedback,
        decidedAt: schema.libraryReview.decidedAt,
        createdAt: schema.libraryReview.createdAt,
        reviewerEmail: sql<string | null>`(
          select ${ref(schema.administrator.email)} from ${schema.administrator}
          where ${ref(schema.administrator.id)} = ${ref(schema.libraryReview.reviewerId)}
        )`,
      })
      .from(schema.libraryReview)
      .where(eq(schema.libraryReview.libraryId, libraryId))
      .orderBy(desc(schema.libraryReview.createdAt))
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
      .where(eq(schema.workflowOperation.libraryId, libraryId))
      .orderBy(desc(schema.workflowOperation.createdAt))
      .limit(DETAIL_LIMIT),
    record.currentVersionId
      ? database
          .select({
            id: schema.libraryVersion.id,
            label: schema.libraryVersion.label,
            indexStatus: schema.libraryVersion.indexStatus,
            totalChunks: schema.libraryVersion.totalChunks,
            documents: sql<number>`(
              select count(*)::int from ${schema.document}
              where ${ref(schema.document.versionId)} = ${ref(schema.libraryVersion.id)}
            )`,
          })
          .from(schema.libraryVersion)
          .where(eq(schema.libraryVersion.id, record.currentVersionId))
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
    materials: await libraryMaterials(database, record.id),
    operations,
  };
}

export interface ReviewResult {
  status: LifecycleStatus;
  publicId: string;
}

/**
 * One decision: suspend a live library or restore a suspended one. The
 * reason is required -- it is what the owner reads on their dashboard and
 * what the audit log keeps -- and a restoration needs an indexed current
 * version, for the same reason platform publication does: the console must
 * never produce a published library with an empty index.
 */
export async function reviewUserLibrary(input: {
  actor: PlatformActor;
  libraryId: string;
  action: UserReviewAction;
  reason: string;
}): Promise<ReviewResult> {
  const reason = normalizeReason(input.reason);
  if (!isUuid(input.libraryId)) throw new PlatformLibraryRefused('not_found', 'no such library');

  const database = db();
  const [target] = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      visibility: exposure(),
      lifecycleStatus: schema.library.lifecycleStatus,
      currentVersionId: schema.library.currentVersionId,
      isPlatformLibrary: schema.library.isPlatformLibrary,
      deletedAt: schema.library.deletedAt,
    })
    .from(schema.library)
    .where(eq(schema.library.id, input.libraryId))
    .limit(1);
  if (!target || target.deletedAt) throw new PlatformLibraryRefused('not_found', 'no such library');
  if (target.isPlatformLibrary) {
    throw new PlatformLibraryRefused('not_user_library', 'a platform library is not reviewed');
  }

  if (!reviewActionAvailable(target.lifecycleStatus, input.action)) {
    throw new PlatformLibraryRefused(
      target.lifecycleStatus === 'archived' ? 'archived' : 'invalid_transition',
      `cannot ${input.action} a ${target.visibility} ${target.lifecycleStatus} library`,
    );
  }

  if (input.action === 'approve') {
    const ready = target.currentVersionId
      ? await database
          .select({ id: schema.libraryVersion.id })
          .from(schema.libraryVersion)
          .where(
            and(
              eq(schema.libraryVersion.id, target.currentVersionId),
              eq(schema.libraryVersion.indexStatus, 'ready'),
            ),
          )
          .limit(1)
      : [];
    if (ready.length === 0) {
      throw new PlatformLibraryRefused('no_ready_version', 'approval requires an indexed version');
    }
  }

  const next = reviewTarget(input.action);
  const now = new Date();

  await database.transaction(async (tx) => {
    const updated = await tx
      .update(schema.library)
      .set({ lifecycleStatus: next })
      .where(
        and(
          eq(schema.library.id, target.id),
          eq(schema.library.lifecycleStatus, target.lifecycleStatus),
          eq(schema.library.isPlatformLibrary, false),
        ),
      )
      .returning({ id: schema.library.id });
    if (updated.length === 0) {
      throw new PlatformLibraryRefused('invalid_transition', 'the library moved while you decided');
    }
    await tx.insert(schema.libraryReview).values({
      id: uuidv7(),
      libraryId: target.id,
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

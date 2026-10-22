/**
 * The reviewer's side of a user library. requirement.md 5.3 and 7.4.
 *
 * A public user library reaches `submitted` when its first version is built
 * (`advanceLifecycleAfterBuild`), and from there a reviewer approves it,
 * asks for changes, or rejects it. A private library is never reviewed; the
 * same verbs read as a safety pause and its lifting, and the domain rule
 * (`reviewActionAvailable`) is what keeps a reviewer from sending a private
 * library back for "changes" nobody asked for.
 *
 * Every decision writes two rows: a `library_review` entry, which is the
 * feedback the owner sees on their dashboard, and an audit entry, which is
 * the record requirement.md 7.4 demands of every review action. The
 * lifecycle update is guarded on the status it was read at, so two reviewers
 * deciding the same library at once cannot both succeed.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { normalizeReason } from '@/lib/domain/admin';
import { uuidv7 } from '@/lib/domain/id';
import type { IndexStatus, LifecycleStatus, Visibility } from '@/lib/domain';
import {
  PlatformLibraryRefused,
  reviewActionAvailable,
  reviewTarget,
  type UserReviewAction,
} from '@/lib/domain/library';
import {
  checklistAllows,
  checklistRequired,
  parseReviewChecklist,
  readReviewChecklist,
  type ReviewChecklist,
} from '@/lib/domain/review';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { libraryMaterials, type LibraryMaterials } from '@/lib/application/libraries/materials';
import { SAMPLE_REVIEW_STAGE } from '@/lib/application/review/stages';
import { recordAudit } from './audit';
import { ref } from './column-ref';
import type { PlatformActor } from './manage-platform-libraries';

const AUDIT_TARGET = 'user_library';
const DETAIL_LIMIT = 20;

/** `library_review.stage` of a decision a person made in the console. */
export const MANUAL_REVIEW_STAGE = 'manual';

export interface UserLibraryReviewView {
  id: string;
  /** `manual`, the owner's `owner`, the rules layer's `rules`, or a `sample` it drew. */
  stage: string;
  outcome: string | null;
  feedback: string[];
  /** The 7.4 checklist behind the decision; null on a safety pause or an older row. */
  checklist: ReviewChecklist | null;
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
  visibility: Visibility;
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
  /** An auto-published library drawn for a person's look, not yet closed (lib/application/review/rules.ts). */
  openSample: boolean;
  /** The owner appealed a machine send-back and a person has not answered yet. */
  openAppeal: boolean;
  /** The owner's submission materials (review-visibility-proposal.md 5): the declaration and the question set. */
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
      visibility: schema.library.visibility,
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
        checklist: schema.libraryReview.checklist,
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
      checklist: readReviewChecklist(review.checklist),
      reviewerEmail: review.reviewerEmail,
      decidedAt: review.decidedAt,
      createdAt: review.createdAt,
    })),
    openSample: reviews.some((review) => review.stage === SAMPLE_REVIEW_STAGE && review.decidedAt === null),
    openAppeal: reviews[0]?.stage === 'owner' && reviews[0].outcome === 'appeal' && reviews[0].decidedAt === null,
    materials: await libraryMaterials(database, record.id),
    operations,
  };
}

/**
 * A reviewer's look at an auto-published library that was drawn for one
 * (review-visibility-proposal.md 6.3): nothing was wrong, the sample is
 * closed. Anything wrong goes through `reviewUserLibrary` instead, whose
 * decision closes the sample too.
 */
export async function closeReviewSample(input: {
  actor: PlatformActor;
  libraryId: string;
  reason: string;
}): Promise<void> {
  const reason = normalizeReason(input.reason);
  if (!isUuid(input.libraryId)) throw new PlatformLibraryRefused('not_found', 'no such library');
  const now = new Date();
  const closed = await db()
    .update(schema.libraryReview)
    .set({ outcome: 'approve', feedback: [reason], reviewerId: input.actor.administratorId, decidedAt: now })
    .where(
      and(
        eq(schema.libraryReview.libraryId, input.libraryId),
        eq(schema.libraryReview.stage, SAMPLE_REVIEW_STAGE),
        sql`${schema.libraryReview.decidedAt} is null`,
      ),
    )
    .returning({ id: schema.libraryReview.id });
  if (closed.length === 0) throw new PlatformLibraryRefused('invalid_transition', 'no open sample on this library');

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'user_library.sample_ok',
    targetType: AUDIT_TARGET,
    targetId: input.libraryId,
    reason,
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });
}

export interface ReviewResult {
  status: LifecycleStatus;
  publicId: string;
}

/**
 * One review decision. The reason is required -- it is what the owner reads
 * on their dashboard and what the audit log keeps -- and approval needs an
 * indexed current version, for the same reason platform publication does:
 * the console must never produce a published library with an empty index.
 *
 * A public library's decision also carries requirement.md 7.4's checklist
 * (lib/domain/review.ts): five verdicts that have to agree with the verb.
 * A private library's pause and its lifting take a reason alone.
 */
export async function reviewUserLibrary(input: {
  actor: PlatformActor;
  libraryId: string;
  action: UserReviewAction;
  reason: string;
  /** The checklist as the form posted it, or as an object; absent on a private library. */
  checklist?: unknown;
}): Promise<ReviewResult> {
  const reason = normalizeReason(input.reason);
  if (!isUuid(input.libraryId)) throw new PlatformLibraryRefused('not_found', 'no such library');

  const database = db();
  const [target] = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      visibility: schema.library.visibility,
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

  if (!reviewActionAvailable(target.lifecycleStatus, target.visibility, input.action)) {
    throw new PlatformLibraryRefused(
      target.lifecycleStatus === 'archived' ? 'archived' : 'invalid_transition',
      `cannot ${input.action} a ${target.visibility} ${target.lifecycleStatus} library`,
    );
  }

  let checklist: ReviewChecklist | null = null;
  if (checklistRequired(target.visibility)) {
    checklist = input.checklist === undefined ? null : parseReviewChecklist(input.checklist);
    if (!checklist) throw new PlatformLibraryRefused('checklist_required', 'a public review records the checklist');
    if (!checklistAllows(input.action, checklist)) {
      throw new PlatformLibraryRefused('checklist_mismatch', `the checklist does not support ${input.action}`);
    }
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
      checklist,
      reviewerId: input.actor.administratorId ?? null,
      createdAt: now,
      decidedAt: now,
    });
    /* A decision on a sampled library answers the sample as well. */
    await tx
      .update(schema.libraryReview)
      .set({ outcome: input.action, reviewerId: input.actor.administratorId ?? null, decidedAt: now })
      .where(
        and(
          eq(schema.libraryReview.libraryId, target.id),
          eq(schema.libraryReview.stage, SAMPLE_REVIEW_STAGE),
          sql`${schema.libraryReview.decidedAt} is null`,
        ),
      );
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: `user_library.${input.action}`,
    targetType: AUDIT_TARGET,
    targetId: target.id,
    reason,
    beforeValue: { publicId: target.publicId, lifecycleStatus: target.lifecycleStatus },
    afterValue: {
      publicId: target.publicId,
      lifecycleStatus: next,
      ...(checklist
        ? { checklist: Object.fromEntries(Object.entries(checklist).map(([check, item]) => [check, item.verdict])) }
        : {}),
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { status: next, publicId: target.publicId };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

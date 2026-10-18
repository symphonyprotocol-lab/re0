/**
 * The console's side of the expert tag. expert-library-prd.md 4.2, 4.3, 6.
 *
 * Three moves, each with a required reason and an audit row:
 *
 * - `decideExpertApplication`: approve or reject a pending application.
 *   Approval re-runs the eligibility checks under the library's row lock and
 *   writes `library.expert_tagged_at`; it is the only path that sets it.
 * - `revokeExpertTag`: withdraw an approval. The tag is cleared, and the
 *   library's earning events in every period not yet locked are flagged, the
 *   same voiding a suspension gets at close (publisher-revenue-share.md 5).
 * - the list and the detail, which the queue and its screens read.
 */
import { and, count, desc, eq, ilike, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { LifecycleStatus, Visibility } from '@/lib/domain';
import { normalizeReason } from '@/lib/domain/admin';
import {
  approvalAllowed,
  approvalChecks,
  ExpertLibraryRefused,
  nextExpertStatus,
  type ApprovalCheck,
  type ExpertApplicationStatus,
} from '@/lib/domain/expert-library';
import { ref } from '@/lib/application/administration/column-ref';
import { likePattern } from '@/lib/application/administration/like-pattern';
import { paidSubscriptionExists } from '@/lib/application/plans/in-force';
import { workspacePlanVersion } from '@/lib/application/plans/billing';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import type { ExpertApplicationView } from './owner';
import {
  applicationHistory,
  AUDIT_TARGET,
  auditExpert,
  candidateOf,
  hasReadyVersion,
  loadApplication,
} from './shared';

export interface ExpertActor {
  administratorId: string;
  email: string;
  clientAddress?: string | null;
}

/* ------------------------------------------------------------------- list */

export type ExpertFilter = 'all' | ExpertApplicationStatus;

export const EXPERT_FILTERS: readonly ExpertFilter[] = [
  'all',
  'pending',
  'approved',
  'rejected',
  'revoked',
  'withdrawn',
];

export function isExpertFilter(value: unknown): value is ExpertFilter {
  return typeof value === 'string' && (EXPERT_FILTERS as readonly string[]).includes(value);
}

export interface ConsoleExpertRow {
  id: string;
  libraryId: string;
  libraryTitle: string;
  libraryPublicId: string;
  workspaceName: string;
  status: ExpertApplicationStatus;
  createdAt: Date;
  decidedAt: Date | null;
  /** The library as it stands now, not as it was when it applied. */
  visibility: Visibility;
  lifecycleStatus: LifecycleStatus;
  ownerSubscribed: boolean;
  expertTaggedAt: Date | null;
  /** Pending, and every approval check met right now (prd 4.2). */
  approvable: boolean;
}

const applicantName: SQL = sql`(
  select ${ref(schema.workspace.name)} from ${schema.workspace}
  where ${ref(schema.workspace.id)} = ${ref(schema.expertApplication.workspaceId)}
)`;

const asBoolean = (value: unknown): boolean => value === true || value === 't';

export async function listExpertApplications(
  input: { query?: string; status?: ExpertFilter; limit?: number; offset?: number } = {},
): Promise<{ rows: ConsoleExpertRow[]; total: number; counts: Record<string, number> }> {
  const database = db();
  const term = input.query?.trim();
  const filter = input.status ?? 'all';

  const conditions = [
    /* An application on a deleted library is moot; the queue does not show it. */
    isNull(schema.library.deletedAt),
    filter === 'all' ? undefined : eq(schema.expertApplication.status, filter),
    term
      ? or(
          ilike(schema.library.title, likePattern(term)),
          ilike(schema.library.publicId, likePattern(term)),
          sql`${applicantName} ilike ${likePattern(term)}`,
        )
      : undefined,
  ].filter(Boolean);
  const where = and(...conditions);

  const [rows, [totalRow], statusRows] = await Promise.all([
    database
      .select({
        id: schema.expertApplication.id,
        libraryId: schema.library.id,
        libraryTitle: schema.library.title,
        libraryPublicId: schema.library.publicId,
        workspaceId: schema.expertApplication.workspaceId,
        workspaceName: applicantName.mapWith((value): string => (value as string | null) ?? ''),
        status: schema.expertApplication.status,
        createdAt: schema.expertApplication.createdAt,
        decidedAt: schema.expertApplication.decidedAt,
        visibility: schema.library.visibility,
        lifecycleStatus: schema.library.lifecycleStatus,
        ownerWorkspaceId: schema.library.ownerWorkspaceId,
        ownerSubscribed: paidSubscriptionExists(ref(schema.library.ownerWorkspaceId)).mapWith(asBoolean),
        hasReadyVersion: hasReadyVersion.mapWith(asBoolean),
        expertTaggedAt: schema.library.expertTaggedAt,
      })
      .from(schema.expertApplication)
      .innerJoin(schema.library, eq(schema.library.id, schema.expertApplication.libraryId))
      .where(where)
      .orderBy(
        /* The queue first: pending rows ahead, oldest waiting at the top. */
        sql`case when ${schema.expertApplication.status} = 'pending' then 0 else 1 end`,
        desc(schema.expertApplication.createdAt),
      )
      .limit(input.limit ?? 50)
      .offset(input.offset ?? 0),
    database
      .select({ n: count() })
      .from(schema.expertApplication)
      .innerJoin(schema.library, eq(schema.library.id, schema.expertApplication.libraryId))
      .where(where),
    database
      .select({ status: schema.expertApplication.status, n: count() })
      .from(schema.expertApplication)
      .innerJoin(schema.library, eq(schema.library.id, schema.expertApplication.libraryId))
      .where(isNull(schema.library.deletedAt))
      .groupBy(schema.expertApplication.status),
  ]);

  const byStatus = new Map<string, number>(statusRows.map((row) => [row.status, row.n]));
  return {
    rows: rows.map(
      ({ workspaceId, ownerWorkspaceId, hasReadyVersion: ready, ...row }): ConsoleExpertRow => ({
        ...row,
        approvable:
          row.status === 'pending' &&
          approvalAllowed(
            approvalChecks({
              candidate: row,
              ownerWorkspaceId,
              applicantWorkspaceId: workspaceId,
              hasReadyVersion: ready,
            }),
          ),
      }),
    ),
    total: totalRow?.n ?? 0,
    counts: {
      all: [...byStatus.values()].reduce((a, b) => a + b, 0),
      pending: byStatus.get('pending') ?? 0,
      approved: byStatus.get('approved') ?? 0,
      rejected: byStatus.get('rejected') ?? 0,
      revoked: byStatus.get('revoked') ?? 0,
      withdrawn: byStatus.get('withdrawn') ?? 0,
    },
  };
}

/** How many applications wait, for the rail's badge. */
export async function pendingExpertApplications(): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(schema.expertApplication)
    .innerJoin(schema.library, eq(schema.library.id, schema.expertApplication.libraryId))
    .where(and(eq(schema.expertApplication.status, 'pending'), isNull(schema.library.deletedAt)));
  return row?.n ?? 0;
}

/* ----------------------------------------------------------------- detail */

export interface ExpertAuditEntry {
  id: string;
  action: string;
  administratorName: string | null;
  reason: string | null;
  result: string;
  createdAt: Date;
}

export interface ConsoleExpertDetail {
  id: string;
  status: ExpertApplicationStatus;
  note: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  decidedByName: string | null;
  createdAt: Date;
  library: {
    id: string;
    publicId: string;
    title: string;
    visibility: Visibility;
    lifecycleStatus: LifecycleStatus;
    deletedAt: Date | null;
    expertTaggedAt: Date | null;
    ownerWorkspaceId: string | null;
    ownerName: string | null;
    hasReadyVersion: boolean;
    trustScore: number;
    /** The owner's plan as it stands; the name only, never an amount. */
    ownerPlanName: string | null;
    ownerSubscribed: boolean;
  };
  applicant: { id: string; name: string };
  /** The approval checks as they stand now (prd 4.2). */
  checks: Record<ApprovalCheck, boolean>;
  approvable: boolean;
  history: ExpertApplicationView[];
  audit: ExpertAuditEntry[];
}

export async function expertApplicationDetail(
  applicationId: string,
): Promise<ConsoleExpertDetail | null> {
  const database = db();
  const application = await loadApplication(database, applicationId);
  if (!application) return null;

  const [library, [applicant], history, audit, decider] = await Promise.all([
    candidateOf(database, eq(schema.library.id, application.libraryId)),
    database
      .select({ id: schema.workspace.id, name: schema.workspace.name })
      .from(schema.workspace)
      .where(eq(schema.workspace.id, application.workspaceId))
      .limit(1),
    applicationHistory(database, application.libraryId),
    database
      .select({
        id: schema.auditLog.id,
        action: schema.auditLog.action,
        administratorName: schema.administrator.username,
        reason: schema.auditLog.reason,
        result: schema.auditLog.result,
        createdAt: schema.auditLog.createdAt,
      })
      .from(schema.auditLog)
      .leftJoin(schema.administrator, eq(schema.administrator.id, schema.auditLog.administratorId))
      .where(
        and(
          eq(schema.auditLog.targetType, AUDIT_TARGET),
          /* `target_id` is text and the application id a uuid; cast, or the
             comparison has no operator. */
          inArray(
            schema.auditLog.targetId,
            database
              .select({ id: sql<string>`${schema.expertApplication.id}::text` })
              .from(schema.expertApplication)
              .where(eq(schema.expertApplication.libraryId, application.libraryId)),
          ),
        ),
      )
      .orderBy(desc(schema.auditLog.seq))
      .limit(50),
    application.decidedByAdminId
      ? database
          .select({ username: schema.administrator.username })
          .from(schema.administrator)
          .where(eq(schema.administrator.id, application.decidedByAdminId))
          .limit(1)
      : Promise.resolve([] as { username: string }[]),
  ]);
  if (!library) return null;

  const ownerPlan = library.ownerWorkspaceId
    ? await workspacePlanVersion(library.ownerWorkspaceId)
    : null;

  const checks = approvalChecks({
    candidate: library,
    ownerWorkspaceId: library.ownerWorkspaceId,
    applicantWorkspaceId: application.workspaceId,
    hasReadyVersion: library.hasReadyVersion,
  });

  return {
    id: application.id,
    status: application.status,
    note: application.note,
    decisionReason: application.decisionReason,
    decidedAt: application.decidedAt,
    decidedByName: decider[0]?.username ?? null,
    createdAt: application.createdAt,
    library: {
      id: library.id,
      publicId: library.publicId,
      title: library.title,
      visibility: library.visibility,
      lifecycleStatus: library.lifecycleStatus,
      deletedAt: library.deletedAt,
      expertTaggedAt: library.expertTaggedAt,
      ownerWorkspaceId: library.ownerWorkspaceId,
      ownerName: library.ownerName,
      hasReadyVersion: library.hasReadyVersion,
      trustScore: library.trustScore,
      ownerPlanName: ownerPlan?.planName ?? null,
      ownerSubscribed: library.ownerSubscribed,
    },
    applicant: { id: application.workspaceId, name: applicant?.name ?? '' },
    checks,
    /* A deleted library is refused as `not_found` before any check runs. */
    approvable:
      application.status === 'pending' && library.deletedAt === null && approvalAllowed(checks),
    history: history.map((row) => ({
      id: row.id,
      status: row.status,
      note: row.note,
      decisionReason: row.decisionReason,
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
    })),
    audit,
  };
}

/* --------------------------------------------------------------- decide */

export type ExpertRuling = 'approve' | 'reject';

export interface DecideExpertApplicationInput {
  actor: ExpertActor;
  applicationId: string;
  decision: ExpertRuling;
  reason: string;
  now?: Date;
}

export interface DecideExpertApplicationResult {
  status: ExpertApplicationStatus;
  libraryId: string;
  expertTaggedAt: Date | null;
}

export async function decideExpertApplication(
  input: DecideExpertApplicationInput,
): Promise<DecideExpertApplicationResult> {
  const reason = normalizeExpertReason(input.reason);
  const now = input.now ?? new Date();

  const outcome = await db().transaction(async (tx) => {
    const application = await loadApplication(tx, input.applicationId);
    if (!application) throw new ExpertLibraryRefused('not_found', 'no such application');
    const next = nextExpertStatus(application.status, input.decision);
    if (!next) throw new ExpertLibraryRefused('not_pending', 'only a pending application is decided');

    /* The library row is locked so an approval cannot interleave with an
       edit that takes the library private or a transfer of its owner. */
    const library = await candidateOf(tx, eq(schema.library.id, application.libraryId), true);
    if (!library || library.deletedAt) throw new ExpertLibraryRefused('not_found', 'no such library');

    let taggedAt: Date | null = library.expertTaggedAt;
    if (input.decision === 'approve') {
      const checks = approvalChecks({
        candidate: library,
        ownerWorkspaceId: library.ownerWorkspaceId,
        applicantWorkspaceId: application.workspaceId,
        hasReadyVersion: library.hasReadyVersion,
      });
      if (!approvalAllowed(checks)) {
        throw new ExpertLibraryRefused(
          'library_ineligible',
          `the library no longer qualifies: ${Object.entries(checks)
            .filter(([, ok]) => !ok)
            .map(([key]) => key)
            .join(', ')}`,
        );
      }
      taggedAt = now;
      await tx
        .update(schema.library)
        .set({ expertTaggedAt: now })
        .where(eq(schema.library.id, library.id));
    }

    const updated = await tx
      .update(schema.expertApplication)
      .set({
        status: next,
        decisionReason: reason,
        decidedByAdminId: input.actor.administratorId,
        decidedAt: now,
      })
      .where(
        and(
          eq(schema.expertApplication.id, application.id),
          eq(schema.expertApplication.status, 'pending'),
        ),
      )
      .returning({ id: schema.expertApplication.id });
    if (updated.length === 0) {
      throw new ExpertLibraryRefused('not_pending', 'the application moved while you decided');
    }

    return {
      status: next,
      libraryId: library.id,
      publicId: library.publicId,
      workspaceId: application.workspaceId,
      before: library.expertTaggedAt,
      expertTaggedAt: taggedAt,
    };
  });

  await auditExpert({
    action: `expert_library.${input.decision}`,
    applicationId: input.applicationId,
    administratorId: input.actor.administratorId,
    reason,
    before: { status: 'pending', expertTaggedAt: outcome.before },
    after: {
      status: outcome.status,
      expertTaggedAt: outcome.expertTaggedAt,
      libraryId: outcome.libraryId,
      publicId: outcome.publicId,
      workspaceId: outcome.workspaceId,
      administrator: input.actor.email,
    },
    clientAddress: input.actor.clientAddress ?? null,
  });

  return {
    status: outcome.status,
    libraryId: outcome.libraryId,
    expertTaggedAt: outcome.expertTaggedAt,
  };
}

/* --------------------------------------------------------------- revoke */

export interface RevokeExpertTagInput {
  actor: ExpertActor;
  applicationId: string;
  reason: string;
  now?: Date;
}

export interface RevokeExpertTagResult {
  libraryId: string;
  /** Earning events of the library in periods not yet locked, now flagged. */
  voidedEvents: number;
}

export async function revokeExpertTag(input: RevokeExpertTagInput): Promise<RevokeExpertTagResult> {
  const reason = normalizeExpertReason(input.reason);
  const now = input.now ?? new Date();

  const outcome = await db().transaction(async (tx) => {
    const application = await loadApplication(tx, input.applicationId);
    if (!application) throw new ExpertLibraryRefused('not_found', 'no such application');
    const next = nextExpertStatus(application.status, 'revoke');
    if (!next) throw new ExpertLibraryRefused('not_approved', 'only an approved application is revoked');

    const library = await candidateOf(tx, eq(schema.library.id, application.libraryId), true);
    if (!library) throw new ExpertLibraryRefused('not_found', 'no such library');

    await tx
      .update(schema.library)
      .set({ expertTaggedAt: null })
      .where(eq(schema.library.id, library.id));
    const updated = await tx
      .update(schema.expertApplication)
      .set({
        status: next,
        decisionReason: reason,
        decidedByAdminId: input.actor.administratorId,
        decidedAt: now,
      })
      .where(
        and(
          eq(schema.expertApplication.id, application.id),
          eq(schema.expertApplication.status, 'approved'),
        ),
      )
      .returning({ id: schema.expertApplication.id });
    if (updated.length === 0) {
      throw new ExpertLibraryRefused('not_approved', 'the application moved while you decided');
    }

    /*
     * Voiding (prd 4.3): unpaid earnings of periods still open are flagged,
     * so the revocation reaches calls already made this period. A locked
     * period is a closed ledger -- its allocations have been computed and
     * may be settled -- and is never reopened (close-period.ts).
     */
    const voided = await tx
      .update(schema.earningEvent)
      .set({ flagged: true })
      .where(
        and(
          eq(schema.earningEvent.libraryId, library.id),
          eq(schema.earningEvent.flagged, false),
          notInArray(
            schema.earningEvent.periodId,
            tx
              .select({ id: schema.revenuePeriod.id })
              .from(schema.revenuePeriod)
              .where(sql`${schema.revenuePeriod.lockedAt} is not null`),
          ),
        ),
      )
      .returning({ id: schema.earningEvent.id });

    return {
      libraryId: library.id,
      publicId: library.publicId,
      workspaceId: application.workspaceId,
      before: library.expertTaggedAt,
      voidedEvents: voided.length,
    };
  });

  await auditExpert({
    action: 'expert_library.revoke',
    applicationId: input.applicationId,
    administratorId: input.actor.administratorId,
    reason,
    before: { status: 'approved', expertTaggedAt: outcome.before },
    after: {
      status: 'revoked',
      expertTaggedAt: null,
      libraryId: outcome.libraryId,
      publicId: outcome.publicId,
      workspaceId: outcome.workspaceId,
      voidedEvents: outcome.voidedEvents,
      administrator: input.actor.email,
    },
    clientAddress: input.actor.clientAddress ?? null,
  });

  return { libraryId: outcome.libraryId, voidedEvents: outcome.voidedEvents };
}

/** `normalizeReason` throws the admin module's class; translate it to ours. */
function normalizeExpertReason(reason: string): string {
  try {
    return normalizeReason(reason);
  } catch {
    throw new ExpertLibraryRefused('reason_required', 'a reason is recorded with every decision');
  }
}

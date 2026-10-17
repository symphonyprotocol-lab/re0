/**
 * What the expert-library use cases share: the candidate loader, the audit
 * shape and the row types. expert-library-prd.md 8.
 *
 * The owner's application and the console's approval read the library the
 * same way (`candidateOf`), so the two cannot disagree about whether it
 * qualifies: one select, one set of facts, one domain rule over them.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { LifecycleStatus, Visibility } from '@/lib/domain';
import type { ExpertApplicationStatus } from '@/lib/domain/expert-library';
import { recordAudit } from '@/lib/application/administration/audit';
import { ref } from '@/lib/application/administration/column-ref';
import { paidSubscriptionExists } from '@/lib/application/plans/in-force';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export const AUDIT_TARGET = 'expert_application';

/** Statuses after which the cooldown applies before the library may reapply. */
export const COOLDOWN_STATUSES: readonly ExpertApplicationStatus[] = ['rejected', 'revoked'];

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

type Reader = Pick<ReturnType<typeof db>, 'select'>;

/** A raw-SQL boolean, which the driver may hand back as 't'/'f' text. */
const asBoolean = (value: unknown): boolean => value === true || value === 't';

/** Whether `current_version_id` points at a version whose index is ready. */
export const hasReadyVersion: SQL = sql`exists (
  select 1 from ${schema.libraryVersion}
  where ${ref(schema.libraryVersion.id)} = ${ref(schema.library.currentVersionId)}
    and ${ref(schema.libraryVersion.indexStatus)} = 'ready'
)`;

const ownerName: SQL = sql`(
  select ${ref(schema.workspace.name)} from ${schema.workspace}
  where ${ref(schema.workspace.id)} = ${ref(schema.library.ownerWorkspaceId)}
)`;

/** The newest trust score, or 0 for a library nobody has scored. */
const trustScore: SQL = sql`coalesce((
  select s.trust_score from ${schema.libraryScore} s
  where s.library_id = ${ref(schema.library.id)}
  order by s.computed_at desc limit 1
), 0)`;

export interface ExpertCandidateRow {
  id: string;
  publicId: string;
  title: string;
  visibility: Visibility;
  lifecycleStatus: LifecycleStatus;
  ownerWorkspaceId: string | null;
  ownerName: string | null;
  isPlatformLibrary: boolean;
  deletedAt: Date | null;
  expertTaggedAt: Date | null;
  ownerSubscribed: boolean;
  hasReadyVersion: boolean;
  trustScore: number;
}

/**
 * The library as the expert rules see it. `lock` takes the library row `for
 * update` in the same query, which the write paths do so that an approval
 * and an edit to visibility cannot interleave; the readers leave it off.
 * `of: library` keeps the lock off the rows the correlated subqueries read.
 */
export async function candidateOf(
  reader: Reader,
  identity: SQL,
  lock = false,
): Promise<ExpertCandidateRow | null> {
  const query = reader
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      title: schema.library.title,
      visibility: schema.library.visibility,
      lifecycleStatus: schema.library.lifecycleStatus,
      ownerWorkspaceId: schema.library.ownerWorkspaceId,
      ownerName: ownerName.mapWith((value): string | null => (value as string | null) ?? null),
      isPlatformLibrary: schema.library.isPlatformLibrary,
      deletedAt: schema.library.deletedAt,
      expertTaggedAt: schema.library.expertTaggedAt,
      ownerSubscribed: paidSubscriptionExists(ref(schema.library.ownerWorkspaceId)).mapWith(asBoolean),
      hasReadyVersion: hasReadyVersion.mapWith(asBoolean),
      trustScore: trustScore.mapWith(Number),
    })
    .from(schema.library)
    .where(identity)
    .limit(1);
  const [row] = lock ? await query.for('update', { of: schema.library }) : await query;
  return (row as ExpertCandidateRow | undefined) ?? null;
}

/** The workspace's own live user library, by id. */
export function ownedLibrary(workspaceId: string, libraryId: string): SQL {
  return and(
    eq(schema.library.id, libraryId),
    eq(schema.library.ownerWorkspaceId, workspaceId),
    eq(schema.library.isPlatformLibrary, false),
    isNull(schema.library.deletedAt),
  )!;
}

export interface ExpertApplicationRow {
  id: string;
  libraryId: string;
  workspaceId: string;
  status: ExpertApplicationStatus;
  note: string | null;
  decisionReason: string | null;
  decidedByAdminId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export async function loadApplication(
  reader: Reader,
  applicationId: string,
): Promise<ExpertApplicationRow | null> {
  if (!isUuid(applicationId)) return null;
  const [row] = await reader
    .select()
    .from(schema.expertApplication)
    .where(eq(schema.expertApplication.id, applicationId))
    .limit(1);
  return (row as ExpertApplicationRow | undefined) ?? null;
}

/** The library's open application, if any. */
export async function pendingApplicationOf(
  reader: Reader,
  libraryId: string,
): Promise<ExpertApplicationRow | null> {
  const [row] = await reader
    .select()
    .from(schema.expertApplication)
    .where(
      and(
        eq(schema.expertApplication.libraryId, libraryId),
        eq(schema.expertApplication.status, 'pending'),
      ),
    )
    .limit(1);
  return (row as ExpertApplicationRow | undefined) ?? null;
}

/** When this library was last rejected or revoked, for the cooldown. */
export async function lastCooldownDecisionAt(
  reader: Reader,
  libraryId: string,
): Promise<Date | null> {
  const [row] = await reader
    .select({ decidedAt: schema.expertApplication.decidedAt })
    .from(schema.expertApplication)
    .where(
      and(
        eq(schema.expertApplication.libraryId, libraryId),
        inArray(schema.expertApplication.status, [...COOLDOWN_STATUSES]),
      ),
    )
    .orderBy(desc(schema.expertApplication.decidedAt))
    .limit(1);
  return row?.decidedAt ?? null;
}

/** Every application the library has had, newest first. */
export async function applicationHistory(
  reader: Reader,
  libraryId: string,
  limit = 20,
): Promise<ExpertApplicationRow[]> {
  const rows = await reader
    .select()
    .from(schema.expertApplication)
    .where(eq(schema.expertApplication.libraryId, libraryId))
    .orderBy(desc(schema.expertApplication.createdAt))
    .limit(limit);
  return rows as ExpertApplicationRow[];
}

/**
 * Every expert move is an audit fact (prd 6.4). The owner's apply and
 * withdraw have no administrator; the applicant workspace is recorded in the
 * values instead, where it is a snapshot rather than a key.
 */
export async function auditExpert(input: {
  action: string;
  applicationId: string;
  administratorId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  clientAddress?: string | null;
}): Promise<void> {
  await recordAudit({
    administratorId: input.administratorId ?? null,
    action: input.action,
    targetType: AUDIT_TARGET,
    targetId: input.applicationId,
    reason: input.reason ?? null,
    beforeValue: input.before,
    afterValue: input.after,
    clientAddress: input.clientAddress ?? null,
    result: 'success',
  });
}

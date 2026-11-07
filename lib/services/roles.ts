/**
 * Roles against the database (rebuild-proposal.md 2.7): the threshold's
 * figures, the user's application, the console's review queue and its
 * direct role changes. Every change writes `user.role`, an audit row and a
 * notice in one transaction; the role history is read back from the audit.
 *
 * Step 4 shows the badges (it reads `user.role`); this module is the only
 * writer of the column.
 */
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { AuditAction } from '@/lib/domain/audit';
import { likePattern, clampPage, type ListResult } from '@/lib/domain/list';
import {
  helpfulRate,
  parseRoleReason,
  parseVerificationInput,
  registeredDays,
  roleAfter,
  verificationAccess,
  verificationChecks,
  type RoleAction,
  type RoleMetrics,
  type UserRole,
  type VerificationAccess,
} from '@/lib/domain/roles';
import type { VerificationsView } from '@/lib/domain/admin-lists';
import { db, schema, type Executor } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';
import { notify } from '@/lib/services/notices';

export type VerificationRow = typeof schema.verificationRequest.$inferSelect;

/* ------------------------------------------------------------ the figures */

/**
 * Tables later steps add (step 4's `ree_feedback`, step 6's `payout`) are
 * read only once they exist, so this step runs before and after them.
 */
const present = new Set<string>();
async function tableExists(executor: Executor, name: string): Promise<boolean> {
  if (present.has(name)) return true;
  const result = await executor.execute(sql`select to_regclass(${`public.${name}`}) is not null as found`);
  const found = Boolean((result.rows[0] as { found?: boolean } | undefined)?.found);
  if (found) present.add(name);
  return found;
}

/** The user's public, live, not-taken-down Rees: the only ones the threshold counts. */
function countedRees(userId: string): SQL {
  return sql`select r.id from ${schema.ree} r where r.owner_id = ${userId} and r.is_public and r.is_published and r.moderated_at is null and r.deleted_at is null`;
}

export async function roleMetrics(executor: Executor, userId: string, now = new Date()): Promise<RoleMetrics> {
  const [account] = await executor.select({ createdAt: schema.user.createdAt }).from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  if (!account) throw new AdminInputError('not_found');
  const rees = countedRees(userId);
  const result = await executor.execute(sql`
    select
      (select count(*)::int from (${rees}) counted) as public_rees,
      (select count(*)::int from ${schema.knowledge} k
        where k.ree_id in (${rees}) and k.deleted_at is null and k.status = 'ready') as ready_sources,
      (select count(*)::int from ${schema.message} m
        join ${schema.conversation} c on c.id = m.conversation_id
        where m.role = 'ree' and m.ree_id in (${rees}) and c.user_id <> ${userId}) as external_questions`);
  const row = result.rows[0] as { public_rees: number; ready_sources: number; external_questions: number };
  let helpful = 0;
  let unhelpful = 0;
  if (await tableExists(executor, 'ree_feedback')) {
    const votes = await executor.execute(sql`
      select count(*) filter (where f.vote = 'up')::int as up, count(*) filter (where f.vote = 'down')::int as down
      from ree_feedback f join ${schema.message} m on m.id = f.message_id
      where m.ree_id in (${rees}) and f.user_id <> ${userId}`);
    const tally = votes.rows[0] as { up: number; down: number } | undefined;
    helpful = tally?.up ?? 0;
    unhelpful = tally?.down ?? 0;
  }
  return {
    registeredDays: registeredDays(account.createdAt, now),
    publicRees: row.public_rees,
    readySources: row.ready_sources,
    externalQuestions: row.external_questions,
    helpful,
    unhelpful,
    feedbackCount: helpful + unhelpful,
    helpfulRate: helpfulRate(helpful, unhelpful),
  };
}

/**
 * The checkpoint "有进行中提现的用户不能设为官方" (8.2): step 6 creates
 * `payout`; until then nobody has a payout in progress.
 */
export async function hasOpenPayout(executor: Executor, userId: string): Promise<boolean> {
  if (!(await tableExists(executor, 'payout'))) return false;
  const result = await executor.execute(sql`select 1 from payout where user_id = ${userId} and status in ('pending', 'approved') limit 1`);
  return result.rows.length > 0;
}

/* --------------------------------------------------------- role history */

export const ROLE_HISTORY_ACTIONS = ['user.role.official', 'user.role.cancel_official', 'user.role.revoke', 'verification.approved'] as const satisfies readonly AuditAction[];

export interface RoleEvent {
  id: string;
  action: string;
  from: UserRole;
  to: UserRole;
  reason: string;
  administrator: string | null;
  at: Date;
}

export async function roleHistory(executor: Executor, userId: string): Promise<RoleEvent[]> {
  const rows = await executor
    .select({ audit: schema.adminAudit, administrator: schema.administrator.email })
    .from(schema.adminAudit)
    .leftJoin(schema.administrator, eq(schema.administrator.id, schema.adminAudit.administratorId))
    .where(and(eq(schema.adminAudit.target, userId), inArray(schema.adminAudit.action, [...ROLE_HISTORY_ACTIONS])))
    .orderBy(desc(schema.adminAudit.createdAt));
  return rows.map(({ audit: row, administrator }) => {
    const before = (row.before ?? {}) as { role?: UserRole };
    const after = (row.after ?? {}) as { role?: UserRole; reason?: string };
    return {
      id: row.id,
      action: row.action,
      from: before.role ?? 'normal',
      to: after.role ?? 'normal',
      reason: after.reason ?? '',
      administrator,
      at: row.createdAt,
    };
  });
}

/* ------------------------------------------------------------- the user */

export interface VerificationOverview {
  role: UserRole;
  roleChangedAt: Date | null;
  metrics: RoleMetrics;
  checks: ReturnType<typeof verificationChecks>;
  access: VerificationAccess;
  requests: VerificationRow[];
  events: RoleEvent[];
}

async function requestsOf(executor: Executor, userId: string): Promise<VerificationRow[]> {
  return executor
    .select()
    .from(schema.verificationRequest)
    .where(eq(schema.verificationRequest.userId, userId))
    .orderBy(desc(schema.verificationRequest.createdAt));
}

export async function verificationOverview(userId: string, now = new Date()): Promise<VerificationOverview> {
  const database = db();
  const [account] = await database.select().from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  if (!account) throw new AdminInputError('not_found');
  const [metrics, requests, events] = await Promise.all([roleMetrics(database, userId, now), requestsOf(database, userId), roleHistory(database, userId)]);
  return {
    role: account.role,
    roleChangedAt: account.roleChangedAt,
    metrics,
    checks: verificationChecks(metrics),
    access: verificationAccess({ role: account.role, disabled: Boolean(account.disabledAt) }, requests, metrics, now),
    requests,
    events,
  };
}

export class VerificationRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'VerificationRefused';
  }
}

/**
 * Submits an application. The threshold is recomputed here, inside the
 * transaction that writes the row: what the page showed is never trusted.
 */
export async function applyForVerification(userId: string, raw: { statement?: unknown; links?: unknown }, now = new Date()): Promise<VerificationRow> {
  const input = parseVerificationInput(raw.statement, raw.links);
  if ('error' in input) throw new VerificationRefused(input.error);
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`verification:${userId}`}))`);
    const [account] = await tx.select().from(schema.user).where(eq(schema.user.id, userId)).for('update');
    if (!account) throw new VerificationRefused('not_found');
    const metrics = await roleMetrics(tx, userId, now);
    const access = verificationAccess({ role: account.role, disabled: Boolean(account.disabledAt) }, await requestsOf(tx, userId), metrics, now);
    if (!access.eligible) throw new VerificationRefused(access.reason!);
    const [row] = await tx
      .insert(schema.verificationRequest)
      .values({ userId, statement: input.statement, links: input.links, metrics, createdAt: now })
      .returning();
    return row!;
  });
}

/* ------------------------------------------------------------ the queue */

export interface VerificationListItem {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  statement: string;
  links: string[];
  metrics: RoleMetrics;
  passed: number;
  status: VerificationRow['status'];
  closedByRoleChange: boolean;
  createdAt: Date;
  decidedAt: Date | null;
  reviewer: string | null;
  rejectedReason: string | null;
}

function verificationWhere(view: Pick<VerificationsView, 'q' | 'status'>): SQL | undefined {
  const conditions: SQL[] = [];
  if (view.status !== 'all') conditions.push(eq(schema.verificationRequest.status, view.status));
  if (view.q) {
    const pattern = likePattern(view.q);
    conditions.push(
      or(
        ilike(schema.user.name, pattern),
        ilike(schema.user.email, pattern),
        ilike(schema.verificationRequest.statement, pattern),
        sql`${schema.verificationRequest.id}::text ilike ${pattern}`,
      )!,
    );
  }
  return conditions.length ? and(...conditions) : undefined;
}

const reviewer = sql<string | null>`(select a.email from ${schema.administrator} a where a.id = "verification_request"."reviewed_by")`;

export async function listVerifications(view: VerificationsView, options: { all?: boolean } = {}): Promise<ListResult<VerificationListItem> & { counts: Record<string, number> }> {
  const database = db();
  const where = verificationWhere(view);
  const [totalRow] = await database
    .select({ total: count() })
    .from(schema.verificationRequest)
    .innerJoin(schema.user, eq(schema.user.id, schema.verificationRequest.userId))
    .where(where);
  const total = totalRow?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  /* The queue reads oldest first; any other view newest first. */
  const order = view.status === 'pending' ? asc(schema.verificationRequest.createdAt) : desc(schema.verificationRequest.createdAt);
  let query = database
    .select({ request: schema.verificationRequest, name: schema.user.name, email: schema.user.email, role: schema.user.role, reviewer })
    .from(schema.verificationRequest)
    .innerJoin(schema.user, eq(schema.user.id, schema.verificationRequest.userId))
    .where(where)
    .orderBy(order, asc(schema.verificationRequest.id))
    .$dynamic();
  if (!options.all) query = query.limit(view.size).offset((page - 1) * view.size);
  const rows = await query;
  const tallies = await database
    .select({ status: schema.verificationRequest.status, n: count() })
    .from(schema.verificationRequest)
    .groupBy(schema.verificationRequest.status);
  const counts: Record<string, number> = { all: 0, pending: 0, approved: 0, rejected: 0, closed: 0 };
  for (const tally of tallies) {
    counts[tally.status] = tally.n;
    counts.all! += tally.n;
  }
  return {
    items: rows.map(({ request, name, email, role, reviewer: by }) => ({
      id: request.id,
      userId: request.userId,
      name,
      email,
      role,
      statement: request.statement,
      links: request.links,
      metrics: request.metrics,
      passed: verificationChecks(request.metrics).filter((check) => check.passed).length,
      status: request.status,
      closedByRoleChange: request.closedByRoleChange,
      createdAt: request.createdAt,
      decidedAt: request.decidedAt,
      reviewer: by,
      rejectedReason: request.rejectedReason,
    })),
    total,
    page,
    size: view.size,
    counts,
  };
}

export async function verificationDetail(id: string, now = new Date()) {
  const database = db();
  const [row] = await database
    .select({ request: schema.verificationRequest, user: schema.user, reviewer })
    .from(schema.verificationRequest)
    .innerJoin(schema.user, eq(schema.user.id, schema.verificationRequest.userId))
    .where(eq(schema.verificationRequest.id, id))
    .limit(1);
  if (!row) return null;
  const [current, rees] = await Promise.all([
    roleMetrics(database, row.user.id, now),
    database
      .select({
        id: schema.ree.id,
        name: schema.ree.name,
        slug: schema.ree.slug,
        avatarBlob: schema.ree.avatarBlob,
        color: schema.ree.color,
        readySources: sql<number>`(select count(*)::int from ${schema.knowledge} k where k.ree_id = "ree"."id" and k.deleted_at is null and k.status = 'ready')`,
      })
      .from(schema.ree)
      .where(and(eq(schema.ree.ownerId, row.user.id), eq(schema.ree.isPublic, true), eq(schema.ree.isPublished, true), sql`${schema.ree.moderatedAt} is null`, sql`${schema.ree.deletedAt} is null`))
      .orderBy(desc(schema.ree.createdAt)),
  ]);
  return {
    request: row.request,
    reviewer: row.reviewer,
    user: { id: row.user.id, name: row.user.name, email: row.user.email, role: row.user.role, disabled: Boolean(row.user.disabledAt) },
    current,
    rees,
  };
}

/**
 * Approve (the user becomes verified) or reject (a reason the user reads,
 * and the 30-day wait). Only a pending request of a normal, active user.
 */
export async function decideVerification(
  administratorId: string,
  id: string,
  decision: 'approved' | 'rejected',
  rawReason: unknown,
  now = new Date(),
): Promise<VerificationRow> {
  const note = typeof rawReason === 'string' ? rawReason.trim() : '';
  const reason = note ? parseRoleReason(note) : '';
  if (reason === null || (decision === 'rejected' && !reason)) throw new AdminInputError('reason');
  return db().transaction(async (tx) => {
    const [request] = await tx.select().from(schema.verificationRequest).where(eq(schema.verificationRequest.id, id)).for('update');
    if (!request) throw new AdminInputError('not_found');
    const [account] = await tx.select().from(schema.user).where(eq(schema.user.id, request.userId)).for('update');
    if (request.status !== 'pending' || !account || account.role !== 'normal') throw new AdminInputError('stale');
    if (decision === 'approved' && account.disabledAt) throw new AdminInputError('disabled');
    const [updated] = await tx
      .update(schema.verificationRequest)
      .set({ status: decision, rejectedReason: reason || null, reviewedBy: administratorId, decidedAt: now })
      .where(eq(schema.verificationRequest.id, id))
      .returning();
    if (decision === 'approved') {
      await tx.update(schema.user).set({ role: 'verified', roleChangedAt: now }).where(eq(schema.user.id, account.id));
    }
    await audit(tx, {
      administratorId,
      action: decision === 'approved' ? 'verification.approved' : 'verification.rejected',
      target: account.id,
      before: { role: account.role, request: id },
      after: { role: decision === 'approved' ? 'verified' : account.role, reason, request: id },
    });
    await notify(tx, { userId: account.id, kind: 'verification', text: reason, params: { decision }, refId: id });
    return updated!;
  });
}

/**
 * Make official, cancel official, revoke a verification (2.7), always with a
 * reason the user reads. Making a user official is refused while a payout is
 * in progress, and closes a pending application without starting the wait.
 */
export async function changeRole(administratorId: string, userId: string, action: RoleAction, rawReason: unknown, now = new Date()): Promise<UserRole> {
  const reason = parseRoleReason(rawReason);
  if (!reason) throw new AdminInputError('reason');
  return db().transaction(async (tx) => {
    const [account] = await tx.select().from(schema.user).where(eq(schema.user.id, userId)).for('update');
    if (!account) throw new AdminInputError('not_found');
    const next = roleAfter(account.role, action);
    if (!next) throw new AdminInputError('stale');
    if (next === 'official' && (await hasOpenPayout(tx, userId))) throw new AdminInputError('payout_pending');
    await tx.update(schema.user).set({ role: next, roleChangedAt: now }).where(eq(schema.user.id, userId));
    let closed: string[] = [];
    if (next === 'official') {
      const rows = await tx
        .update(schema.verificationRequest)
        .set({ status: 'closed', closedByRoleChange: true, reviewedBy: administratorId, decidedAt: now })
        .where(and(eq(schema.verificationRequest.userId, userId), eq(schema.verificationRequest.status, 'pending')))
        .returning({ id: schema.verificationRequest.id });
      closed = rows.map((row) => row.id);
    }
    await audit(tx, {
      administratorId,
      action: `user.role.${action}`,
      target: userId,
      before: { role: account.role },
      after: { role: next, reason, ...(closed.length ? { closedRequests: closed } : {}) },
    });
    await notify(tx, { userId, kind: 'role', text: reason, params: { from: account.role, to: next } });
    return next;
  });
}

/** Pending applications, for the console's badge and overview. */
export async function pendingVerifications(executor: Executor = db()): Promise<number> {
  const [row] = await executor.select({ n: count() }).from(schema.verificationRequest).where(eq(schema.verificationRequest.status, 'pending'));
  return row?.n ?? 0;
}

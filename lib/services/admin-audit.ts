/**
 * The audit trail (2.5 "审计"): read-only, filtered by the one list of action
 * codes the writers use (8.3), with each row's before and after.
 */
import { and, asc, count, countDistinct, desc, eq, gte, ilike, or, sql, type SQL } from 'drizzle-orm';
import { periodStart, type AuditView } from '@/lib/domain/admin-lists';
import { clampPage, likePattern, type ListResult } from '@/lib/domain/list';
import { db, schema } from '@/lib/infra/db';

export interface AuditRow {
  id: string;
  action: string;
  target: string | null;
  administrator: string | null;
  administratorId: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

function auditWhere(view: AuditView, now: Date): SQL | undefined {
  const conditions: SQL[] = [];
  if (view.action !== 'all') conditions.push(eq(schema.adminAudit.action, view.action));
  const since = periodStart(view.period, now);
  if (since) conditions.push(gte(schema.adminAudit.createdAt, since));
  if (view.q) {
    const pattern = likePattern(view.q);
    conditions.push(
      or(
        ilike(schema.adminAudit.action, pattern),
        ilike(schema.adminAudit.target, pattern),
        ilike(schema.administrator.email, pattern),
        ilike(schema.administrator.name, pattern),
        sql`${schema.adminAudit.id}::text ilike ${pattern}`,
      )!,
    );
  }
  return conditions.length ? and(...conditions) : undefined;
}

export async function listAudit(view: AuditView, options: { all?: boolean } = {}, now = new Date()): Promise<ListResult<AuditRow>> {
  const database = db();
  const where = auditWhere(view, now);
  const [counted] = await database
    .select({ total: count() })
    .from(schema.adminAudit)
    .leftJoin(schema.administrator, eq(schema.administrator.id, schema.adminAudit.administratorId))
    .where(where);
  const total = counted?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  let query = database
    .select({
      id: schema.adminAudit.id,
      action: schema.adminAudit.action,
      target: schema.adminAudit.target,
      administrator: schema.administrator.email,
      administratorId: schema.adminAudit.administratorId,
      before: schema.adminAudit.before,
      after: schema.adminAudit.after,
      createdAt: schema.adminAudit.createdAt,
    })
    .from(schema.adminAudit)
    .leftJoin(schema.administrator, eq(schema.administrator.id, schema.adminAudit.administratorId))
    .where(where)
    .orderBy(view.sort === 'oldest' ? asc(schema.adminAudit.createdAt) : desc(schema.adminAudit.createdAt), asc(schema.adminAudit.id))
    .$dynamic();
  if (!options.all) query = query.limit(view.size).offset((page - 1) * view.size);
  return { items: await query, total, page, size: view.size };
}

export async function auditCounts() {
  const [row] = await db()
    .select({ total: count(), administrators: countDistinct(schema.adminAudit.administratorId), actions: countDistinct(schema.adminAudit.action) })
    .from(schema.adminAudit);
  return row ?? { total: 0, administrators: 0, actions: 0 };
}

export async function auditEntry(id: string): Promise<AuditRow | null> {
  const [row] = await db()
    .select({
      id: schema.adminAudit.id,
      action: schema.adminAudit.action,
      target: schema.adminAudit.target,
      administrator: schema.administrator.email,
      administratorId: schema.adminAudit.administratorId,
      before: schema.adminAudit.before,
      after: schema.adminAudit.after,
      createdAt: schema.adminAudit.createdAt,
    })
    .from(schema.adminAudit)
    .leftJoin(schema.administrator, eq(schema.administrator.id, schema.adminAudit.administratorId))
    .where(eq(schema.adminAudit.id, id))
    .limit(1);
  return row ?? null;
}

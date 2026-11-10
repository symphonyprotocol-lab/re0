/**
 * The console's Rees (2.5 "Rees", 8.2 "后台 Rees 列表" / "后台 Ree 详情"):
 * every Ree with its owner, filtered by public / private / taken down; one
 * Ree's overview, sources, usage and management log; a read-only preview of
 * a source; and the takedown and restore.
 *
 * A takedown turns the Ree private, marks it moderated (its owner cannot
 * republish it), removes it from other people's conversations (history
 * stays, as when an owner makes a Ree private) and out of discovery, and
 * tells the owner why. Restoring makes it public again and rebuilds its
 * discovery profile.
 */
import { and, asc, count, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { ADMIN_SOURCE_PAGE_SIZE } from '@/lib/constants';
import { parseAdminReason } from '@/lib/domain/adjustments';
import type { ReesView } from '@/lib/domain/admin-lists';
import { clampPage, likePattern, param, type ListResult } from '@/lib/domain/list';
import { db, schema } from '@/lib/infra/db';
import { AdminInputError, audit, assertConsole, type Administrator } from '@/lib/services/admin';
import { detachRee } from '@/lib/services/conversations';
import { notify } from '@/lib/services/notices';
import { refreshProfile } from '@/lib/services/profile';
import { sourceState, sourceSummary } from '@/lib/services/statistics';

export type ReeVisibility = 'public' | 'private' | 'moderated';

export interface AdminReeRow {
  id: string;
  name: string;
  slug: string;
  avatarBlob: string | null;
  color: string;
  visibility: ReeVisibility;
  deleted: boolean;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  ownerRole: 'normal' | 'verified' | 'official';
  queryFee: number;
  sources: number;
  readySources: number;
  createdAt: Date;
  moderatedAt: Date | null;
  moderatedReason: string | null;
}

const visibility = sql<ReeVisibility>`case when "ree"."moderated_at" is not null then 'moderated' when "ree"."is_public" then 'public' else 'private' end`;
const sources = sql<number>`(select count(*)::int from ${schema.knowledge} k where k.ree_id = "ree"."id" and k.deleted_at is null)`;
const readySources = sql<number>`(select count(*)::int from ${schema.knowledge} k where k.ree_id = "ree"."id" and k.deleted_at is null and k.status = 'ready')`;

/** Deleted Rees stay out of the console's list, as they are out of their owner's. */
function reesWhere(view: ReesView): SQL {
  const conditions: SQL[] = [isNull(schema.ree.deletedAt)];
  if (view.status !== 'all') conditions.push(sql`${visibility} = ${view.status}`);
  if (view.q) {
    const pattern = likePattern(view.q);
    conditions.push(
      or(
        ilike(schema.ree.name, pattern),
        ilike(schema.ree.slug, pattern),
        sql`${schema.ree.id}::text ilike ${pattern}`,
        ilike(schema.user.name, pattern),
        ilike(schema.user.email, pattern),
      )!,
    );
  }
  return and(...conditions)!;
}

export async function listAdminRees(administrator: Administrator, view: ReesView, options: { all?: boolean } = {}): Promise<ListResult<AdminReeRow>> {
  assertConsole(administrator);
  const database = db();
  const where = reesWhere(view);
  const [counted] = await database.select({ total: count() }).from(schema.ree).innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId)).where(where);
  const total = counted?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  let query = database
    .select({
      id: schema.ree.id,
      name: schema.ree.name,
      slug: schema.ree.slug,
      avatarBlob: schema.ree.avatarBlob,
      color: schema.ree.color,
      visibility,
      deletedAt: schema.ree.deletedAt,
      ownerId: schema.ree.ownerId,
      ownerName: schema.user.name,
      ownerEmail: schema.user.email,
      ownerRole: schema.user.role,
      queryFee: schema.ree.queryFee,
      sources,
      readySources,
      createdAt: schema.ree.createdAt,
      moderatedAt: schema.ree.moderatedAt,
      moderatedReason: schema.ree.moderatedReason,
    })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(where)
    .orderBy(view.sort === 'oldest' ? asc(schema.ree.createdAt) : desc(schema.ree.createdAt), asc(schema.ree.id))
    .$dynamic();
  if (!options.all) query = query.limit(view.size).offset((page - 1) * view.size);
  const rows = await query;
  return { items: rows.map(({ deletedAt, ...row }) => ({ ...row, deleted: Boolean(deletedAt) })), total, page, size: view.size };
}

export async function reeCounts() {
  const [row] = await db()
    .select({
      total: count(),
      public: sql<number>`count(*) filter (where ${visibility} = 'public')::int`,
      private: sql<number>`count(*) filter (where ${visibility} = 'private')::int`,
      moderated: sql<number>`count(*) filter (where ${visibility} = 'moderated')::int`,
    })
    .from(schema.ree)
    .where(isNull(schema.ree.deletedAt));
  return row ?? { total: 0, public: 0, private: 0, moderated: 0 };
}

export async function adminRee(administrator: Administrator, id: string) {
  assertConsole(administrator);
  const database = db();
  const [row] = await database
    .select({ ree: schema.ree, ownerName: schema.user.name, ownerEmail: schema.user.email, ownerRole: schema.user.role, visibility })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(eq(schema.ree.id, id))
    .limit(1);
  if (!row) return null;
  const [summary, [video]] = await Promise.all([
    sourceSummary([id]),
    database
      .select({ reeId: schema.reeVideo.reeId })
      .from(schema.reeVideo)
      .where(and(eq(schema.reeVideo.reeId, id), eq(schema.reeVideo.generated, true)))
      .limit(1),
  ]);
  /* 视频介绍 已制作 once a script has been generated (prototype admin-ree-detail.js `video.generated`). */
  return { ...row, sources: summary, hasVideo: Boolean(video) };
}
export type AdminReeDetail = NonNullable<Awaited<ReturnType<typeof adminRee>>>;

/* -------------------------------------------------------------- sources */

export const ADMIN_SOURCE_STATES = ['all', 'ready', 'processing', 'failed', 'paused'] as const;
type Params = URLSearchParams | Record<string, string | string[] | undefined>;

export function sourceFilter(params: Params) {
  const status = param(params, 'sourceStatus');
  const page = Number(param(params, 'sourcePage'));
  return {
    q: param(params, 'sourceQ').trim().slice(0, 400),
    status: (ADMIN_SOURCE_STATES as readonly string[]).includes(status) ? (status as (typeof ADMIN_SOURCE_STATES)[number]) : 'all',
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}
export type SourceFilter = ReturnType<typeof sourceFilter>;

function sourcesWhere(reeId: string, filter: SourceFilter): SQL {
  const conditions: SQL[] = [eq(schema.knowledge.reeId, reeId), isNull(schema.knowledge.deletedAt)];
  if (filter.status !== 'all') conditions.push(sql`${sourceState} = ${filter.status}`);
  if (filter.q) conditions.push(ilike(schema.knowledge.title, likePattern(filter.q)));
  return and(...conditions)!;
}

const sourceOrder = [desc(schema.knowledge.updatedAt), desc(schema.knowledge.id)] as const;

export async function adminReeSources(administrator: Administrator, reeId: string, filter: SourceFilter) {
  assertConsole(administrator);
  const database = db();
  const where = sourcesWhere(reeId, filter);
  const [counted] = await database.select({ total: count() }).from(schema.knowledge).where(where);
  const total = counted?.total ?? 0;
  const page = clampPage(filter.page, total, ADMIN_SOURCE_PAGE_SIZE);
  const items = await database
    .select({ id: schema.knowledge.id, title: schema.knowledge.title, kind: schema.knowledge.kind, state: sourceState, updatedAt: schema.knowledge.updatedAt })
    .from(schema.knowledge)
    .where(where)
    .orderBy(...sourceOrder)
    .limit(ADMIN_SOURCE_PAGE_SIZE)
    .offset((page - 1) * ADMIN_SOURCE_PAGE_SIZE);
  return { items, total, page, size: ADMIN_SOURCE_PAGE_SIZE };
}

/** One source, read-only, with its neighbours in the filtered list for previous / next. */
export async function adminReeSource(administrator: Administrator, reeId: string, knowledgeId: string, filter: SourceFilter) {
  assertConsole(administrator);
  const database = db();
  const [row] = await database
    .select({
      id: schema.knowledge.id,
      title: schema.knowledge.title,
      kind: schema.knowledge.kind,
      source: schema.knowledge.source,
      fileName: schema.knowledge.fileName,
      fileSize: schema.knowledge.fileSize,
      status: schema.knowledge.status,
      state: sourceState,
      error: schema.knowledge.error,
      content: schema.knowledge.content,
      children: schema.knowledge.children,
      deletedAt: schema.knowledge.deletedAt,
      createdAt: schema.knowledge.createdAt,
      updatedAt: schema.knowledge.updatedAt,
    })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.reeId, reeId)))
    .limit(1);
  if (!row) return null;
  const ids = (await database.select({ id: schema.knowledge.id }).from(schema.knowledge).where(sourcesWhere(reeId, filter)).orderBy(...sourceOrder)).map((entry) => entry.id);
  const at = ids.indexOf(knowledgeId);
  const [chunks] = await database.select({ n: count() }).from(schema.chunk).where(eq(schema.chunk.knowledgeId, knowledgeId));
  return {
    source: row,
    chunks: chunks?.n ?? 0,
    position: at >= 0 ? at + 1 : null,
    total: ids.length,
    previous: at > 0 ? ids[at - 1]! : null,
    next: at >= 0 && at < ids.length - 1 ? ids[at + 1]! : null,
  };
}

/* ----------------------------------------------------------- management */

export async function reeAudit(administrator: Administrator, reeId: string) {
  assertConsole(administrator);
  return db()
    .select({ audit: schema.adminAudit, administrator: schema.administrator.email })
    .from(schema.adminAudit)
    .leftJoin(schema.administrator, eq(schema.administrator.id, schema.adminAudit.administratorId))
    .where(eq(schema.adminAudit.target, reeId))
    .orderBy(desc(schema.adminAudit.createdAt));
}

/**
 * The Ree's place in discovery after a takedown or restore: step 4's profile
 * vectors exist only for public Rees, so this removes or rebuilds them. A
 * model failure here does not undo the decision; the next knowledge run
 * rebuilds the profile.
 */
async function refreshDiscovery(reeId: string): Promise<void> {
  try {
    await refreshProfile(reeId);
  } catch (error) {
    console.warn(`profile refresh after moderation failed ree=${reeId}`, error instanceof Error ? error.message : error);
  }
}

export async function takeDownRee(administratorId: string, reeId: string, rawReason: unknown, now = new Date()) {
  const reason = parseAdminReason(rawReason);
  if (!reason) throw new AdminInputError('reason');
  await db().transaction(async (tx) => {
    const [ree] = await tx.select().from(schema.ree).where(eq(schema.ree.id, reeId)).for('update');
    if (!ree) throw new AdminInputError('not_found');
    if (ree.deletedAt || ree.moderatedAt || !ree.isPublic) throw new AdminInputError('stale');
    await tx
      .update(schema.ree)
      .set({ isPublic: false, isPublished: false, moderatedAt: now, moderatedBy: administratorId, moderatedReason: reason, updatedAt: now })
      .where(eq(schema.ree.id, reeId));
    /* Out of other people's conversations, history kept, as when an owner makes a Ree private (step 4). */
    const conversations = await detachRee(tx, reeId, { includeOwner: false });
    await audit(tx, {
      administratorId,
      action: 'ree.takedown',
      target: reeId,
      before: { visibility: 'public', name: ree.name },
      after: { visibility: 'moderated', reason, conversationsLeft: conversations },
    });
    await notify(tx, { userId: ree.ownerId, kind: 'takedown', text: reason, params: { ree: ree.name, reeId }, refId: reeId });
  });
  await refreshDiscovery(reeId);
}

export async function restoreRee(administratorId: string, reeId: string, rawReason: unknown, now = new Date()) {
  const reason = parseAdminReason(rawReason);
  if (!reason) throw new AdminInputError('reason');
  await db().transaction(async (tx) => {
    const [ree] = await tx.select().from(schema.ree).where(eq(schema.ree.id, reeId)).for('update');
    if (!ree) throw new AdminInputError('not_found');
    if (ree.deletedAt || !ree.moderatedAt) throw new AdminInputError('stale');
    await tx
      .update(schema.ree)
      .set({ isPublic: true, isPublished: true, moderatedAt: null, moderatedBy: null, moderatedReason: null, updatedAt: now })
      .where(eq(schema.ree.id, reeId));
    await audit(tx, {
      administratorId,
      action: 'ree.restore',
      target: reeId,
      before: { visibility: 'moderated', reason: ree.moderatedReason },
      after: { visibility: 'public', reason },
    });
    await notify(tx, { userId: ree.ownerId, kind: 'restore', text: reason, params: { ree: ree.name, reeId }, refId: reeId });
  });
  await refreshDiscovery(reeId);
}

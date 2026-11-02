/**
 * In-app notices (8.2, "通知"): a list in settings and a dot in the sidebar,
 * nothing sent by email. Written in the same transaction as the change they
 * report, so a notice never describes something that did not happen.
 */
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { NOTICE_PAGE_SIZE } from '@/lib/constants';
import { clampPage, type ListResult } from '@/lib/domain/list';
import { db, schema, type Executor } from '@/lib/infra/db';
import type { NoticeKind } from '@/db/schema';

export type NoticeRow = typeof schema.notice.$inferSelect;

export async function notify(
  executor: Executor,
  input: { userId: string; kind: NoticeKind; text?: string; params?: Record<string, string | number | null>; refId?: string | null },
): Promise<void> {
  await executor.insert(schema.notice).values({
    userId: input.userId,
    kind: input.kind,
    text: input.text ?? '',
    params: input.params ?? {},
    refId: input.refId ?? null,
  });
}

export async function unreadNotices(userId: string): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(schema.notice)
    .where(and(eq(schema.notice.userId, userId), isNull(schema.notice.readAt)));
  return row?.n ?? 0;
}

export async function listNotices(userId: string, page: number): Promise<ListResult<NoticeRow> & { unread: number }> {
  const database = db();
  const [totals] = await database
    .select({ total: count(), unread: sql<number>`count(*) filter (where ${schema.notice.readAt} is null)::int` })
    .from(schema.notice)
    .where(eq(schema.notice.userId, userId));
  const total = totals?.total ?? 0;
  const current = clampPage(page, total, NOTICE_PAGE_SIZE);
  const items = await database
    .select()
    .from(schema.notice)
    .where(eq(schema.notice.userId, userId))
    .orderBy(desc(schema.notice.createdAt), desc(schema.notice.id))
    .limit(NOTICE_PAGE_SIZE)
    .offset((current - 1) * NOTICE_PAGE_SIZE);
  return { items, total, page: current, size: NOTICE_PAGE_SIZE, unread: totals?.unread ?? 0 };
}

/** Marks the given notices read, or all of them; only the user's own. */
export async function markNoticesRead(userId: string, ids: readonly string[] | 'all', now = new Date()): Promise<number> {
  const conditions = [eq(schema.notice.userId, userId), isNull(schema.notice.readAt)];
  if (ids !== 'all') {
    if (!ids.length) return 0;
    conditions.push(inArray(schema.notice.id, [...ids]));
  }
  const rows = await db()
    .update(schema.notice)
    .set({ readAt: now })
    .where(and(...conditions))
    .returning({ id: schema.notice.id });
  return rows.length;
}

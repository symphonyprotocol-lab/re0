/**
 * In-app notifications. agent-first-proposal.md 6.5, 6.7, 6.8.
 *
 * A new post or episode for each current subscriber of its channel, a new
 * comment or question for the creator, a reply for the reader replied to,
 * and a scheduled publication the drain could not make, for the creator.
 * The payload carries ids and titles only -- never a comment's body, which
 * is the commenter's to delete. Email is not sent: it is optional and off
 * by default, and there is no mail transport yet.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema, type Database } from '@/lib/infrastructure/postgres/client';
import type { Tx } from '@/lib/application/plans/quota';

export const NOTIFICATION_KINDS = ['new_post', 'new_comment', 'comment_reply', 'new_question', 'question_answered', 'publish_failed'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

type Executor = Tx | Database;

export async function notify(
  userIds: readonly string[],
  kind: NotificationKind,
  payload: Record<string, unknown>,
  executor: Executor = db(),
): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await executor.insert(schema.notification).values(unique.map((userId) => ({ id: uuidv7(), userId, kind, payload })));
}

/** The people who run a workspace: whom a creator-side notification goes to. */
export async function workspaceManagers(workspaceId: string, executor: Executor = db()): Promise<string[]> {
  const rows = await executor
    .select({ userId: schema.workspaceMember.userId })
    .from(schema.workspaceMember)
    .where(and(eq(schema.workspaceMember.workspaceId, workspaceId), inArray(schema.workspaceMember.role, ['owner', 'admin'])));
  return rows.map((row) => row.userId);
}

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: Date;
}

export async function listNotifications(userId: string, limit = 50): Promise<NotificationItem[]> {
  const rows = await db()
    .select()
    .from(schema.notification)
    .where(eq(schema.notification.userId, userId))
    .orderBy(desc(schema.notification.createdAt), desc(schema.notification.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as NotificationKind,
    payload: row.payload,
    read: row.readAt !== null,
    createdAt: row.createdAt,
  }));
}

export async function unreadNotifications(userId: string): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.notification)
    .where(and(eq(schema.notification.userId, userId), isNull(schema.notification.readAt)));
  return row?.n ?? 0;
}

export async function markNotificationsRead(userId: string): Promise<void> {
  await db()
    .update(schema.notification)
    .set({ readAt: new Date() })
    .where(and(eq(schema.notification.userId, userId), isNull(schema.notification.readAt)));
}

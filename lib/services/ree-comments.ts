import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ReeComment, ReeCommentPage } from '@/lib/domain/ree-comment';
import { db, schema } from '@/lib/infra/db';
import { publicRee } from '@/lib/services/explore';
import type { SessionUser } from '@/lib/services/auth';
import { grantTaskReward } from '@/lib/services/task-rewards';

const PAGE_SIZE = 20;
const { ree, reeComment, user } = schema;

export async function listReeComments(reeId: string, before?: string, viewerId?: string): Promise<ReeCommentPage | null> {
  const conn = db();
  const cursor = alias(reeComment, 'cursor_comment');
  const boundary = conn.select({ createdAt: cursor.createdAt, id: cursor.id }).from(cursor)
    .where(and(eq(cursor.id, before ?? reeId), eq(cursor.reeId, reeId)));
  const page = conn.select({
    id: reeComment.id,
    content: reeComment.content,
    createdAt: reeComment.createdAt,
    authorName: user.name,
    authorAvatar: user.avatarBlob,
    authorId: reeComment.userId,
  })
    .from(reeComment)
    .innerJoin(user, eq(user.id, reeComment.userId))
    .where(and(eq(reeComment.reeId, reeId), before
      ? sql`(${reeComment.createdAt}, ${reeComment.id}) < (${boundary})`
      : undefined))
    .orderBy(desc(reeComment.createdAt), desc(reeComment.id))
    .limit(PAGE_SIZE + 1)
    .as('comment_page');

  const rows = await conn.select({
    comment: {
      id: page.id,
      content: page.content,
      createdAt: page.createdAt,
      authorName: page.authorName,
      authorAvatar: page.authorAvatar,
      authorId: page.authorId,
    },
    ownerId: ree.ownerId,
    total: sql<number>`(select count(*)::int from ${reeComment} where ${reeComment.reeId} = ${ree.id})`,
  })
    .from(ree)
    .leftJoinLateral(page, sql`true`)
    .where(and(eq(ree.id, reeId), publicRee()))
    .orderBy(desc(page.createdAt), desc(page.id));

  if (!rows[0]) return null;
  const ownerId = rows[0].ownerId;
  const items = rows.slice(0, PAGE_SIZE).flatMap(({ comment }) => {
    if (!comment) return [];
    const { authorId, ...shown } = comment;
    return [{ ...shown, createdAt: comment.createdAt.toISOString(), canDelete: Boolean(viewerId) && (viewerId === authorId || viewerId === ownerId) }];
  });
  return { items, total: rows[0].total, next: rows.length > PAGE_SIZE ? items.at(-1)!.id : null };
}

export async function addReeComment(
  reeId: string,
  author: Pick<SessionUser, 'id' | 'name' | 'avatarBlob'>,
  input: { id: string; content: string },
): Promise<ReeComment | 'conflict' | null> {
  return db().transaction(async (tx) => {
    // Serialize the publication check with changes to visibility.
    const [target] = await tx.select({ id: ree.id }).from(ree)
      .where(and(eq(ree.id, reeId), publicRee())).for('share');
    if (!target) return null;

    const [inserted] = await tx.insert(reeComment)
      .values({ ...input, reeId, userId: author.id })
      .onConflictDoNothing({ target: reeComment.id })
      .returning();
    // An interrupted request can be retried with the same ID.
    const [saved] = inserted ? [inserted] : await tx.select().from(reeComment).where(and(
      eq(reeComment.id, input.id),
      eq(reeComment.reeId, reeId),
      eq(reeComment.userId, author.id),
      eq(reeComment.content, input.content),
    ));
    if (!saved) return 'conflict';
    /* 新手任务: a first comment pays once; a retried request inserts nothing and pays nothing. */
    if (inserted) await grantTaskReward(tx, author.id, 'first_comment', inserted.id);
    return {
      id: saved.id,
      content: saved.content,
      createdAt: saved.createdAt.toISOString(),
      authorName: author.name,
      authorAvatar: author.avatarBlob,
      canDelete: true,
    };
  });
}

/**
 * Deletes a comment for its author or the Ree's owner, whatever the Ree's
 * state (an owner tidying an unpublished Ree still may). Deleting what is
 * already gone, or what the viewer may not delete, answers false.
 */
export async function deleteReeComment(reeId: string, commentId: string, viewerId: string): Promise<boolean> {
  const deleted = await db().delete(reeComment).where(and(
    eq(reeComment.id, commentId),
    eq(reeComment.reeId, reeId),
    sql`(${reeComment.userId} = ${viewerId} or exists (select 1 from ${ree} where ${ree.id} = ${reeComment.reeId} and ${ree.ownerId} = ${viewerId}))`,
  )).returning({ id: reeComment.id });
  return deleted.length > 0;
}

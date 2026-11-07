import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ReeComment, ReeCommentPage } from '@/lib/domain/ree-comment';
import { db, schema } from '@/lib/infra/db';
import { publicRee } from '@/lib/services/explore';
import type { SessionUser } from '@/lib/services/auth';

const PAGE_SIZE = 20;
const { ree, reeComment, user } = schema;

export async function listReeComments(reeId: string, before?: string): Promise<ReeCommentPage | null> {
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
    },
    total: sql<number>`(select count(*)::int from ${reeComment} where ${reeComment.reeId} = ${ree.id})`,
  })
    .from(ree)
    .leftJoinLateral(page, sql`true`)
    .where(and(eq(ree.id, reeId), publicRee()))
    .orderBy(desc(page.createdAt), desc(page.id));

  if (!rows[0]) return null;
  const items = rows.slice(0, PAGE_SIZE).flatMap(({ comment }) =>
    comment ? [{ ...comment, createdAt: comment.createdAt.toISOString() }] : [],
  );
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
    return {
      id: saved.id,
      content: saved.content,
      createdAt: saved.createdAt.toISOString(),
      authorName: author.name,
      authorAvatar: author.avatarBlob,
    };
  });
}

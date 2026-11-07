import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { REE_PAGE_SIZES } from '@/lib/constants';
import { clampPage } from '@/lib/domain/list';
import { db, schema } from '@/lib/infra/db';
import { publicRee } from '@/lib/services/explore';

const { ree, reeFavorite, user } = schema;

function canFavorite(userId: string) {
  return and(ne(ree.ownerId, userId), publicRee());
}

/** Only the current viewer's marks, batched for the Rees already visible on a page. */
export async function favoriteReeIds(userId: string, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db().select({ id: reeFavorite.reeId }).from(reeFavorite)
    .where(and(eq(reeFavorite.userId, userId), inArray(reeFavorite.reeId, [...new Set(ids)])));
  return rows.map(({ id }) => id);
}

export async function listFavoriteRees(userId: string, requestedPage: number) {
  const size = REE_PAGE_SIZES[0];
  const where = and(eq(reeFavorite.userId, userId), canFavorite(userId));
  return db().transaction(async (tx) => {
    const [{ total } = { total: 0 }] = await tx.select({ total: sql<number>`count(*)::int` })
      .from(reeFavorite).innerJoin(ree, eq(ree.id, reeFavorite.reeId)).where(where);
    const page = clampPage(requestedPage, total, size);
    const items = await tx.select({
      id: ree.id,
      name: ree.name,
      slug: ree.slug,
      description: ree.description,
      avatarBlob: ree.avatarBlob,
      color: ree.color,
      ownerName: user.name,
    })
      .from(reeFavorite)
      .innerJoin(ree, eq(ree.id, reeFavorite.reeId))
      .innerJoin(user, eq(user.id, ree.ownerId))
      .where(where)
      .orderBy(desc(reeFavorite.createdAt), desc(reeFavorite.reeId))
      .limit(size)
      .offset((page - 1) * size);
    return { items, total, page, size };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** An idempotent write. A stale card cannot favorite a Ree that just became inaccessible. */
export async function setReeFavorite(userId: string, reeId: string, favorite: boolean): Promise<boolean> {
  if (!favorite) {
    await db().delete(reeFavorite).where(and(eq(reeFavorite.userId, userId), eq(reeFavorite.reeId, reeId)));
    return true;
  }
  return db().transaction(async (tx) => {
    const [target] = await tx.select({ id: ree.id }).from(ree)
      .where(and(eq(ree.id, reeId), canFavorite(userId))).for('share');
    if (!target) return false;
    await tx.insert(reeFavorite).values({ userId, reeId }).onConflictDoNothing();
    return true;
  });
}

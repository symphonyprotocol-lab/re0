import { TEST_DATABASE_URL, uniqueName } from './setup';
import { describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PUT, DELETE } from '@/app/api/rees/[id]/favorite/route';
import { SESSION_COOKIE } from '@/lib/http/cookies';
import { db, schema } from '@/lib/infra/db';
import { sessionTokenHash } from '@/lib/services/auth';
import { favoriteReeIds, listFavoriteRees } from '@/lib/services/ree-favorites';
import { deleteRee } from '@/lib/services/rees';

let token: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => name === SESSION_COOKIE && token ? { value: token } : undefined }),
}));

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const origin = 'http://localhost:3000';

function write(method: 'PUT' | 'DELETE', id: string, from = origin) {
  const request = new Request(`${origin}/api/rees/${id}/favorite`, { method, headers: { origin: from } });
  return (method === 'PUT' ? PUT : DELETE)(request, { params: Promise.resolve({ id }) });
}

suite('Ree favorites', () => {
  it('keeps favorites per account and only lists Rees the viewer can currently access', async () => {
    const conn = db();
    const [viewer, creator] = await conn.insert(schema.user).values(['viewer', 'creator'].map(name => ({
      name,
      email: `${name}@example.test`,
      provider: 'github' as const,
      providerSubject: uniqueName(name),
    }))).returning({ id: schema.user.id });
    const [published, own, otherPrivate] = await conn.insert(schema.ree).values([
      { ownerId: creator!.id, name: 'Public Ree', isPublic: true, isPublished: true },
      { ownerId: viewer!.id, name: 'Own public Ree', isPublic: true, isPublished: true },
      { ownerId: creator!.id, name: 'Someone else’s private Ree' },
    ].map(ree => ({ ...ree, slug: uniqueName('favorite-ree') }))).returning({ id: schema.ree.id });
    const ids = [published!.id, own!.id, otherPrivate!.id];
    const favoriteIds = async () => (await listFavoriteRees(viewer!.id, 1)).items.map(item => item.id);
    try {
      expect((await write('PUT', published!.id)).status).toBe(401);
      expect((await write('DELETE', published!.id)).status).toBe(401);
      token = crypto.randomUUID();
      await conn.insert(schema.session).values({
        id: await sessionTokenHash(token),
        userId: viewer!.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect((await write('PUT', published!.id, 'https://other.example.test')).status).toBe(403);
      expect((await write('PUT', otherPrivate!.id)).status).toBe(404);
      expect((await write('PUT', 'invalid-id')).status).toBe(404);
      const saves = await Promise.all([write('PUT', published!.id), write('PUT', published!.id)]);
      for (const response of saves) expect(await response.json()).toEqual({ favorite: true });
      expect((await write('PUT', own!.id)).status).toBe(404);
      expect(await favoriteReeIds(viewer!.id, ids)).toEqual([published!.id]);
      await conn.insert(schema.reeFavorite).values({ userId: viewer!.id, reeId: own!.id });
      expect(await favoriteIds()).toEqual([published!.id]);
      expect(await favoriteReeIds(creator!.id, ids)).toEqual([]);
      expect((await listFavoriteRees(creator!.id, 1)).items).toEqual([]);

      await conn.update(schema.ree).set({ isPublished: false }).where(eq(schema.ree.id, published!.id));
      expect(await favoriteIds()).toEqual([]);
      expect((await write('PUT', published!.id)).status).toBe(404);
      await conn.update(schema.ree).set({ isPublished: true }).where(eq(schema.ree.id, published!.id));
      expect(await favoriteIds()).toEqual([published!.id]);

      expect(await (await write('DELETE', published!.id)).json()).toEqual({ favorite: false });
      expect((await write('DELETE', published!.id)).status).toBe(200);
      await deleteRee(viewer!.id, own!.id);
      expect((await write('PUT', own!.id)).status).toBe(404);
      expect(await listFavoriteRees(viewer!.id, 2)).toMatchObject({ items: [], total: 0, page: 1 });
    } finally {
      token = undefined;
      await conn.delete(schema.ree).where(inArray(schema.ree.id, ids));
      await conn.delete(schema.user).where(inArray(schema.user.id, [viewer!.id, creator!.id]));
    }
  });
});

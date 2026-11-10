import { TEST_DATABASE_URL, uniqueName } from './setup';
import { describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/rees/[id]/comments/route';
import { DELETE } from '@/app/api/rees/[id]/comments/[commentId]/route';
import { USER_RATE_LIMITS } from '@/lib/constants';
import { SESSION_COOKIE } from '@/lib/http/cookies';
import { db, schema } from '@/lib/infra/db';
import { sessionTokenHash } from '@/lib/services/auth';

let token: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => name === SESSION_COOKIE && token ? { value: token } : undefined }),
}));

const suite = TEST_DATABASE_URL ? describe : describe.skip;
const base = 'http://localhost:3000';

suite('public Ree comments', () => {
  it('authenticates writes, safely retries them, and only serves comments for published Rees', async () => {
    const [author] = await db().insert(schema.user).values({
      name: 'Commenter',
      email: 'private@example.test',
      provider: 'github',
      providerSubject: uniqueName('commenter'),
    }).returning();
    const [ree, other] = await db().insert(schema.ree).values([true, false].map(isPublished => ({
      ownerId: author!.id,
      name: 'Commentable Ree',
      slug: uniqueName('commentable-ree'),
      isPublic: true,
      isPublished,
    }))).returning();
    const endpoint = `${base}/api/rees/${ree!.id}/comments`;
    const context = { params: Promise.resolve({ id: ree!.id }) };
    const get = (before?: string) => GET(new NextRequest(before ? `${endpoint}?before=${before}` : endpoint), context);
    const post = (payload: unknown, origin = base) => POST(
      new NextRequest(endpoint, { method: 'POST', headers: { origin }, body: JSON.stringify(payload) }),
      context,
    );
    try {
      expect(await (await get()).json()).toEqual({ items: [], total: 0, next: null });
      const commentId = crypto.randomUUID();
      const input = { id: commentId, content: '  有帮助 <b>谢谢</b>！\n第二行  ', authorName: 'Spoofed' };
      expect((await post(input)).status).toBe(401);

      token = crypto.randomUUID();
      await db().insert(schema.session).values({
        id: await sessionTokenHash(token),
        userId: author!.id,
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect((await post(input, 'https://another.example.test')).status).toBe(403);
      for (const content of ['', ' \n ', '中'.repeat(501), 'a\0b']) {
        expect((await post({ ...input, content })).status).toBe(422);
      }
      const attempts = await Promise.all([post(input), post(input)]);
      expect(attempts.map(response => response.status)).toEqual([201, 201]);
      const [first, retry] = await Promise.all(attempts.map(response => response.json()));
      expect(retry).toEqual(first);
      expect(first.comment).toEqual({
        id: commentId,
        authorName: author!.name,
        authorAvatar: null,
        content: input.content.trim(),
        createdAt: expect.any(String),
        canDelete: true,
      });
      expect((await post({ ...input, content: 'Changed' })).status).toBe(409);

      // Equal timestamps need a stable order and must not skip rows across the cursor.
      const earlier = new Date('2025-01-01T00:00:00Z');
      await db().insert(schema.reeComment).values(Array.from({ length: 21 }, (_, index) => ({
        id: crypto.randomUUID(),
        reeId: ree!.id,
        userId: author!.id,
        content: `Older comment ${index}`,
        createdAt: earlier,
      })));
      await db().insert(schema.reeComment).values({
        id: crypto.randomUUID(), reeId: other!.id, userId: author!.id, content: 'Unpublished Ree comment',
      });
      const firstPage = await (await get()).json();
      const olderPage = await (await get(firstPage.next)).json();
      expect(firstPage.items[0]).toEqual(first.comment);
      expect(firstPage).toMatchObject({ total: 22, next: firstPage.items[19].id });
      expect(olderPage).toMatchObject({ total: 22, next: null });
      expect(firstPage.items).toHaveLength(20);
      expect(olderPage.items).toHaveLength(2);
      expect(new Set([...firstPage.items, ...olderPage.items].map(item => item.id))).toHaveLength(22);

      await db().update(schema.ree).set({ isPublished: false }).where(inArray(schema.ree.id, [ree!.id]));
      expect((await get()).status).toBe(404);
      expect((await post({ ...input, id: crypto.randomUUID() })).status).toBe(404);
      await db().update(schema.ree).set({ isPublished: true }).where(inArray(schema.ree.id, [ree!.id]));
      expect((await (await get()).json()).total).toBe(22);
    } finally {
      token = undefined;
      await db().delete(schema.ree).where(inArray(schema.ree.id, [ree!.id, other!.id]));
      await db().delete(schema.user).where(inArray(schema.user.id, [author!.id]));
    }
  });

  it('lets the author or the Ree owner delete a comment, nobody else', async () => {
    const users = await db().insert(schema.user).values(['owner', 'author', 'stranger'].map(name => ({
      name, email: `${uniqueName(name)}@example.test`, provider: 'github' as const, providerSubject: uniqueName(name),
    }))).returning();
    const [owner, author, stranger] = users as [typeof users[0], typeof users[0], typeof users[0]];
    const [ree] = await db().insert(schema.ree).values({
      ownerId: owner.id, name: 'Deletable', slug: uniqueName('deletable'), isPublic: true, isPublished: true,
    }).returning();
    const signIn = async (userId: string) => {
      token = crypto.randomUUID();
      await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId, expiresAt: new Date(Date.now() + 60_000) });
    };
    const remove = (commentId: string) => DELETE(
      new NextRequest(`${base}/api/rees/${ree!.id}/comments/${commentId}`, { method: 'DELETE', headers: { origin: base } }),
      { params: Promise.resolve({ id: ree!.id, commentId }) },
    );
    const list = async () => (await (await GET(new NextRequest(`${base}/api/rees/${ree!.id}/comments`), { params: Promise.resolve({ id: ree!.id }) })).json()).items as { id: string; canDelete: boolean }[];
    const [byAuthor, second] = [crypto.randomUUID(), crypto.randomUUID()];
    await db().insert(schema.reeComment).values([byAuthor, second].map(id => ({ id, reeId: ree!.id, userId: author.id, content: 'hello' })));
    try {
      expect((await remove(byAuthor)).status).toBe(401);
      await signIn(stranger.id);
      expect((await list()).map(item => item.canDelete)).toEqual([false, false]);
      expect((await remove(byAuthor)).status).toBe(404);
      await signIn(author.id);
      expect((await list()).every(item => item.canDelete)).toBe(true);
      expect((await remove(byAuthor)).status).toBe(200);
      expect((await remove(byAuthor)).status).toBe(404);
      await signIn(owner.id);
      expect((await list()).map(item => [item.id, item.canDelete])).toEqual([[second, true]]);
      expect((await remove(second)).status).toBe(200);
      expect(await list()).toEqual([]);
    } finally {
      token = undefined;
      await db().delete(schema.ree).where(inArray(schema.ree.id, [ree!.id]));
      await db().delete(schema.user).where(inArray(schema.user.id, users.map(user => user.id)));
    }
  });

  it('limits how fast one account comments', async () => {
    const [author] = await db().insert(schema.user).values({
      name: 'Fast', email: `${uniqueName('fast')}@example.test`, provider: 'github', providerSubject: uniqueName('fast'),
    }).returning();
    const [ree] = await db().insert(schema.ree).values({
      ownerId: author!.id, name: 'Busy', slug: uniqueName('busy'), isPublic: true, isPublished: true,
    }).returning();
    token = crypto.randomUUID();
    await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId: author!.id, expiresAt: new Date(Date.now() + 60_000) });
    const post = () => POST(
      new NextRequest(`${base}/api/rees/${ree!.id}/comments`, { method: 'POST', headers: { origin: base }, body: JSON.stringify({ id: crypto.randomUUID(), content: 'again' }) }),
      { params: Promise.resolve({ id: ree!.id }) },
    );
    try {
      const perMinute = USER_RATE_LIMITS.comment[0].limit;
      for (let index = 0; index < perMinute; index += 1) expect((await post()).status).toBe(201);
      const limited = await post();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await db().$count(schema.reeComment, inArray(schema.reeComment.reeId, [ree!.id]))).toBe(perMinute);
    } finally {
      token = undefined;
      await db().delete(schema.ree).where(inArray(schema.ree.id, [ree!.id]));
      await db().delete(schema.user).where(inArray(schema.user.id, [author!.id]));
    }
  });
});

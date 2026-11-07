import { TEST_DATABASE_URL, uniqueName } from './setup';
import { describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/rees/[id]/comments/route';
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
});

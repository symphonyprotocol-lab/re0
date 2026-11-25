/**
 * Posts' link previews (封面图设计稿, 2026-11-20): `postCover` for each
 * state of a post, the cover route `/og/p/[id]` (a private post's is 404,
 * a gone one's the site image, a current version cached for good), and the
 * excerpt hiding what an answer quoted about a person.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName, uniqueWord } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { offlineOgAssets } from '../fixtures/og-offline';
import type { ProcessDeps } from '@/lib/services/posts';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
/* No network: the fixture font for `ogFonts`, and nothing fetched for the glyphs it lacks. */
vi.mock('@/lib/og/font', async (original) => {
  const actual = await original<typeof import('@/lib/og/font')>();
  const { fixtureOgFonts } = await import('../fixtures/og-offline');
  return { ...actual, ogFonts: async () => fixtureOgFonts(actual.OG_FONT_FAMILY) };
});
offlineOgAssets();

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const knowledge = await import('@/lib/services/knowledge');
const posts = await import('@/lib/services/posts');
const { addGrant } = await import('@/lib/services/credits');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');
const { coverData } = await import('@/lib/og/post-image');
const { postCoverPath, postCoverVersion, postMetadata } = await import('@/lib/og/post-meta');
const { GET: coverRoute } = await import('@/app/og/p/[id]/route');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  await fake?.close();
});

async function user(prefix: string, credits = 0) {
  const subject = uniqueName(prefix);
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: prefix, avatarUrl: null }, 'en', '/');
  if (credits > 0) await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'admin_adjust', refId: crypto.randomUUID() }));
  return userId;
}

async function publicRee(name: string) {
  const ownerId = await user('cover-owner', 1_000);
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName(name), category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  const id = await knowledge.addKnowledge(ownerId, ree, { kind: 'text', title: 'Refund policy', content: 'Refunds are issued to the original payment method within 14 days of the request.' });
  await knowledge.processKnowledge(id, { profile: false });
  await db().update(schema.ree).set({ isPublic: true, isPublished: true, queryFee: 0 }).where(eq(schema.ree.id, ree.id));
  return ree.id;
}

/** Answers from the given Rees, without a search or a model. */
function stub(reeIds: string[], text = 'Within 14 days [1].'): ProcessDeps {
  return {
    judge: async () => ({ publish: true }),
    match: async () => ({ answerers: reeIds.map((reeId) => ({ reeId, similarity: 0.8, mentioned: false })), candidates: reeIds.length, skipped: 0, vector: null }),
    answerOne: async () => ({ state: 'answered', text, citations: [], model: 'stub' }),
  };
}

async function answeredPost(reeIds: string[], text?: string) {
  const author = await user('cover-author', 1_000);
  const result = await posts.publishPost(author, { question: `When are refunds issued? ${uniqueWord('ask')}`, lang: 'en' });
  if (!result.ok) throw new Error(result.error);
  await posts.processPost(result.id, stub(reeIds, text));
  return result.id;
}

const base = 'http://localhost:3000';
const fetchCover = (id: string, version?: string) => coverRoute(new NextRequest(`${base}/og/p/${id}${version ? `?v=${version}` : ''}`), { params: Promise.resolve({ id }) });

describeWithDb('post covers', () => {
  it('shows the answered post: its Rees in the page order, the first one leading, cached for good at its version', async () => {
    const [one, two] = [await publicRee('Cover desk'), await publicRee('Cover guide')];
    const id = await answeredPost([one, two]);
    const cover = await posts.postCover(id);
    expect(cover).toMatchObject({ state: 'shown', lang: 'en', answers: 2 });
    if (cover?.state !== 'shown') throw new Error('not shown');
    expect(cover.rees).toHaveLength(2);
    expect(cover.first?.text).toBe('Within 14 days [1].');

    const current = await fetchCover(id, postCoverVersion(cover));
    expect(current.status).toBe(200);
    expect(current.headers.get('content-type')).toBe('image/png');
    /* A day at the CDN, never immutable: a takedown keeps the version, so the picture must expire (review S6). */
    expect(current.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=86400');
    expect((await current.arrayBuffer()).byteLength).toBeGreaterThan(1_000);
    /* An old or missing version: the current picture, briefly. */
    expect((await fetchCover(id, 'stale')).headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
    expect((await fetchCover(id)).headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');

    /* Helpful votes that reorder the answers give a new first answer, so a new URL. */
    const [firstRow] = await db().select({ id: schema.postAnswer.id }).from(schema.postAnswer).where(eq(schema.postAnswer.id, cover.first!.id));
    const others = (await db().select({ id: schema.postAnswer.id }).from(schema.postAnswer).where(eq(schema.postAnswer.postId, id))).filter((row) => row.id !== firstRow!.id);
    await db().update(schema.postAnswer).set({ helpfulCount: 5 }).where(eq(schema.postAnswer.id, others[0]!.id));
    const reordered = await posts.postCover(id);
    if (reordered?.state !== 'shown') throw new Error('not shown');
    expect(reordered.first?.id).toBe(others[0]!.id);
    expect(postCoverPath(id, reordered)).not.toBe(postCoverPath(id, cover));

    /* An answer hidden by its Ree's owner leaves the count and the stack. */
    await db().update(schema.postAnswer).set({ hiddenBy: 'owner' }).where(eq(schema.postAnswer.id, firstRow!.id));
    const fewer = await posts.postCover(id);
    expect(fewer).toMatchObject({ state: 'shown', answers: 1 });
  });

  it('draws an unanswered post as asking for answers, out of search', async () => {
    const id = await answeredPost([]);
    const cover = await posts.postCover(id);
    expect(cover).toMatchObject({ state: 'shown', answers: 0, first: null, rees: [] });
    const response = await fetchCover(id, postCoverVersion(cover as Extract<typeof cover, { state: 'shown' }>));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(postMetadata(id, cover, 'en').robots).toEqual({ index: false, follow: true });
  });

  it('quotes the first answer with phone numbers and addresses hidden', async () => {
    const id = await answeredPost([await publicRee('Cover contacts')], 'Call **13812345678** or write to help@example.com [2].');
    const cover = await posts.postCover(id);
    if (cover?.state !== 'shown') throw new Error('not shown');
    const data = await coverData(cover);
    expect(data.first?.text).toBe('Call [removed] or write to [removed].');
  });

  it('never draws a private post, nor says it exists', async () => {
    const id = await answeredPost([await publicRee('Cover private')]);
    await db().update(schema.post).set({ visibility: 'private' }).where(eq(schema.post.id, id));
    expect(await posts.postCover(id)).toEqual({ state: 'private' });
    const response = await fetchCover(id, 'any');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const meta = postMetadata(id, await posts.postCover(id), 'en');
    expect(JSON.stringify(meta)).not.toMatch(/refunds|\/og\//i);
    expect((await fetchCover(crypto.randomUUID())).status).toBe(404);
    expect((await fetchCover('not-a-uuid')).status).toBe(404);
  });

  it('falls back to the site image once a post is hidden, deleted or not approved', async () => {
    const reeId = await publicRee('Cover gone');
    for (const change of [{ status: 'hidden' as const, hiddenBy: 'reports' as const }, { deletedAt: new Date() }, { status: 'rejected' as const }, { status: 'pending' as const }]) {
      const id = await answeredPost([reeId]);
      await db().update(schema.post).set(change).where(eq(schema.post.id, id));
      expect(await posts.postCover(id)).toEqual({ state: 'gone', lang: 'en' });
      const response = await fetchCover(id, 'any');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300');
      expect(postMetadata(id, await posts.postCover(id), 'zh').openGraph).toMatchObject({ images: [{ url: '/og/site/zh' }] });
    }
  });
});

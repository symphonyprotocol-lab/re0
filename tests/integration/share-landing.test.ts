/**
 * The share page's knowledge section (lib/services/share-landing.ts): its
 * ready sources by kind -- counts only -- and the sources its shown answers
 * on visible posts cited. A private post, a hidden answer, a follow-up's
 * answer, another Ree's answer and a source that is paused or in the trash
 * never put a title on the page.
 */
import { describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { eq } from 'drizzle-orm';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const { reeCitedSources, reeSourceMix } = await import('@/lib/services/share-landing');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');

type Kind = (typeof schema.knowledge.$inferInsert)['kind'];

async function person() {
  const subject = uniqueName('l');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  return userId;
}

async function publicRee(ownerId: string) {
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Landing').slice(0, 40), description: 'A Ree with a landing page.', category: 'business', isPublic: true, step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  await rees.setReePublished(ownerId, ree.id, true);
  return ree.id;
}

async function source(reeId: string, kind: Kind, title: string, state: { enabled?: boolean; status?: 'ready' | 'pending'; deleted?: boolean } = {}) {
  const [row] = await db().insert(schema.knowledge).values({
    reeId, kind, title, originalTitle: title, status: state.status ?? 'ready', enabled: state.enabled ?? true, deletedAt: state.deleted ? new Date() : null,
  }).returning({ id: schema.knowledge.id });
  return { id: row!.id, title, kind };
}

async function answered(reeId: string, userId: string, cites: { id: string; title: string; kind: Kind }[], options: { visibility?: 'public' | 'private'; hidden?: boolean } = {}) {
  const [post] = await db().insert(schema.post).values({
    userId, source: 'post', question: uniqueName('Question'), lang: 'en', visibility: options.visibility ?? 'public', status: 'published', publishedAt: new Date(), answerState: 'done',
  }).returning({ id: schema.post.id });
  await db().insert(schema.postAnswer).values({
    postId: post!.id, reeId, state: 'answered', text: 'An answer [1].', answeredAt: new Date(), hiddenBy: options.hidden ? 'admin' : null,
    citations: cites.map((cite, index) => ({ index: index + 1, knowledgeId: cite.id, title: cite.title, kind: cite.kind as never, locator: {}, excerpt: '…' })),
  });
  return post!.id;
}

describeWithDb('share landing', () => {
  it('counts ready, enabled, live sources by kind, most first', async () => {
    const reeId = await publicRee(await person());
    await source(reeId, 'page', 'A');
    await source(reeId, 'page', 'B');
    await source(reeId, 'document', 'C');
    await source(reeId, 'github', 'Paused', { enabled: false });
    await source(reeId, 'github', 'Pending', { status: 'pending' });
    await source(reeId, 'audio', 'Trashed', { deleted: true });
    expect(await reeSourceMix(reeId)).toEqual([{ kind: 'page', count: 2 }, { kind: 'document', count: 1 }]);
    expect(await reeSourceMix('not-a-uuid')).toEqual([]);
  });

  it('lists only sources its shown answers on public posts cited, still live', async () => {
    const owner = await person();
    const asker = await person();
    const reeId = await publicRee(owner);
    const other = await publicRee(owner);
    const docs = await source(reeId, 'site', 'Docs');
    const guide = await source(reeId, 'document', 'Guide.pdf');
    const paused = await source(reeId, 'page', 'Paused page');
    const secret = await source(reeId, 'page', 'Only cited privately');
    const hiddenOnly = await source(reeId, 'audio', 'Only in a hidden answer');
    const elsewhere = await source(other, 'page', 'Another Ree’s source');

    await answered(reeId, asker, [docs, guide, paused]);
    await answered(reeId, asker, [docs]);
    await answered(reeId, asker, [secret], { visibility: 'private' });
    await answered(reeId, asker, [hiddenOnly], { hidden: true });
    await answered(other, asker, [elsewhere]);
    await db().update(schema.knowledge).set({ enabled: false }).where(eq(schema.knowledge.id, paused.id));

    expect(await reeCitedSources(reeId)).toEqual([
      { knowledgeId: docs.id, title: 'Docs', kind: 'site', answers: 2 },
      { knowledgeId: guide.id, title: 'Guide.pdf', kind: 'document', answers: 1 },
    ]);

    // The Ree going private takes its answers -- and so the titles -- off the page.
    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, reeId));
    expect(await reeCitedSources(reeId)).toEqual([]);
  });
});

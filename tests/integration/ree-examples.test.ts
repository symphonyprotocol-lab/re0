/**
 * A public Ree page's answered questions (lib/services/posts.ts
 * `reeAnsweredExamples`): only posts a search engine may index -- public,
 * published, not deleted, this Ree's first-round answer shown -- the pinned
 * one first, then the most helpful, then the newest; never an answer that
 * says its sources do not cover the question; the answer's opening only,
 * with its cited sources' titles. Read in index order (migration 0092).
 */
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const { reeAnsweredExamples } = await import('@/lib/services/posts');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { REE_EXAMPLE_READ_CHARS } = await import('@/lib/domain/ree-examples');

async function person() {
  const subject = uniqueName('p');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  return userId;
}

async function publicRee(ownerId: string) {
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Examples').slice(0, 40), description: 'A Ree with answered questions.', category: 'business', isPublic: true, step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  await rees.setReePublished(ownerId, ree.id, true);
  return ree.id;
}

type Options = { helpful?: number; pinned?: boolean; uncovered?: boolean; hidden?: boolean; visibility?: 'public' | 'private'; deleted?: boolean; at?: Date; question?: string; citations?: { index: number; title: string }[] };

async function answered(reeId: string, userId: string, text: string, options: Options = {}) {
  const [post] = await db().insert(schema.post).values({
    userId, source: 'post', question: options.question ?? uniqueName('Question'), lang: 'en', visibility: options.visibility ?? 'public', status: 'published', publishedAt: new Date(), answerState: 'done',
    deletedAt: options.deleted ? new Date() : null,
  }).returning({ id: schema.post.id });
  const citations = (options.citations ?? []).map((entry) => ({ ...entry, knowledgeId: '00000000-0000-4000-8000-0000000000e1', kind: 'document' as const, locator: {}, excerpt: 'x'.repeat(400) }));
  await db().insert(schema.postAnswer).values({
    postId: post!.id, reeId, state: 'answered', text, answeredAt: options.at ?? new Date(), helpfulCount: options.helpful ?? 0, citations,
    pinnedAt: options.pinned ? new Date() : null, uncovered: options.uncovered ?? false, hiddenBy: options.hidden ? 'owner' : null,
  });
  return post!.id;
}

describeWithDb('a Ree page\'s answered questions', () => {
  it('picks the pinned answer, then the most helpful, then the newest -- only posts that may be indexed', async () => {
    const owner = await person();
    const reeId = await publicRee(owner);
    const old = new Date(Date.now() - 86_400_000);
    const newest = await answered(reeId, owner, 'Newest answer [1].', { helpful: 1 });
    await answered(reeId, owner, 'Older answer [1].', { helpful: 1, at: old });
    const helpful = await answered(reeId, owner, 'Most helpful answer [1].', { helpful: 9, at: old });
    const pinned = await answered(reeId, owner, 'Pinned answer [1].', { pinned: true });
    const refusal = await answered(reeId, owner, 'I cannot answer this from my sources.', { helpful: 50, uncovered: true });
    const hidden = await answered(reeId, owner, 'Hidden answer.', { helpful: 40, hidden: true });
    const privatePost = await answered(reeId, owner, 'Private answer.', { helpful: 30, visibility: 'private' });
    const deleted = await answered(reeId, owner, 'Deleted post.', { helpful: 20, deleted: true });

    const examples = await reeAnsweredExamples(reeId);
    expect(examples.map((example) => example.postId)).toEqual([pinned, helpful, newest]);
    for (const left of [refusal, hidden, privatePost, deleted]) expect(examples.map((example) => example.postId)).not.toContain(left);
    expect(examples[0]).toMatchObject({ lang: 'en', summary: 'Pinned answer [1].' });
    expect(await reeAnsweredExamples(reeId, 2)).toHaveLength(2);
  });

  it('reads only the opening of a long answer, with the titles of its citations', async () => {
    const owner = await person();
    const reeId = await publicRee(owner);
    const long = `Tokio shuts down when the runtime is dropped [1]. Spawned tasks are cancelled at their next await [2]. Use a cancellation token to finish cleanly [1]. ${'More detail follows here. '.repeat(200)}`;
    await answered(reeId, owner, long, { question: '  How do I shut down a Tokio runtime?  ', citations: [{ index: 1, title: 'Tokio docs: Runtime' }, { index: 2, title: 'Tokio docs: Cancellation' }] });
    const [example] = await reeAnsweredExamples(reeId);
    expect(example!.question).toBe('How do I shut down a Tokio runtime?');
    expect(example!.summary).toBe('Tokio shuts down when the runtime is dropped [1]. Spawned tasks are cancelled at their next await [2]. Use a cancellation token to finish cleanly [1].');
    expect(example!.sources).toEqual([{ index: 1, title: 'Tokio docs: Runtime' }, { index: 2, title: 'Tokio docs: Cancellation' }]);
    expect(long.length).toBeGreaterThan(REE_EXAMPLE_READ_CHARS);
  });

  it('shows nothing for a Ree with no answered posts, or one that went private', async () => {
    const owner = await person();
    const reeId = await publicRee(owner);
    expect(await reeAnsweredExamples(reeId)).toEqual([]);
    await answered(reeId, owner, 'An answer [1].', { helpful: 1 });
    expect(await reeAnsweredExamples(reeId)).toHaveLength(1);
    await db().update(schema.ree).set({ isPublic: false, isPublished: false }).where(eq(schema.ree.id, reeId));
    expect(await reeAnsweredExamples(reeId)).toEqual([]);
    expect(await reeAnsweredExamples('not-a-uuid')).toEqual([]);
  });

  it('walks post_answer_ree_pick_idx in order instead of sorting every answer', async () => {
    const owner = await person();
    const reeId = await publicRee(owner);
    await answered(reeId, owner, 'An answer [1].', { helpful: 1 });
    /* One connection: a tiny test table would otherwise be read whole, whatever the index. */
    const plan = await db().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const rows = (await tx.execute(sql`explain select ${schema.postAnswer.id} from ${schema.postAnswer} where ${schema.postAnswer.reeId} = ${reeId} and state = 'answered' and hidden_by is null and followup_id is null and uncovered = false and pinned_at is null order by helpful_count desc nulls last, answered_at desc nulls last, id desc nulls last limit 3`)).rows as { 'QUERY PLAN': string }[];
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('post_answer_ree_pick_idx');
    expect(plan).not.toMatch(/\bSort\b/);
  });
});

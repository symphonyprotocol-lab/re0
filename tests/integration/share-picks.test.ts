/**
 * The share page's picks (lib/services/posts.ts `reePostPicks`): the first
 * one is the page's featured exchange, so an answer in which the Ree says its
 * sources do not cover the question (post_answer.uncovered) is never picked --
 * not when it is the most helpful, not when it is pinned -- though it still
 * counts. `closeAnswer` records the flag from the model's word (it ended on
 * the no-answer sentinel) or from the text (`readsAsUncovered`), and Postgres
 * reads the pattern as JavaScript does, so migration 0091's backfill agrees.
 */
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const { closeAnswer, reePostPicks } = await import('@/lib/services/posts');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { readsAsUncovered, UNCOVERED_MAX_CHARS, UNCOVERED_PATTERN } = await import('@/lib/domain/answer');

const REFUSAL = 'The provided passages only mention DW200 in the manual title [1]. They do not contain a description of it, so I cannot answer this question based on the supplied text.';

async function person() {
  const subject = uniqueName('p');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  return userId;
}

async function publicRee(ownerId: string) {
  await rees.saveDraft(ownerId, { ...newReeDraft(), name: uniqueName('Picks').slice(0, 40), description: 'A Ree with a share page.', category: 'business', isPublic: true, step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(ownerId);
  await rees.setReePublished(ownerId, ree.id, true);
  return ree.id;
}

async function answered(reeId: string, userId: string, text: string, options: { helpful?: number; pinned?: boolean; uncovered?: boolean; state?: 'answered' | 'answering' } = {}) {
  const [post] = await db().insert(schema.post).values({
    userId, source: 'post', question: uniqueName('Question'), lang: 'en', visibility: 'public', status: 'published', publishedAt: new Date(), answerState: 'done',
  }).returning({ id: schema.post.id });
  const [row] = await db().insert(schema.postAnswer).values({
    postId: post!.id, reeId, state: options.state ?? 'answered', text, answeredAt: new Date(), helpfulCount: options.helpful ?? 0,
    pinnedAt: options.pinned ? new Date() : null, uncovered: options.uncovered ?? false,
  }).returning({ id: schema.postAnswer.id });
  return { postId: post!.id, answerId: row!.id };
}

describeWithDb('share page picks', () => {
  it('never features an answer that says its sources do not cover the question, though it counts', async () => {
    const owner = await person();
    const reeId = await publicRee(owner);
    const refusal = await answered(reeId, owner, REFUSAL, { helpful: 5, pinned: true, uncovered: true });
    const real = await answered(reeId, owner, 'DW200 is an open-source IoT access-control device [1].', { helpful: 1 });
    const picks = await reePostPicks(reeId, 4);
    expect(picks.items.map((item) => item.id)).toEqual([real.postId]);
    expect(picks.items.map((item) => item.id)).not.toContain(refusal.postId);
    expect(picks.total).toBe(2);
  });

  it('leaves the page nothing to feature when every answer is one', async () => {
    const owner = await person();
    const reeId = await publicRee(owner);
    await answered(reeId, owner, REFUSAL, { helpful: 1, uncovered: true });
    expect((await reePostPicks(reeId, 4)).items).toEqual([]);
  });

  it('records the flag when the answer is written, from the model or from the text', async () => {
    const owner = await person();
    const reeId = await publicRee(owner);
    const flag = async (answerId: string) => (await db().select({ uncovered: schema.postAnswer.uncovered }).from(schema.postAnswer).where(eq(schema.postAnswer.id, answerId)))[0]!.uncovered;
    const byText = await answered(reeId, owner, '', { state: 'answering' });
    await closeAnswer(byText.answerId, { state: 'answered', text: REFUSAL, citations: [], model: 'stub' }, new Date());
    expect(await flag(byText.answerId)).toBe(true);
    const bySentinel = await answered(reeId, owner, '', { state: 'answering' });
    await closeAnswer(bySentinel.answerId, { state: 'answered', text: 'The passages name the towns but not how it began there.', citations: [], model: 'stub', uncovered: true }, new Date());
    expect(await flag(bySentinel.answerId)).toBe(true);
    const plain = await answered(reeId, owner, '', { state: 'answering' });
    await closeAnswer(plain.answerId, { state: 'answered', text: 'DW200 reads QR codes and NFC cards [1].', citations: [], model: 'stub' }, new Date());
    expect(await flag(plain.answerId)).toBe(false);
    expect((await reePostPicks(reeId, 4)).items.map((item) => item.id)).toEqual([plain.postId]);
  });

  it('reads the pattern in Postgres as JavaScript does (the backfill in 0091)', async () => {
    const samples = [REFUSAL, '这个问题不在我的知识范围内。', '无法根据提供的资料回答这个问题。', 'I can’t answer that from these sources.', 'DW200 reads QR codes [1].', 'The passages do not give its price.'];
    for (const text of samples) {
      const [row] = (await db().execute(sql`select (char_length(btrim(${text}::text)) between 1 and ${UNCOVERED_MAX_CHARS} and ${text}::text ~* ${UNCOVERED_PATTERN}) as hit`)).rows as { hit: boolean }[];
      expect(row!.hit, text).toBe(readsAsUncovered(text));
    }
  });
});

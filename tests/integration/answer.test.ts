/**
 * Acceptance, asked as a private post since the conversations went: a
 * question gets an answer with numbered citations and is charged the base
 * fee; "明天火星的天气" gets no answer and is not charged; a Ree without ready
 * knowledge says so for free; too few credits is refused before anything is
 * held; switching the generation model in the console moves the next
 * question onto it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { handbookPages, makePdf } from '../fixtures/pdf';
import { startFakeFirecrawl } from '../fixtures/fake-firecrawl';
import type { FakeWeb } from '../fixtures/fake-web';

const blobs = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/blob', () => ({
  blobSize: async (path: string) => blobs.get(path)?.length ?? null,
  readBlob: async (path: string) => blobs.get(path) ?? null,
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const knowledge = await import('@/lib/services/knowledge');
const rees = await import('@/lib/services/rees');
const privatePosts = await import('@/lib/services/private-posts');
/*
 * These tests are about how a Ree's own answer settles. When no Ree answers,
 * a private post now gets the asker an AI general answer at the base fee
 * (ai-answers.ts, covered by tests/integration/ai-answers.test.ts); here it
 * fails, so its hold is given back and every figure is the Ree's alone.
 */
const noAi = { aiAnswer: async () => { throw new Error('no AI in these tests'); } };
const models = await import('@/lib/services/models');
const admin = await import('@/lib/services/admin');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');

let fake: FakeOpenAi;
let firecrawl: FakeWeb;
beforeAll(async () => {
  firecrawl = startFakeFirecrawl();
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(async () => {
  firecrawl?.restore();
  vi.unstubAllEnvs();
  await fake?.close();
});

async function setUp(withKnowledge: boolean) {
  const subject = uniqueName('ask');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'A', avatarUrl: null }, 'zh', '/');
  await rees.saveDraft(userId, { ...newReeDraft(), name: 'Northwind', category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  if (withKnowledge) {
    const path = `knowledge/${userId}/h/handbook.pdf`;
    blobs.set(path, makePdf(handbookPages()));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'handbook.pdf' });
    await knowledge.processKnowledge(id);
    // A text PDF is parsed locally; the fake Firecrawl only guards against a real request.
    expect(firecrawl.requests).toEqual([]);
  }
  return { userId, ree };
}

/**
 * Asks the user's own Ree privately and waits for the answer row; the
 * refusal instead when the ask is refused. A random tag keeps each ask its
 * own question.
 */
async function ask(userId: string, reeId: string, question: string) {
  const made = await privatePosts.publishPrivatePost(userId, { question: `${question} ${randomUUID().slice(0, 8)}`, reeIds: [reeId], fees: { [reeId]: 20 }, lang: 'zh' });
  if (!made.ok) return { refused: made, answer: null };
  await privatePosts.processPrivatePost(made.id, noAi);
  const [answer] = await db().select().from(schema.postAnswer).where(eq(schema.postAnswer.postId, made.id));
  return { refused: null, answer: answer! };
}

describeWithDb('answering', () => {
  it('answers with citations and charges the base fee', async () => {
    const { userId, ree } = await setUp(true);
    const before = await balanceOf(db(), userId);
    const { answer } = await ask(userId, ree.id, 'When are refunds issued to the original payment method?');
    expect(answer).toMatchObject({ state: 'answered', model: 'fake-gen-1', price: 20 });
    expect(answer!.text).toContain('[1]');
    const calls = await db().select().from(schema.modelCall).where(and(eq(schema.modelCall.purpose, 'post_answer'), eq(schema.modelCall.model, 'fake-gen-1')));
    expect(calls.at(-1)).toMatchObject({ audience: 'free', status: 'succeeded', usageKnown: true });
    expect(answer!.citations[0]).toMatchObject({ index: 1 });
    expect(answer!.citations[0]!.locator.page).toBe(3);
    expect(answer!.citations[0]!.excerpt).toContain('14 days');
    expect(await balanceOf(db(), userId)).toBe(before - 20);
  });

  it('does not answer, or charge, a question outside the knowledge', async () => {
    const { userId, ree } = await setUp(true);
    const before = await balanceOf(db(), userId);
    const { answer } = await ask(userId, ree.id, '明天火星的天气');
    expect(answer).toMatchObject({ state: 'no_answer', text: '' });
    expect(await balanceOf(db(), userId)).toBe(before);
    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.userId, userId)).orderBy(asc(schema.creditEntry.createdAt));
    /* The Ree's own hold and refund (the failed AI fallback writes its own ai_answer_* pair after them). */
    expect(entries.filter((entry) => entry.reason.startsWith('query_')).slice(-2).map((entry) => [entry.reason, entry.delta])).toEqual([
      ['query_hold', -20],
      ['query_refund', 20],
    ]);
    expect(entries.filter((entry) => entry.reason.startsWith('ai_answer_')).map((entry) => [entry.reason, entry.delta])).toEqual([
      ['ai_answer_hold', -20],
      ['ai_answer_refund', 20],
    ]);
  });

  it('releases the hold when the model itself declines', async () => {
    const { userId, ree } = await setUp(true);
    const before = await balanceOf(db(), userId);
    const { answer } = await ask(userId, ree.id, 'Refunds are issued within days DECLINE');
    expect(answer).toMatchObject({ state: 'no_answer', text: '' });
    expect(await balanceOf(db(), userId)).toBe(before);
  });

  it('says knowledge is not ready, for free, without holding anything', async () => {
    const { userId, ree } = await setUp(false);
    const { answer } = await ask(userId, ree.id, 'Anything?');
    expect(answer).toMatchObject({ state: 'no_answer' });
    /* Nothing held for the Ree; the AI fallback's own hold was given back. */
    const aiIds = (await db().select({ id: schema.postAiAnswer.id }).from(schema.postAiAnswer).where(eq(schema.postAiAnswer.userId, userId))).map((row) => row.id);
    expect((await db().select().from(schema.creditHold).where(eq(schema.creditHold.userId, userId))).filter((hold) => !aiIds.includes(hold.refId ?? ''))).toHaveLength(0);
  });

  it('refuses before holding anything when the balance is short, saving nothing', async () => {
    const { userId, ree } = await setUp(true);
    await db().update(schema.creditGrant).set({ remaining: 5 }).where(eq(schema.creditGrant.userId, userId));
    const { refused } = await ask(userId, ree.id, 'When are refunds issued to the original payment method?');
    expect(refused).toEqual({ ok: false, error: 'insufficient_credits', balance: 5, needed: 20 });
    expect(await db().select().from(schema.post).where(eq(schema.post.userId, userId))).toHaveLength(0);
  });

  it('moves the next question to the generation model the console activates', async () => {
    const { userId, ree } = await setUp(true);
    const [administrator] = await db().select().from(schema.administrator).limit(1);
    const adminId =
      administrator?.id ??
      (await db().insert(schema.administrator).values({ name: 'a', email: `${uniqueName('a')}@x.test`, passwordHash: await admin.hashPassword('x'.repeat(12)), totpSecretCipher: 'x' }).returning())[0]!.id;
    const created = await models.createModelConfig(adminId, { name: 'Second', kind: 'generation', transport: 'openai_compatible', baseUrl: fake.baseUrl, model: 'fake-gen-2', apiKey: 'k', supportsImages: true });
    await models.activateModelConfig(adminId, created.id);
    try {
      const { answer } = await ask(userId, ree.id, 'When are refunds issued to the original payment method?');
      expect(answer?.model).toBe('fake-gen-2');
      expect(fake.requests.filter((request) => request.path.endsWith('/chat/completions')).at(-1)?.model).toBe('fake-gen-2');
    } finally {
      await db().delete(schema.modelConfig).where(eq(schema.modelConfig.id, created.id));
      forgetModelCache();
    }
  });
});

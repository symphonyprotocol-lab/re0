/**
 * Acceptance: a question gets a streamed answer with numbered citations and
 * is charged the base fee; "明天火星的天气" gets the out-of-scope card and is
 * not charged; a Ree without ready knowledge says so for free; too few
 * credits is a 402 before any stream; switching the generation model in the
 * console moves the next question onto it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { asc, eq } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { handbookPages, makePdf } from '../fixtures/pdf';

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
const chat = await import('@/lib/services/chat');
const { answer } = await import('@/lib/services/answer');
const models = await import('@/lib/services/models');
const admin = await import('@/lib/services/admin');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { forgetModelCache } = await import('@/lib/infra/ai/models');

let fake: FakeOpenAi;
beforeAll(async () => {
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
afterAll(() => fake?.close());

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
  }
  const conversation = await chat.testConversation(userId, ree.id);
  return { userId, ree, conversation };
}

/** Reads a UI message stream into its text and its outcome part. */
async function consume(response: Response) {
  const raw = await response.text();
  const events = raw
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: string; data?: Record<string, unknown> });
  return {
    deltas: events.filter((event) => event.type === 'text-delta').length,
    text: events.filter((event) => event.type === 'text-delta').map((event) => event.delta).join(''),
    outcome: events.find((event) => event.type === 'data-outcome')?.data as
      | { noAnswer: boolean; reason: string | null; cost: number; citations: { index: number; locator: { page?: number } }[]; model: string | null }
      | undefined,
  };
}

describeWithDb('answering', () => {
  it('streams a cited answer and charges the base fee', async () => {
    const { userId, ree, conversation } = await setUp(true);
    const before = await balanceOf(db(), userId);
    const response = await answer({ userId, lang: 'zh', conversation, ree, question: 'How long do refunds take?' });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const result = await consume(response);
    expect(result.deltas).toBeGreaterThan(1);
    expect(result.text).toContain('[1]');
    expect(result.outcome).toMatchObject({ noAnswer: false, cost: 20, model: 'fake-gen-1' });
    expect(result.outcome!.citations[0]).toMatchObject({ index: 1 });
    expect(result.outcome!.citations[0]!.locator.page).toBe(3);
    expect(await balanceOf(db(), userId)).toBe(before - 20);

    const stored = await chat.messagesOf(conversation.id);
    expect(stored.map((row) => row.role)).toEqual(['user', 'ree']);
    expect(stored[1]).toMatchObject({ costCredits: 20, noAnswer: false });
    expect(stored[1]!.citations[0]!.excerpt).toContain('14 days');
  });

  it('does not answer, or charge, a question outside the knowledge', async () => {
    const { userId, ree, conversation } = await setUp(true);
    const before = await balanceOf(db(), userId);
    const result = await consume(await answer({ userId, lang: 'zh', conversation, ree, question: '明天火星的天气' }));
    expect(result.outcome).toMatchObject({ noAnswer: true, reason: 'out_of_scope', cost: 0 });
    expect(await balanceOf(db(), userId)).toBe(before);
    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.userId, userId)).orderBy(asc(schema.creditEntry.createdAt));
    expect(entries.slice(-2).map((entry) => [entry.reason, entry.delta])).toEqual([
      ['query_hold', -20],
      ['query_refund', 20],
    ]);
  });

  it('releases the hold when the model itself declines', async () => {
    const { userId, ree, conversation } = await setUp(true);
    const before = await balanceOf(db(), userId);
    const result = await consume(await answer({ userId, lang: 'zh', conversation, ree, question: 'Refunds are issued within days DECLINE' }));
    expect(result.text).toBe('');
    expect(result.outcome).toMatchObject({ noAnswer: true, reason: 'out_of_scope' });
    expect(await balanceOf(db(), userId)).toBe(before);
  });

  it('says knowledge is not ready, for free, without holding anything', async () => {
    const { userId, ree, conversation } = await setUp(false);
    const result = await consume(await answer({ userId, lang: 'zh', conversation, ree, question: 'Anything?' }));
    expect(result.outcome).toMatchObject({ noAnswer: true, reason: 'no_sources', cost: 0 });
    expect(await db().select().from(schema.creditHold).where(eq(schema.creditHold.userId, userId))).toHaveLength(0);
  });

  it('refuses with 402 before streaming when the balance is short, saving nothing', async () => {
    const { userId, ree, conversation } = await setUp(true);
    await db().update(schema.creditGrant).set({ remaining: 5 }).where(eq(schema.creditGrant.userId, userId));
    const response = await answer({ userId, lang: 'zh', conversation, ree, question: 'How long do refunds take?' });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: 'insufficient_credits', balance: 5, needed: 20 });
    expect(await chat.messagesOf(conversation.id)).toHaveLength(0);
  });

  it('clears the conversation without touching the ledger', async () => {
    const { userId, ree, conversation } = await setUp(true);
    await consume(await answer({ userId, lang: 'zh', conversation, ree, question: 'How long do refunds take?' }));
    const balance = await balanceOf(db(), userId);
    await chat.clearConversation(conversation.id);
    expect(await chat.messagesOf(conversation.id)).toHaveLength(0);
    expect(await balanceOf(db(), userId)).toBe(balance);
  });

  it('moves the next question to the generation model the console activates', async () => {
    const { userId, ree, conversation } = await setUp(true);
    const [administrator] = await db().select().from(schema.administrator).limit(1);
    const adminId =
      administrator?.id ??
      (await db().insert(schema.administrator).values({ name: 'a', email: `${uniqueName('a')}@x.test`, passwordHash: await admin.hashPassword('x'.repeat(12)), totpSecretCipher: 'x' }).returning())[0]!.id;
    const created = await models.createModelConfig(adminId, { name: 'Second', kind: 'generation', transport: 'openai_compatible', baseUrl: fake.baseUrl, model: 'fake-gen-2', apiKey: 'k' });
    await models.activateModelConfig(adminId, created.id);
    const result = await consume(await answer({ userId, lang: 'zh', conversation, ree, question: 'How long do refunds take?' }));
    expect(result.outcome?.model).toBe('fake-gen-2');
    expect(fake.requests.filter((request) => request.path.endsWith('/chat/completions')).at(-1)?.model).toBe('fake-gen-2');
    await db().delete(schema.modelConfig).where(eq(schema.modelConfig.id, created.id));
    forgetModelCache();
  });
});

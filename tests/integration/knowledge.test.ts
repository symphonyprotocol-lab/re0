/**
 * Acceptance: a 30-page PDF goes processing → ready with 30 page-located
 * passages; the charge is the settled price (≤ the hold) and the ledger has
 * the hold and the settlement. Failures refund in full; reprocessing charges
 * again.
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

async function userWithRee() {
  const subject = uniqueName('kn');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'K', avatarUrl: null }, 'zh', '/');
  await rees.saveDraft(userId, { ...newReeDraft(), name: 'Handbook', category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  return { userId, ree };
}

describeWithDb('document processing', () => {
  it('processes a 30-page PDF and settles the real price', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/1/handbook.pdf`;
    blobs.set(path, makePdf(handbookPages()));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'handbook.pdf' });
    expect(await balanceOf(db(), userId)).toBe(1980);

    await knowledge.processKnowledge(id);
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail?.status).toBe('ready');
    expect(detail?.chunks).toHaveLength(30);
    expect(detail?.chunks[2]?.locator).toMatchObject({ page: 3 });
    const chars = detail!.content!.length;
    const price = Math.ceil(chars / 1000);
    expect(price).toBeLessThanOrEqual(20);
    expect(detail?.activity.map((entry) => entry.code)).toEqual(['added', 'processing', 'parsed', 'chunked', 'settled', 'ready']);

    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt));
    expect(entries.map((entry) => [entry.reason, entry.delta])).toEqual([
      ['knowledge_hold', -20],
      ['knowledge_settle', 20 - price],
    ]);
    expect(await balanceOf(db(), userId)).toBe(2000 - price);

    const listed = await knowledge.listKnowledge(ree.id, { q: 'refunds', status: 'ready', kind: 'all', sort: 'recent', size: 20, page: 1 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ chunks: 30, chars });
    expect(listed.counts).toMatchObject({ all: 1, ready: 1, processing: 0, failed: 0 });
  });

  it('fails and refunds in full when the file is gone; reprocessing charges again', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/2/notes.md`;
    blobs.set(path, new TextEncoder().encode('# Notes\n\nThe office opens at nine.'));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'notes.md' });
    blobs.delete(path);
    await knowledge.processKnowledge(id);
    const failed = await knowledge.knowledgeDetail(ree.id, id);
    expect(failed).toMatchObject({ status: 'failed', error: 'source_missing' });
    expect(await balanceOf(db(), userId)).toBe(2000);

    blobs.set(path, new TextEncoder().encode('# Notes\n\nThe office opens at nine.'));
    await knowledge.refreshKnowledge(userId, ree.id, id);
    expect(await balanceOf(db(), userId)).toBe(1980);
    await knowledge.processKnowledge(id);
    expect((await knowledge.knowledgeDetail(ree.id, id))?.status).toBe('ready');
    expect(await balanceOf(db(), userId)).toBe(1999);
    const reasons = (await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt))).map((entry) => entry.reason);
    expect(reasons).toEqual(['knowledge_hold', 'knowledge_refund', 'knowledge_hold', 'knowledge_settle']);
  });

  it('processes pasted text at its exact price and refuses a busy refresh', async () => {
    const { userId, ree } = await userWithRee();
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Policy', content: 'Refund policy. '.repeat(100) });
    await expect(knowledge.refreshKnowledge(userId, ree.id, id)).rejects.toMatchObject({ code: 'busy' });
    await knowledge.processKnowledge(id);
    await knowledge.processKnowledge(id);
    expect((await knowledge.knowledgeDetail(ree.id, id))?.status).toBe('ready');
    expect(await balanceOf(db(), userId)).toBe(1998);
  });

  it('rejects a file type outside the four document formats', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/3/run.exe`;
    blobs.set(path, new Uint8Array([1, 2, 3]));
    await expect(knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'run.exe' })).rejects.toMatchObject({ code: 'invalid_document' });
  });
});

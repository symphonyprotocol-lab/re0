/**
 * Acceptance: a 30-page PDF goes processing → ready with 30 page-located
 * passages; the charge is the settled price (≤ the hold) and the ledger has
 * the hold and the settlement. A text PDF is parsed locally and pays only for
 * embedding; a scanned one goes to (fake) Firecrawl and pays its credits too.
 * A failure keeps what it spent and returns the rest; reprocessing charges again.
 */
import { WELCOME_CREDITS } from '@/lib/constants';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { asc, eq } from 'drizzle-orm';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { handbookPages, makePdf, scannedHandbookPdf } from '../fixtures/pdf';
import { makeDocx, word } from '../fixtures/docx';
import { startFakeFirecrawl } from '../fixtures/fake-firecrawl';
import { jsonResponse, type FakeWeb } from '../fixtures/fake-web';
import { debtOf, expectChargedAtLeastCost } from './billing-audit';

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
const models = await import('@/lib/infra/ai/models');

let fake: FakeOpenAi;
let firecrawl: FakeWeb;
beforeAll(async () => {
  firecrawl = startFakeFirecrawl();
  fake = await startFakeOpenAi();
  pointModelsAt(fake.baseUrl);
  forgetModelCache();
});
beforeEach(() => { pointModelsAt(fake.baseUrl); fake.billing.embeddingTokens = 1000; fake.billing.omitEmbeddingUsage = false; });
afterAll(async () => {
  firecrawl?.restore();
  vi.unstubAllEnvs();
  await fake?.close();
});

async function userWithRee() {
  const subject = uniqueName('kn');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'K', avatarUrl: null }, 'zh', '/');
  await rees.saveDraft(userId, { ...newReeDraft(), name: 'Handbook', category: 'business', step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  return { userId, ree };
}

describeWithDb('document processing', () => {
  it('follows supplier price changes and preserves the previous price snapshot', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/price/same.md`;
    blobs.set(path, new TextEncoder().encode('Exactly the same source text.'));
    const first = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'same.md' });
    await knowledge.processKnowledge(first, { profile: false });
    const configured = JSON.parse(process.env.PROVIDER_COST_RATES!);
    configured[0].usdPerUnit = '0.000002';
    process.env.PROVIDER_COST_RATES = JSON.stringify(configured);
    const second = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'same.md' });
    await knowledge.processKnowledge(second, { profile: false });
    // Each run also pays for reading the file back from Blob, a fraction of a credit that rounds the run up.
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1 - 21);
    await expectChargedAtLeastCost(first);
    await expectChargedAtLeastCost(second);
    const firstDetail = await knowledge.knowledgeDetail(ree.id, first);
    const secondDetail = await knowledge.knowledgeDetail(ree.id, second);
    const embeddingCharge = (detail: typeof firstDetail) => detail!.activity
      .filter((entry) => entry.code === 'provider_usage')
      .map((entry) => JSON.parse(String(entry.detail!.charge)))
      .find((charge) => charge.service === 'embedding');
    const oldCharge = embeddingCharge(firstDetail);
    const newCharge = embeddingCharge(secondDetail);
    expect(oldCharge.rate.usdPerUnit).toBe('0.00000002');
    expect(newCharge.rate.usdPerUnit).toBe('0.000002');
    expect(newCharge.priceRevision).not.toBe(oldCharge.priceRevision);
  });

  it('charges zero for an explicitly free supplier without a per-source minimum fee', async () => {
    const rates = JSON.parse(process.env.PROVIDER_COST_RATES!);
    rates[0].usdPerUnit = '0';
    process.env.PROVIDER_COST_RATES = JSON.stringify(rates);
    const { userId, ree } = await userWithRee();
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Free', content: 'A source with no provider cost.' });
    await knowledge.processKnowledge(id, { profile: false });
    expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'ready' });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS);
  });

  it('refuses unpriced custom models before making a paid request', async () => {
    process.env.PROVIDER_COST_RATES = '[]';
    const { userId, ree } = await userWithRee();
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Unpriced', content: 'Never estimate this from character count.' });
    const before = fake.requests.length;
    await knowledge.processKnowledge(id, { profile: false });
    expect(fake.requests).toHaveLength(before);
    expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'failed', error: 'pricing_unavailable' });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS);
  });

  it('records missing usage for reconciliation and keeps the reservation rather than bill zero', async () => {
    const { userId, ree } = await userWithRee();
    fake.billing.omitEmbeddingUsage = true;
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Unknown usage', content: 'The endpoint returns no token usage.' });
    await knowledge.processKnowledge(id, { profile: false });
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail).toMatchObject({ status: 'failed', error: 'usage_unavailable' });
    const charge = JSON.parse(String(detail!.activity.find((entry) => entry.code === 'provider_usage')!.detail!.charge));
    expect(charge).toMatchObject({ basis: 'unresolved', costUsd: null });
    // A cost nobody can price keeps everything reserved for it (P1): the 1-credit hold, which covered the call's estimate.
    const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.refId, id));
    expect(hold).toMatchObject({ status: 'settled' });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - hold!.amount);
    expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ status: 'failed', charged: hold!.amount, unresolved: 1 })]);
  });

  it.each([20_001, 47_001])('bills actual embedding tokens for a %i-character source, once', async (characters) => {
    const { userId, ree } = await userWithRee();
    fake.billing.embeddingTokens = 200_000;
    const path = `knowledge/${userId}/usage/large.md`;
    blobs.set(path, new TextEncoder().encode('x'.repeat(characters)));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'large.md' });
    await Promise.all([knowledge.processKnowledge(id, { profile: false }), knowledge.processKnowledge(id, { profile: false })]);
    // $0.004 of embedding (40 credits) and the file read back from Blob: rounded up once, 41.
    const price = 41;
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - price);
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail?.status).toBe('ready');
    const settled = detail?.activity.find((entry) => entry.code === 'settled')?.detail;
    expect(settled).toMatchObject({ tariff: 'provider-cost-v1', charged: price });
    expect(Number(settled!.costUsd)).toBeGreaterThan(0.004);
    expect(Number(settled!.costUsd)).toBeLessThan(0.0041);
    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt));
    expect(entries[0]).toMatchObject({ reason: 'knowledge_hold', delta: -1 });
    expect(entries.at(-1)?.reason).toBe('knowledge_settle');
    expect(entries.reduce((sum, entry) => sum + entry.delta, 0)).toBe(-price);
    await knowledge.refreshKnowledge(userId, ree.id, id);
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - price - 1);
    await knowledge.processKnowledge(id, { profile: false });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - price * 2);
    expect((await expectChargedAtLeastCost(id)).map((run) => run.charged)).toEqual([price, price]);
  });

  it('charges a call that overran the balance in full: the balance first, the rest owed', async () => {
    const { userId, ree } = await userWithRee();
    await db().update(schema.creditGrant).set({ remaining: 20 }).where(eq(schema.creditGrant.userId, userId));
    // The endpoint bills far more than the text could hold, so the reservation made before the call falls short.
    fake.billing.embeddingTokens = 200_000;
    const path = `knowledge/${userId}/usage/unfunded.md`;
    blobs.set(path, new TextEncoder().encode('x'.repeat(25_001)));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'unfunded.md' });
    const calls = fake.requests.filter((request) => request.path.endsWith('/embeddings')).length;
    await knowledge.processKnowledge(id, { profile: false });
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail).toMatchObject({ status: 'failed', error: 'insufficient_credits', chunks: [] });
    expect(fake.requests.filter((request) => request.path.endsWith('/embeddings'))).toHaveLength(calls + 1);
    // $0.004 of embedding and the file's transfer: 41 credits, all 20 the balance had, and 21 owed.
    expect(await balanceOf(db(), userId)).toBe(0);
    expect(await debtOf(userId)).toBe(21);
    expect(detail!.activity.find((entry) => entry.code === 'settled')?.detail).toMatchObject({ charged: 41, owed: 21 });
    const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.refId, id));
    expect(hold).toMatchObject({ status: 'settled', amount: 20 });
    expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ cost: 41, charged: 41, owed: 21 })]);
    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt));
    expect(entries.some((entry) => entry.note?.endsWith('21 owed'))).toBe(true);

    // The debt is paid first from the next credits to arrive.
    const { addGrant } = await import('@/lib/services/credits');
    await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: 50, reason: 'admin_adjust', refId: id }));
    expect(await debtOf(userId)).toBe(0);
    expect(await balanceOf(db(), userId)).toBe(29);
  });

  it('refuses the call before it is made when the balance cannot cover its estimate', async () => {
    const { userId, ree } = await userWithRee();
    await db().update(schema.creditGrant).set({ remaining: 3 }).where(eq(schema.creditGrant.userId, userId));
    const path = `knowledge/${userId}/usage/estimate.md`;
    // 400 kB of text: at most ~400k tokens, $0.008, 80 credits -- more than the 3 the balance has.
    blobs.set(path, new TextEncoder().encode('word '.repeat(80_000)));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'estimate.md' });
    const calls = fake.requests.filter((request) => request.path.endsWith('/embeddings')).length;
    await knowledge.processKnowledge(id, { profile: false });
    expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'failed', error: 'insufficient_credits', chunks: [] });
    expect(fake.requests.filter((request) => request.path.endsWith('/embeddings'))).toHaveLength(calls);
    // No supplier was paid; reading the file back from Blob was, and that one credit is the whole charge.
    expect(await balanceOf(db(), userId)).toBe(2);
    expect(await debtOf(userId)).toBe(0);
    expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ cost: 1, charged: 1, receipts: 1 })]);
  });

  it('refuses a scanned PDF before Firecrawl when the balance cannot cover its pages', async () => {
    const { userId, ree } = await userWithRee();
    // 30 scanned pages at 1 Firecrawl credit each, $0.001 per credit: 300 credits.
    await db().update(schema.creditGrant).set({ remaining: 299 }).where(eq(schema.creditGrant.userId, userId));
    const path = `knowledge/${userId}/usage/scan-unfunded.pdf`;
    blobs.set(path, scannedHandbookPdf());
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'scan-unfunded.pdf' });
    const firecrawlCalls = firecrawl.requests.length;
    await knowledge.processKnowledge(id, { profile: false });
    expect(firecrawl.requests).toHaveLength(firecrawlCalls);
    expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'failed', error: 'insufficient_credits' });
    // Only the file's read from Blob was spent: one credit.
    expect(await balanceOf(db(), userId)).toBe(298);
    expect(await debtOf(userId)).toBe(0);
    await expectChargedAtLeastCost(id);
  });

  it('keeps supplier costs already reserved when a later call runs out of credits', async () => {
    const { userId, ree } = await userWithRee();
    await db().update(schema.creditGrant).set({ remaining: 310 }).where(eq(schema.creditGrant.userId, userId));
    fake.billing.embeddingTokens = 200_000;
    const path = `knowledge/${userId}/usage/parsed-then-unfunded.pdf`;
    blobs.set(path, scannedHandbookPdf());
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'parsed-then-unfunded.pdf' });
    await knowledge.processKnowledge(id, { profile: false });
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail).toMatchObject({ status: 'failed', error: 'insufficient_credits', chunks: [] });
    // Firecrawl's 300, the overrunning embedding's 40 and the file's transfer: 341, of which the balance had 310.
    expect(detail!.activity.find((entry) => entry.code === 'settled')?.detail).toMatchObject({ charged: 341, released: 0, owed: 31 });
    expect(detail!.activity.some((entry) => entry.code === 'refunded')).toBe(false);
    expect(await balanceOf(db(), userId)).toBe(0);
    expect(await debtOf(userId)).toBe(31);
    const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.refId, id));
    expect(hold).toMatchObject({ status: 'settled', amount: 310 });
    const [run] = await db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.id, hold!.id));
    expect(run).toMatchObject({ status: 'failed', error: 'insufficient_credits', chargedCredits: 341 });
    expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ cost: 341, charged: 341 })]);
  });

  it('keeps what a run spent when embedding fails, returning only the unused reservation', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/usage/unavailable.pdf`;
    blobs.set(path, scannedHandbookPdf());
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'unavailable.pdf' });
    const spy = vi.spyOn(models, 'embedTexts').mockRejectedValueOnce(new Error('embedding offline'));
    try {
      await knowledge.processKnowledge(id, { profile: false });
      expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'failed', error: 'embedding_unavailable', chunks: [] });
      // P1: Firecrawl's 300 and the file's transfer stay charged (301); nothing else was reserved.
      expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 301);
      const [hold] = await db().select().from(schema.creditHold).where(eq(schema.creditHold.refId, id));
      expect(hold).toMatchObject({ status: 'settled' });
      expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ status: 'failed', cost: 301, charged: 301 })]);
      // Reprocessing it is billed again in full.
      await knowledge.refreshKnowledge(userId, ree.id, id);
      await knowledge.processKnowledge(id, { profile: false });
      expect((await expectChargedAtLeastCost(id)).map((run) => [run.status, run.charged])).toEqual([['failed', 301], ['ready', 301]]);
      expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 602);
    } finally {
      spy.mockRestore();
    }
  });

  it('allows source metadata changes during embedding without abandoning the reservation', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/usage/rename.md`;
    blobs.set(path, new TextEncoder().encode('x'.repeat(25_001)));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'rename.md' });
    const originalEmbed = models.embedTexts;
    const spy = vi.spyOn(models, 'embedTexts').mockImplementationOnce(async (...args) => {
      const { renameKnowledge } = await import('@/lib/services/knowledge-library');
      await renameKnowledge(ree.id, id, 'Updated title');
      return originalEmbed(...args);
    });
    try {
      await knowledge.processKnowledge(id, { profile: false });
      expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'ready', title: 'Updated title' });
      expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([false, true])('keeps a retried run funded when a timed-out worker returns (old failure: %s)', async (oldFails) => {
    const { userId, ree } = await userWithRee();
    fake.billing.embeddingTokens = 200_000;
    const path = `knowledge/${userId}/usage/recovered.md`;
    blobs.set(path, new TextEncoder().encode('x'.repeat(25_001)));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'recovered.md' });
    let enterOld!: () => void;
    let enterNew!: () => void;
    let resumeOld!: () => void;
    let resumeNew!: () => void;
    const oldEntered = new Promise<void>((resolve) => { enterOld = resolve; });
    const newEntered = new Promise<void>((resolve) => { enterNew = resolve; });
    const oldPaused = new Promise<void>((resolve) => { resumeOld = resolve; });
    const newPaused = new Promise<void>((resolve) => { resumeNew = resolve; });
    const originalEmbed = models.embedTexts;
    const spy = vi.spyOn(models, 'embedTexts')
      .mockImplementationOnce(async (...args) => {
        enterOld();
        await oldPaused;
        if (oldFails) throw new Error('timed-out embedding returned an error');
        return originalEmbed(...args);
      })
      .mockImplementationOnce(async (...args) => {
        enterNew();
        await newPaused;
        return originalEmbed(...args);
      });
    const oldRun = knowledge.processKnowledge(id, { profile: false });
    let newRun: Promise<string | null> | undefined;
    try {
      await oldEntered;
      // The dead run is resumed: it had read the file from Blob, and that cost stays charged (1); the rest of its
      // reservation came back, and the source waits again on a fresh reservation (1).
      expect(await knowledge.recoverStale(ree.id, new Date(Date.now() + 16 * 60_000))).toEqual([id]);
      expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'pending' });
      expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 2);
      newRun = knowledge.processKnowledge(id, { profile: false });
      await newEntered;
      resumeOld();
      expect(await oldRun).toBeNull();
      expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'processing' });
      expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 2);
      resumeNew();
      await newRun;
      expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'ready' });
      // The resumed run works from what the first one read: it does not read the upload again, so it pays for embedding only.
      expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1 - 40);
      const costs = await db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.knowledgeId, id));
      expect(costs).toHaveLength(2);
      // The timed-out run's late embedding is refused before it is sent, so its only receipt is the Blob read.
      expect(costs.find((run) => run.status === 'failed')).toMatchObject({ chargedCredits: 1, charges: [expect.objectContaining({ service: 'bandwidth' })] });
      expect(costs.find((run) => run.status === 'ready')).toMatchObject({ chargedCredits: 40 });
      expect(costs.find((run) => run.status === 'ready')!.charges.map((charge) => charge.service)).toEqual(['embedding']);
      expect(costs.find((run) => run.status === 'ready')!.charges.find((charge) => charge.service === 'embedding')).toMatchObject({ costUsd: '0.004000000000' });
      await expectChargedAtLeastCost(id);
    } finally {
      resumeOld();
      resumeNew();
      await Promise.allSettled([oldRun, newRun]);
      spy.mockRestore();
    }
  });

  it('parses a 30-page text PDF locally and settles only the embedding', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/1/handbook.pdf`;
    blobs.set(path, makePdf(handbookPages()));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'handbook.pdf' });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1);
    const firecrawlCalls = firecrawl.requests.length;

    await knowledge.processKnowledge(id, { profile: false });
    expect(firecrawl.requests).toHaveLength(firecrawlCalls);
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail?.status).toBe('ready');
    expect(detail?.chunks).toHaveLength(30);
    expect(detail?.chunks[2]?.locator).toMatchObject({ page: 3 });
    expect(detail?.chunks[2]?.content).toContain('within 14 days');
    // Two receipts: the file read back from Blob, and the embedding.
    expect(detail?.activity.map((entry) => entry.code).filter((code) => code !== 'reserved')).toEqual(['added', 'processing', 'provider_usage', 'provider_usage', 'parsed', 'chunked', 'settled', 'ready']);
    expect(detail!.activity.find((entry) => entry.code === 'parsed')?.detail).toMatchObject({ pages: 30 });

    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt));
    expect(entries.at(-1)?.reason).toBe('knowledge_settle');
    expect(entries.reduce((sum, entry) => sum + entry.delta, 0)).toBe(-1);
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1);
    await expectChargedAtLeastCost(id);
    const [run] = await db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.knowledgeId, id));
    expect(run).toMatchObject({ status: 'ready', chargedCredits: 1 });
    expect(run!.charges.map((charge) => charge.service)).toEqual(['bandwidth', 'embedding']);

    const listed = await knowledge.listKnowledge(ree.id, { q: 'refunds', status: 'ready', kind: 'all', sort: 'recent', size: 20, page: 1 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ chunks: 30, chars: detail!.content!.length });
    expect(listed.counts).toMatchObject({ all: 1, ready: 1, processing: 0, failed: 0 });
  });

  it('sends a 30-page PDF with a scanned page to Firecrawl and settles the real price', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/1/scanned.pdf`;
    blobs.set(path, scannedHandbookPdf());
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'scanned.pdf' });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1);
    const firecrawlCalls = firecrawl.requests.length;

    await knowledge.processKnowledge(id, { profile: false });
    expect(firecrawl.requests).toHaveLength(firecrawlCalls + 1);
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail?.status).toBe('ready');
    expect(detail?.chunks).toHaveLength(30);
    expect(detail?.chunks[2]?.locator).toMatchObject({ page: 3 });
    const price = 301;
    // The 30 pages are reserved before the file goes to Firecrawl.
    const codes = detail!.activity.map((entry) => entry.code);
    expect(codes.indexOf('reserved')).toBeLessThan(codes.indexOf('provider_usage'));
    expect(detail!.activity.find((entry) => entry.code === 'reserved')?.detail).toMatchObject({ credits: 299, estimate: 1 });
    // Receipts: Firecrawl, the transfer (Blob read and the upload to Firecrawl, one each), the embedding.
    expect(codes.filter((code) => code !== 'reserved')).toEqual(['added', 'processing', 'provider_usage', 'provider_usage', 'provider_usage', 'provider_usage', 'parsed', 'chunked', 'settled', 'ready']);

    const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt));
    expect(entries.slice(0, 2).map((entry) => [entry.reason, entry.delta])).toEqual([['knowledge_hold', -1], ['knowledge_hold', -299]]);
    expect(entries.at(-1)?.reason).toBe('knowledge_settle');
    expect(entries.reduce((sum, entry) => sum + entry.delta, 0)).toBe(-price);
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - price);
    expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ cost: price, charged: price })]);
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
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS);

    blobs.set(path, new TextEncoder().encode('# Notes\n\nThe office opens at nine.'));
    await knowledge.refreshKnowledge(userId, ree.id, id);
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1);
    await knowledge.processKnowledge(id, { profile: false });
    expect((await knowledge.knowledgeDetail(ree.id, id))?.status).toBe('ready');
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1);
    const reasons = (await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt))).map((entry) => entry.reason);
    expect(reasons.filter((reason, at) => reason !== 'knowledge_hold' || reasons[at - 1] !== 'knowledge_hold')).toEqual(['knowledge_hold', 'knowledge_refund', 'knowledge_hold', 'knowledge_settle']);
    expect((await expectChargedAtLeastCost(id)).map((run) => [run.status, run.charged])).toEqual([['failed', 0], ['ready', 1]]);
  });

  it('processes pasted text at its exact price and refuses a busy refresh', async () => {
    const { userId, ree } = await userWithRee();
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'text', title: 'Policy', content: 'Refund policy. '.repeat(100) });
    await expect(knowledge.refreshKnowledge(userId, ree.id, id)).rejects.toMatchObject({ code: 'busy' });
    await knowledge.processKnowledge(id, { profile: false });
    await knowledge.processKnowledge(id, { profile: false });
    expect((await knowledge.knowledgeDetail(ree.id, id))?.status).toBe('ready');
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1);
    expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ status: 'ready', charged: 1 })]);
  });

  it('rejects a file type outside the four document formats', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/3/run.exe`;
    blobs.set(path, new Uint8Array([1, 2, 3]));
    await expect(knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'run.exe' })).rejects.toMatchObject({ code: 'invalid_document' });
  });

  it('parses Word locally, bills only the embedding and makes it retrievable', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/word/warranty.docx`;
    blobs.set(path, makeDocx([
      word.heading(1, 'Warranty'),
      word.paragraph('Devices are covered for two years.'),
      word.table([['Item', 'Years'], ['Device', '2']]),
    ]));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'warranty.docx' });
    const firecrawlCalls = firecrawl.requests.length;
    await knowledge.processKnowledge(id, { profile: false });
    expect(firecrawl.requests).toHaveLength(firecrawlCalls);
    const detail = await knowledge.knowledgeDetail(ree.id, id);
    expect(detail).toMatchObject({ status: 'ready' });
    expect(detail!.content).toContain('| Device | 2 |');
    expect(detail!.chunks.some((chunk) => chunk.content.includes('two years'))).toBe(true);
    expect(detail!.chunks.every((chunk) => chunk.locator.page === undefined)).toBe(true);
    const settled = detail!.activity.find((entry) => entry.code === 'settled')!.detail!;
    expect(settled).not.toHaveProperty('unresolvedCalls');
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - Number(settled.charged));
    const [run] = await db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.knowledgeId, id));
    expect(run!.charges.map((charge) => charge.service)).toEqual(['bandwidth', 'embedding']);
    await expectChargedAtLeastCost(id);
    const { retrieve } = await import('@/lib/services/chat');
    const result = await retrieve(ree.id, 'Devices are covered for how many years?');
    expect(result.evidence).toBe(true);
    expect(result.passages.some((passage) => passage.knowledgeId === id && passage.content.includes('two years'))).toBe(true);
  });

  it('fails a Word file that is not a document, keeping only the cost of reading it', async () => {
    const { userId, ree } = await userWithRee();
    const path = `knowledge/${userId}/word/broken.docx`;
    blobs.set(path, new Uint8Array([80, 75, 3, 4]));
    const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'broken.docx' });
    await knowledge.processKnowledge(id, { profile: false });
    expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'failed', error: 'parse_failed', chunks: [] });
    expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 1);
    expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ status: 'failed', charged: 1, receipts: 1 })]);
  });

  it('fails when Firecrawl cannot provide PDF page attribution, keeping what Firecrawl cost', async () => {
    const route = 'api.firecrawl.dev/v2/parse';
    const original = firecrawl.routes.get(route)!;
    firecrawl.routes.set(route, () => jsonResponse({ success: true, data: { markdown: 'Text without page numbers.', metadata: { creditsUsed: 30 } } }));
    try {
      const { userId, ree } = await userWithRee();
      const path = `knowledge/${userId}/bad/unreadable.pdf`;
      blobs.set(path, scannedHandbookPdf());
      const id = await knowledge.addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'unreadable.pdf' });
      await knowledge.processKnowledge(id);
      expect(await knowledge.knowledgeDetail(ree.id, id)).toMatchObject({ status: 'failed', error: 'parse_failed', chunks: [] });
      expect(await balanceOf(db(), userId)).toBe(WELCOME_CREDITS - 301);
      const entries = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, id)).orderBy(asc(schema.creditEntry.createdAt));
      expect(entries.map((entry) => entry.reason)).not.toContain('knowledge_refund');
      expect(await expectChargedAtLeastCost(id)).toEqual([expect.objectContaining({ status: 'failed', cost: 301, charged: 301 })]);
    } finally {
      firecrawl.routes.set(route, original);
    }
  });
});

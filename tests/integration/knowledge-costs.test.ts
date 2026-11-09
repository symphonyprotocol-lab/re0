import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { startFakeFirecrawl } from '../fixtures/fake-firecrawl';
import { handbookPages, makePdf, scannedHandbookPdf } from '../fixtures/pdf';
import type { FakeWeb } from '../fixtures/fake-web';
import { knowledgeCostsView } from '@/lib/domain/knowledge-costs';
import { providerTotal, type ProviderCharge } from '@/lib/domain/provider-cost';
import { knowledgeCostDetail, knowledgeCostReport } from '@/lib/services/admin-knowledge-costs';
import { db, schema } from '@/lib/infra/db';
import { createSession } from '@/lib/services/auth';
import { forgetModelCache } from '@/lib/infra/ai/models';
import { addKnowledge, processKnowledge, recoverStale, refreshKnowledge } from '@/lib/services/knowledge';
import { createReeFromDraft, saveDraft } from '@/lib/services/rees';
import { newReeDraft } from '@/lib/domain/ree';

const blobs = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('@/lib/infra/blob', () => ({ blobSize: async (p: string) => blobs.get(p)?.length ?? null, readBlob: async (p: string) => blobs.get(p) ?? null }));
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
let fake: FakeOpenAi;
let firecrawl: FakeWeb;
beforeAll(async () => { fake = await startFakeOpenAi(); pointModelsAt(fake.baseUrl); forgetModelCache(); firecrawl = startFakeFirecrawl(); });
afterAll(async () => { firecrawl?.restore(); vi.unstubAllEnvs(); await fake?.close(); });

async function owner() {
  const subject = uniqueName('costs');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'zh', '/');
  await saveDraft(userId, { ...newReeDraft(), name: subject, category: 'business', step: 4, reached: 4 });
  const { ree } = await createReeFromDraft(userId);
  return { userId, ree, subject };
}
describeWithDb('knowledge cost reconciliation reports', () => {
  it('closes a legacy processing snapshot when stale recovery refunds its reservation', async () => {
    const { userId, ree } = await owner();
    const source = await addKnowledge(userId, ree, { kind: 'text', title: 'Legacy interrupted', content: 'Pending old work.' });
    const old = new Date(Date.now() - 20 * 60_000);
    await db().update(schema.knowledge).set({ status: 'processing', updatedAt: old, activity: [{ code: 'processing', at: old.toISOString() }] }).where(eq(schema.knowledge.id, source));
    await db().update(schema.knowledgeCostRun).set({ status: 'processing', metered: false }).where(eq(schema.knowledgeCostRun.knowledgeId, source));
    await recoverStale(ree.id);
    const [snapshot] = await db().select().from(schema.knowledgeCostRun).where(eq(schema.knowledgeCostRun.knowledgeId, source));
    expect(await knowledgeCostDetail(snapshot!.id)).toMatchObject({ status: 'failed', chargedCredits: 0, refundedCredits: 1, heldCredits: 0, metered: false, costUsd: null });
  });

  it('keeps retries separate, includes failed supplier costs, excludes open holds from net charges, and retains receipts after source purge', async () => {
    const { userId, ree, subject } = await owner();
    // A scanned page sends the file to (fake) Firecrawl, whose credits are part of the cost.
    const path = `knowledge/${userId}/costs/test.pdf`;
    blobs.set(path, scannedHandbookPdf());
    const source = await addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'test.pdf' });
    await Promise.all([processKnowledge(source, { profile: false }), processKnowledge(source, { profile: false })]);
    await refreshKnowledge(userId, ree.id, source);
    fake.billing.omitEmbeddingUsage = true;
    await processKnowledge(source, { profile: false });
    fake.billing.omitEmbeddingUsage = false;
    await addKnowledge(userId, ree, { kind: 'text', title: 'Pending', content: 'Pending reservation.' });
    const view = knowledgeCostsView({ q: subject });
    const report = await knowledgeCostReport(view);
    expect(report.summary).toMatchObject({ attempts: 3, ready: 1, failed: 1, active: 1, unknown: 1, chargedCredits: 301, heldCredits: 1 });
    expect(Number(report.summary.knownCostUsd)).toBeCloseTo(0.06002, 12);
    expect(Number(report.summary.failedCostUsd)).toBe(0.03);
    expect(report.providers.map((p) => [p.service, p.calls]).sort()).toEqual([['embedding', 1], ['embedding', 1], ['firecrawl', 2]]);
    const ready = report.items.find((r) => r.status === 'ready')!;
    const failed = report.items.find((r) => r.status === 'failed')!;
    expect(ready.charges).toHaveLength(2);
    expect(ready.refundedCredits).toBe(ready.reservedCredits - ready.chargedCredits!);
    expect(providerTotal(ready.charges).credits).toBe(ready.chargedCredits);
    // A failure gives back its whole reservation: Firecrawl's 300 and the embedding estimate reserved before the call.
    expect(failed).toMatchObject({ costUsd: null, chargedCredits: 0, unresolved: 1 });
    expect(failed.reservedCredits).toBeGreaterThanOrEqual(300);
    expect(failed.refundedCredits).toBe(failed.reservedCredits);
    // Refunded in all: the failure's reservation and what the ready run's estimates reserved beyond its measured cost.
    expect(report.summary.refundedCredits).toBe(failed.refundedCredits + ready.refundedCredits);
    const ledger = await db().select().from(schema.creditEntry).where(eq(schema.creditEntry.refId, source));
    expect(-ledger.reduce((total, entry) => total + entry.delta, 0)).toBe(report.summary.chargedCredits);
    expect((await knowledgeCostReport({ ...view, size: 1, page: 99 })).page).toBe(3);
    expect((await knowledgeCostReport({ ...view, size: 1, page: 99 })).summary).toEqual(report.summary);
    expect((await knowledgeCostReport({ ...view, status: 'failed' })).items.map((r) => r.id)).toEqual([failed.id]);
    expect((await knowledgeCostReport({ ...view, kind: 'audio' })).total).toBe(0);
    expect((await knowledgeCostReport({ ...view, period: 'day', date: '2000-01-01' })).total).toBe(0);
    expect((await knowledgeCostReport({ ...view, sort: 'cost-high' })).items[0]?.id).toBe(ready.id);
    await db().delete(schema.chunk).where(eq(schema.chunk.knowledgeId, source));
    await db().delete(schema.knowledge).where(eq(schema.knowledge.id, source));
    expect((await knowledgeCostDetail(ready.id))?.charges).toEqual(ready.charges);
    expect((await knowledgeCostReport(view)).summary).toEqual(report.summary);
    expect(await knowledgeCostDetail('not-a-uuid')).toBeNull();
  });

  it('reports a locally parsed document with its embedding receipt only and a known cost', async () => {
    const { userId, ree, subject } = await owner();
    const path = `knowledge/${userId}/costs/local.pdf`;
    blobs.set(path, makePdf(handbookPages()));
    const source = await addKnowledge(userId, ree, { kind: 'document', blobPath: path, fileName: 'local.pdf' });
    await processKnowledge(source, { profile: false });
    const report = await knowledgeCostReport(knowledgeCostsView({ q: subject }));
    expect(report.summary).toMatchObject({ attempts: 1, ready: 1, failed: 0, active: 0, unknown: 0, chargedCredits: 1, heldCredits: 0 });
    expect(report.providers.map((p) => [p.service, p.calls, p.unresolved, p.firecrawlCredits])).toEqual([['embedding', 1, 0, '0']]);
    const [run] = report.items;
    expect(run).toMatchObject({ status: 'ready', kind: 'document', metered: true, calls: 1, unresolved: 0, chargedCredits: 1 });
    // The embedding was reserved at its upper bound before the call; what that held beyond the measured cost came back.
    expect(run!.reservedCredits).toBeGreaterThan(1);
    expect(report.summary.refundedCredits).toBe(run!.reservedCredits - 1);
    expect(run!.costUsd).toBe(run!.knownCostUsd);
    expect(Number(run!.costUsd)).toBeGreaterThan(0);
    expect(providerTotal(run!.charges).credits).toBe(run!.chargedCredits);
  });

  it('backfills exact historical receipts and legacy reservations without fabricating zero costs', async () => {
    const { userId, ree } = await owner();
    const at = new Date('2026-01-02T01:00:00Z');
    const runId = crypto.randomUUID();
    const charge: ProviderCharge = { id: crypto.randomUUID(), runId, at: at.toISOString(), service: 'transcription', endpoint: 'https://example.test', model: 'whisper', basis: 'provider_reported', usage: { seconds: 4.420000076293945 }, costUsd: '0.0004420000076293945', generationId: 'gen_test' };
    const [source] = await db().insert(schema.knowledge).values({ reeId: ree.id, kind: 'audio', title: 'Historical', originalTitle: 'Historical', status: 'failed', activity: [
      { at: at.toISOString(), code: 'processing', detail: { runId } },
      { at: at.toISOString(), code: 'provider_usage', detail: { runId, charge: JSON.stringify(charge) } },
      { at: at.toISOString(), code: 'failed', detail: { reason: 'embedding_unavailable' } },
    ] }).returning();
    const [hold] = await db().insert(schema.creditHold).values({ userId, kind: 'knowledge', amount: 5, allocations: [], status: 'released', refId: source!.id, createdAt: at, closedAt: at }).returning();
    const [legacy] = await db().insert(schema.creditHold).values({ userId, kind: 'knowledge', amount: 20, allocations: [], status: 'settled', refId: crypto.randomUUID(), createdAt: at, closedAt: at }).returning();
    const migration = readFileSync(new URL('../../db/migrations/0016_knowledge_cost_runs.sql', import.meta.url), 'utf8');
    const backfill = migration.slice(migration.indexOf('WITH holds AS')).trim().replace(/;$/, ' ON CONFLICT (id) DO NOTHING;');
    await db().execute(sql.raw(backfill));
    expect(await knowledgeCostDetail(hold!.id)).toMatchObject({ status: 'failed', costUsd: charge.costUsd, chargedCredits: 0, refundedCredits: 5, charges: [charge], metered: true });
    expect(await knowledgeCostDetail(legacy!.id)).toMatchObject({ costUsd: null, knownCostUsd: '0', metered: false, chargedCredits: 20 });
  });
});

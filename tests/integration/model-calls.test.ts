import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/lib/infra/db';
import { modelCallDetail, modelCallReport } from '@/lib/services/admin-model-calls';
import { modelCallsView } from '@/lib/domain/model-calls';
import { providerRateSchema } from '@/lib/domain/provider-cost';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
describeWithDb('generation call reports', () => {
  const model = uniqueName('report-gen');
  const pagedModel = `${model}-pages`;
  const rate = providerRateSchema.parse({ service: 'generation', endpoint: 'https://provider.test/v1', model, unit: 'tokens', usdPerUnit: '0.000001', outputUsdPerUnit: '0.000002', source: 'Contract snapshot' });
  let ids: string[] = [];
  let nonGeneration = '';
  const view = (params = '') => modelCallsView(new URLSearchParams(`model=${model}&${params}`));
  beforeAll(async () => {
    const rows = await db().insert(schema.modelCall).values([
      { kind: 'generation', model, configName: 'Old configuration name', audience: 'free', purpose: 'answer', status: 'succeeded', inputTokens: 100, outputTokens: 50, usageKnown: true, durationMs: 200, endpoint: rate.endpoint, costUsd: '0.0012', costBasis: 'configured_rate', rate, priceRevision: 'v1', createdAt: new Date('2026-11-01T16:00:00Z') },
      { kind: 'generation', model, audience: 'plan', purpose: 'answer', status: 'failed', inputTokens: 20, outputTokens: 10, usageKnown: true, durationMs: 100, endpoint: rate.endpoint, costUsd: '0.0003', costBasis: 'provider_reported', createdAt: new Date('2026-11-02T15:59:59Z') },
      { kind: 'generation', model, audience: 'plan', purpose: 'video_script', status: 'succeeded', inputTokens: 40, outputTokens: 20, usageKnown: true, durationMs: 300, endpoint: 'https://other.test/v1', costUsd: '0.0004', costBasis: 'estimated', createdAt: new Date('2026-11-02T16:00:00Z') },
      { kind: 'generation', model, inputTokens: 10, outputTokens: 5, createdAt: new Date('2026-11-01T15:59:59Z') },
      { kind: 'embedding', model, inputTokens: 999 },
    ]).returning({ id: schema.modelCall.id });
    ids = rows.map((r) => r.id); nonGeneration = ids[4]!;
    const pages = await db().insert(schema.modelCall).values(Array.from({ length: 23 }, () => ({ kind: 'generation' as const, model: pagedModel, status: 'succeeded' as const, costUsd: '0', costBasis: 'configured_rate' as const }))).returning({ id: schema.modelCall.id });
    ids.push(...pages.map((r) => r.id));
  });
  afterAll(async () => { if (ids.length) await db().delete(schema.modelCall).where(inArray(schema.modelCall.id, ids)); });

  it('aggregates the full selection, separates estimates and unknown costs, and excludes embeddings', async () => {
    const report = await modelCallReport(view());
    expect(report.total).toBe(4);
    expect(report.summary).toMatchObject({ calls: 4, succeeded: 2, failed: 1, unknown: 1, inputTokens: 170, outputTokens: 85, averageMs: 200, knownCostUsd: '0.0015', estimatedCostUsd: '0.0004', unpriced: 1 });
    expect(report.models).toHaveLength(4);
    expect((await modelCallReport(view('audience=plan'))).summary).toMatchObject({ calls: 2, failed: 1, knownCostUsd: '0.0003' });
    expect((await modelCallReport(view('status=failed&purpose=answer'))).items[0]?.id).toBe(ids[1]);
    expect((await modelCallReport(view('audience=unknown'))).items[0]?.status).toBe('unknown');
  });
  it('uses UTC+8 boundaries and exact decimal cost sorting with unknowns last', async () => {
    expect((await modelCallReport(view('period=custom&start=2026-11-02&end=2026-11-02'))).items.map((r) => r.id).sort()).toEqual(ids.slice(0, 2).sort());
    expect((await modelCallReport(view('sort=cost-high'))).items.map((r) => r.id)).toEqual([ids[0], ids[2], ids[1], ids[3]]);
    expect((await modelCallReport(view('sort=cost-low'))).items.map((r) => r.id)).toEqual([ids[1], ids[2], ids[0], ids[3]]);
  });
  it('paginates and exports all matches without changing totals', async () => {
    const params = modelCallsView(new URLSearchParams(`model=${pagedModel}&page=999`));
    const report = await modelCallReport(params);
    expect(report).toMatchObject({ total: 23, page: 2, size: 20 });
    expect(report.items).toHaveLength(3);
    expect((await modelCallReport(params, { all: true })).items).toHaveLength(23);
    expect((await modelCallReport(view('q=unmatched'))).summary).toMatchObject({ calls: 0, knownCostUsd: '0', unpriced: 0 });
  });
  it('shows historical snapshots in details without exposing other model kinds', async () => {
    expect(await modelCallDetail(ids[0]!)).toMatchObject({ configName: 'Old configuration name', rate, priceRevision: 'v1', costUsd: '0.0012', audience: 'free' });
    expect(await modelCallDetail('invalid')).toBeNull();
    expect(await modelCallDetail(nonGeneration)).toBeNull();
    await db().delete(schema.modelCall).where(eq(schema.modelCall.id, ids[0]!));
    expect(await modelCallDetail(ids[0]!)).toBeNull();
  });
});

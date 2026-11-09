import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { count, eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/lib/infra/db';
import { applyGenerationCostBackfill, planGenerationCostBackfill } from '@/lib/services/backfill-generation-costs';
import { callCostBasis } from '@/lib/domain/model-calls';
import { providerRateSchema } from '@/lib/domain/provider-cost';

vi.mock('@/lib/infra/ai/gateway-generation-pricing', () => ({ gatewayGenerationPricing: async (model: string) => ({ rate: providerRateSchema.parse({ service: 'generation', endpoint: 'https://ai-gateway.vercel.sh/v1', model, unit: 'tokens', usdPerUnit: '0.00000025', outputUsdPerUnit: '0.000002', source: 'https://ai-gateway.vercel.sh/v1/models' }), priceRevision: 'gateway-catalog:test', estimated: true }) }));
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
describeWithDb('historical generation cost backfill', () => {
  const model = uniqueName('history');
  const cutoff = new Date('2026-11-03T00:00:00Z');
  const old = new Date('2026-11-01T00:00:00Z');
  let before: typeof schema.providerPricing.$inferSelect | undefined;
  let ids: string[] = []; let configs: string[] = [];
  beforeAll(async () => {
    [before] = await db().select().from(schema.providerPricing);
    const rows = await db().insert(schema.modelConfig).values([
      { name: 'Original', kind: 'generation', transport: 'openai_compatible', model, baseUrl: 'https://custom.test/v1' },
      { name: 'Other endpoint', kind: 'generation', transport: 'openai_compatible', model, baseUrl: 'https://other.test/v1' },
    ]).returning(); configs = rows.map((row) => row.id);
    const rate = providerRateSchema.parse({ service: 'generation', endpoint: 'https://custom.test/v1', model, unit: 'tokens', usdPerUnit: '0.000001', outputUsdPerUnit: '0.000002', source: 'Current custom contract' });
    await db().insert(schema.providerPricing).values({ id: 1, rates: [rate] }).onConflictDoUpdate({ target: schema.providerPricing.id, set: { rates: [rate] } });
    const call = { kind: 'generation' as const, model, createdAt: old, inputTokens: 100, outputTokens: 50 };
    const calls = await db().insert(schema.modelCall).values([
      { ...call, configId: configs[0] }, // legacy token counts; known current custom model
      { ...call, endpoint: 'https://ai-gateway.vercel.sh/v1', usageKnown: true, status: 'succeeded' },
      { ...call }, // same name on multiple endpoints, with no historical endpoint
      { ...call, configId: configs[0], inputTokens: 0, outputTokens: 0 },
      { ...call, configId: configs[0], usageKnown: false, status: 'failed', outputTokens: 0 },
      { ...call, endpoint: 'https://unpriced.test/v1' },
      { ...call, costUsd: '0.123', costBasis: 'provider_reported' },
      { ...call, costUsd: '0.456', costBasis: 'estimated' },
      { ...call, createdAt: new Date('2026-11-04T00:00:00Z'), configId: configs[0] },
    ]).returning({ id: schema.modelCall.id }); ids = calls.map((row) => row.id);
  });
  afterAll(async () => {
    if (ids.length) await db().delete(schema.modelCall).where(inArray(schema.modelCall.id, ids));
    if (configs.length) await db().delete(schema.modelConfig).where(inArray(schema.modelConfig.id, configs));
    await db().delete(schema.providerPricing); if (before) await db().insert(schema.providerPricing).values(before);
  });
  it('plans only missing historical prices using the correct model/endpoint and current prices', async () => {
    const plan = await planGenerationCostBackfill({ before: cutoff, model });
    expect(plan.candidates).toBe(6);
    expect(plan.estimates.map((row) => [row.id, row.costUsd]).sort()).toEqual([[ids[0], '0.000200000000'], [ids[1], '0.000125000000']].sort());
    expect(plan.skipped.map((row) => row.reason).sort()).toEqual(['ambiguous_model', 'missing_price', 'missing_usage', 'missing_usage']);
    const rows = await db().select().from(schema.modelCall).where(inArray(schema.modelCall.id, ids));
    expect(rows.filter((row) => row.costUsd !== null)).toHaveLength(2); // planning never writes
  });
  it('writes labelled snapshots idempotently, retaining legacy identity/status and customer credits', async () => {
    const [ledgerBefore] = await db().select({ count: count() }).from(schema.creditEntry);
    const plan = await planGenerationCostBackfill({ before: cutoff, model });
    expect(await applyGenerationCostBackfill(plan)).toMatchObject({ updated: 2, unchanged: 0, skipped: 4 });
    expect(await applyGenerationCostBackfill(plan)).toMatchObject({ updated: 0, unchanged: 2 });
    const [legacy] = await db().select().from(schema.modelCall).where(eq(schema.modelCall.id, ids[0]!));
    expect(legacy).toMatchObject({ costUsd: '0.000200000000', costBasis: 'estimated', status: 'unknown', usageKnown: false, audience: null, userId: null, rate: { source: 'Current custom contract' } });
    expect(legacy?.priceRevision).toMatch(/^backfill:/);
    expect(callCostBasis(legacy!)).toBe('historical_estimate');
    expect((await db().select().from(schema.modelCall).where(eq(schema.modelCall.id, ids[6]!)))[0]?.costUsd).toBe('0.123');
    expect((await db().select().from(schema.modelCall).where(eq(schema.modelCall.id, ids[7]!)))[0]?.costUsd).toBe('0.456');
    expect((await db().select({ count: count() }).from(schema.creditEntry))[0]).toEqual(ledgerBefore);
    expect((await planGenerationCostBackfill({ before: cutoff, model })).estimates).toHaveLength(0);
  });
  it('does not overwrite costs filled after planning', async () => {
    await db().update(schema.modelCall).set({ costUsd: null }).where(eq(schema.modelCall.id, ids[0]!));
    const plan = await planGenerationCostBackfill({ before: cutoff, model });
    await db().update(schema.modelCall).set({ costUsd: '0.777', costBasis: 'provider_reported' }).where(eq(schema.modelCall.id, ids[0]!));
    expect(await applyGenerationCostBackfill(plan)).toMatchObject({ updated: 0, unchanged: 1 });
    expect((await db().select().from(schema.modelCall).where(eq(schema.modelCall.id, ids[0]!)))[0]?.costUsd).toBe('0.777');
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '@/lib/infra/db';
import { createModelConfig, updateModelConfig, activateModelConfig, listModelConfigs } from '@/lib/services/models';
import { providerPrices, configuredProviderRate } from '@/lib/services/provider-pricing';
import { loggedLanguageModel } from '@/lib/infra/ai/usage';
import { providerRateSchema } from '@/lib/domain/provider-cost';

vi.mock('@/lib/infra/ai/gateway-generation-pricing', () => ({ gatewayGenerationPricing: async (model: string) => ({ rate: providerRateSchema.parse({ service: 'generation', endpoint: 'https://ai-gateway.vercel.sh/v1', model, unit: 'tokens', usdPerUnit: '0.00000015', outputUsdPerUnit: '0.0000005', source: 'https://ai-gateway.vercel.sh/v1/models' }), priceRevision: 'gateway-catalog:test', estimated: true }) }));
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
type Model = Parameters<typeof loggedLanguageModel>[0];
const fake: Model = { specificationVersion: 'v4', provider: 'test', modelId: 'custom', supportedUrls: {}, doStream: vi.fn(), doGenerate: async () => ({ content: [{ type: 'text', text: 'OK' }], finishReason: { unified: 'stop', raw: 'stop' }, warnings: [], usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } } }) };

describeWithDb('generation model pricing configuration', () => {
  let adminId: string; let id: string; let gatewayId: string;
  const base = { name: 'Manual model', kind: 'generation', transport: 'openai_compatible', baseUrl: 'https://custom-pricing.test/v1', model: uniqueName('custom') };
  let before: typeof schema.providerPricing.$inferSelect | undefined;
  const calls: string[] = [];
  beforeAll(async () => {
    [before] = await db().select().from(schema.providerPricing);
    const [admin] = await db().insert(schema.administrator).values({ name: 'Price editor', email: `${uniqueName('model-pricing')}@example.test`, passwordHash: 'test', totpSecretCipher: 'test' }).returning();
    adminId = admin!.id;
  });
  afterAll(async () => {
    if (calls.length) await db().delete(schema.modelCall).where(inArray(schema.modelCall.id, calls));
    for (const configId of [id, gatewayId].filter(Boolean)) await db().delete(schema.modelConfig).where(eq(schema.modelConfig.id, configId));
    await db().delete(schema.providerPricing);
    if (before) await db().insert(schema.providerPricing).values(before);
  });
  it('saves manual input/output prices from model editing and uses them in each call snapshot', async () => {
    const created = await createModelConfig(adminId, { ...base, generationPricing: { inputUsdPerMillion: '0.15', outputUsdPerMillion: '0.5' } }); id = created.id;
    expect(created.generationPricing).toEqual({ source: 'configured', inputUsdPerMillion: '0.15', outputUsdPerMillion: '0.5' });
    expect(configuredProviderRate(await providerPrices(), { service: 'generation', endpoint: base.baseUrl, model: base.model })).toMatchObject({ usdPerUnit: '0.000000150000', outputUsdPerUnit: '0.000000500000' });
    const model = loggedLanguageModel(fake, { model: base.model, configId: id, transport: 'openai_compatible', baseUrl: base.baseUrl });
    await model.doGenerate({ prompt: [] });
    const first = await db().select().from(schema.modelCall).where(eq(schema.modelCall.configId, id)); calls.push(...first.map((r) => r.id));
    expect(first[0]).toMatchObject({ costUsd: '0.000200000000', costBasis: 'configured_rate' });
    await activateModelConfig(adminId, id, 'plan');
    const updated = await updateModelConfig(adminId, id, { ...base, generationPricing: { inputUsdPerMillion: '0.3', outputUsdPerMillion: '1' } });
    expect(updated.generationPricing).toMatchObject({ inputUsdPerMillion: '0.3', outputUsdPerMillion: '1' });
    await model.doGenerate({ prompt: [] });
    const second = await db().select().from(schema.modelCall).where(eq(schema.modelCall.configId, id)); calls.push(...second.map((r) => r.id));
    expect(second.map((r) => r.costUsd).sort()).toEqual(['0.000200000000', '0.000400000000']);
    expect(second.map((r) => r.priceRevision)[0]).not.toBe(second.map((r) => r.priceRevision)[1]);
  });
  it('preserves omitted prices, validates both prices, and permits explicitly clearing them', async () => {
    expect((await updateModelConfig(adminId, id, base)).generationPricing?.inputUsdPerMillion).toBe('0.3');
    await expect(updateModelConfig(adminId, id, { ...base, generationPricing: { inputUsdPerMillion: '1', outputUsdPerMillion: '' } })).rejects.toMatchObject({ code: 'generation_pricing' });
    expect((await updateModelConfig(adminId, id, { ...base, generationPricing: null })).generationPricing).toEqual({ source: 'unknown' });
  });
  it('always exposes Gateway prices for Gateway models despite a supplied manual price', async () => {
    const created = await createModelConfig(adminId, { name: 'Gateway model', kind: 'generation', transport: 'gateway', model: 'zai/glm-5.3-flash', generationPricing: { inputUsdPerMillion: '999', outputUsdPerMillion: '999' } }); gatewayId = created.id;
    expect(created.generationPricing).toEqual({ source: 'gateway', inputUsdPerMillion: '0.15', outputUsdPerMillion: '0.5' });
    expect((await listModelConfigs()).configs.find((row) => row.id === gatewayId)?.generationPricing).toEqual(created.generationPricing);
    expect(configuredProviderRate(await providerPrices(), { service: 'generation', endpoint: 'https://ai-gateway.vercel.sh/v1', model: 'zai/glm-5.3-flash' })).toBeUndefined();
  });
});

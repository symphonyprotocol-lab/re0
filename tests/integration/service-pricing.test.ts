import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { db, schema } from '@/lib/infra/db';
import { createModelConfig, listModelConfigs, updateModelConfig } from '@/lib/services/models';
import { deleteFirecrawlKey, listFirecrawlKeys, saveFirecrawlDefaultPricing, saveFirecrawlKey } from '@/lib/services/firecrawl-keys';
import { configuredProviderRate, providerPrices, saveProviderPrices } from '@/lib/services/provider-pricing';
import { modelPricingTarget, type ServicePricingInput } from '@/lib/domain/service-pricing';
import { providerTotal } from '@/lib/domain/provider-cost';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const price: ServicePricingInput = { unit: 'million_tokens', price: '0.02', minimumUnits: 0, incrementUnits: 0, source: 'Contract' };
const fcPrice: ServicePricingInput = { ...price, unit: 'firecrawl_credits', price: '0.0038' };
let administratorId: string;
let keyId: string;
const models: string[] = [];
describeWithDb('costs saved with service configuration', () => {
  beforeAll(async () => {
    await db().delete(schema.providerPricing);
    const [owner] = await db().insert(schema.administrator).values({ name: 'Service owner', email: `${uniqueName('service-price')}@example.test`, passwordHash: 'test', totpSecretCipher: 'test' }).returning();
    administratorId = owner!.id;
    const old = await providerPrices();
    await saveProviderPrices(administratorId, { revision: old.revision, rates: [
      { service: 'firecrawl', endpoint: 'https://api.firecrawl.dev', model: 'parse', account: '*', unit: 'firecrawl_credits', usdPerUnit: '0.0038', minimumUnits: 0, incrementUnits: 0, source: 'Existing Hobby' },
      { service: 'embedding', endpoint: 'https://embed.example.test/v1', model: 'small', account: '*', unit: 'tokens', usdPerUnit: '0.00000002', minimumUnits: 0, incrementUnits: 0, source: 'Existing embedding' },
    ] });
  });
  afterAll(async () => {
    for (const id of models) await db().delete(schema.modelConfig).where(eq(schema.modelConfig.id, id));
    if (keyId) await db().delete(schema.firecrawlKey).where(eq(schema.firecrawlKey.id, keyId));
    await db().delete(schema.providerPricing);
  });
  it('exposes existing rates in the owning model editor without a data migration', async () => {
    const config = await createModelConfig(administratorId, { name: 'Existing embedding', kind: 'embedding', transport: 'openai_compatible', baseUrl: 'https://embed.example.test/v1', model: 'small' });
    models.push(config.id);
    expect(config.costPricing).toMatchObject({ ...price, source: 'Existing embedding' });
    expect((await listFirecrawlKeys()).defaultPricing).toMatchObject({ ...fcPrice, source: 'Existing Hobby' });
    expect((await listModelConfigs()).configs.find((m) => m.id === config.id)?.costPricing?.price).toBe('0.02');
    const before = await providerPrices();
    await updateModelConfig(administratorId, config.id, { name: config.name, transport: config.transport, baseUrl: config.baseUrl, model: config.model, costPricing: config.costPricing });
    expect(await providerPrices()).toEqual(before);
  });
  it('atomically saves model and price, preserves omitted prices, and never rewrites another service or past receipts', async () => {
    const id = models[0]!;
    const input = { name: 'Embedding renamed', kind: 'embedding', transport: 'openai_compatible', baseUrl: 'https://embed.example.test/v1', model: 'small' };
    const before = await providerPrices();
    const oldRate = configuredProviderRate(before, modelPricingTarget(input as Parameters<typeof modelPricingTarget>[0]))!;
    const historic = { ...oldRate, id: crypto.randomUUID(), runId: 'old', at: new Date().toISOString(), usage: { inputTokens: 1000 }, costUsd: '0.000020000000', basis: 'configured_rate' as const, rate: oldRate };
    await expect(updateModelConfig(administratorId, id, { ...input, name: 'Must not save', costPricing: { ...price, price: '-1' } })).rejects.toMatchObject({ code: 'cost_pricing' });
    expect((await listModelConfigs()).configs.find((m) => m.id === id)?.name).not.toBe('Must not save');
    await updateModelConfig(administratorId, id, { ...input, costPricing: { ...price, price: '2' } });
    const saved = await providerPrices();
    expect(configuredProviderRate(saved, modelPricingTarget(input as Parameters<typeof modelPricingTarget>[0]))?.usdPerUnit).toBe('0.000002000000');
    expect(configuredProviderRate(saved, { service: 'firecrawl', endpoint: 'https://api.firecrawl.dev', model: 'parse' })).toEqual(configuredProviderRate(before, { service: 'firecrawl', endpoint: 'https://api.firecrawl.dev', model: 'parse' }));
    expect(providerTotal([historic]).credits).toBe(1);
    const stable = await updateModelConfig(administratorId, id, input);
    expect(stable.costPricing?.price).toBe('2');
  });
  it('saves transcription costs in the same editor and preserves concurrent edits to other models', async () => {
    const input = { name: 'Transcription', kind: 'transcription', transport: 'openai_compatible', baseUrl: 'https://audio.example.test/v1', model: 'whisper' };
    const audio = await createModelConfig(administratorId, { ...input, costPricing: { ...price, unit: 'seconds', price: '0.0001' } });
    models.push(audio.id);
    expect(audio.costPricing).toMatchObject({ unit: 'seconds', price: '0.0001' });
    await Promise.all([
      updateModelConfig(administratorId, audio.id, { ...input, costPricing: { ...price, unit: 'seconds', price: '0.0002' } }),
      saveFirecrawlDefaultPricing(administratorId, { pricing: fcPrice }),
    ]);
    expect((await listModelConfigs()).configs.find((m) => m.id === audio.id)?.costPricing?.price).toBe('0.0002');
    expect((await listFirecrawlKeys()).defaultPricing?.price).toBe('0.0038');
  });
  it('keeps Key-specific prices isolated, inherits defaults, retains blank secrets and validates before changing a key', async () => {
    const key = await saveFirecrawlKey(administratorId, null, { name: 'Account', enabled: true, apiKey: 'fc-test-service-price', costPricing: { ...fcPrice, price: '0.001' } });
    keyId = key.id;
    const target = { service: 'firecrawl' as const, endpoint: 'https://api.firecrawl.dev', model: 'parse', account: key.id };
    expect(key.costPricing?.price).toBe('0.001');
    expect(configuredProviderRate(await providerPrices(), target)?.usdPerUnit).toBe('0.001');
    await expect(saveFirecrawlKey(administratorId, key.id, { name: 'Must not save', enabled: false, costPricing: price })).rejects.toMatchObject({ code: 'cost_pricing' });
    const preserved = await saveFirecrawlKey(administratorId, key.id, { name: 'Renamed', enabled: true, apiKey: '' });
    expect(preserved).toMatchObject({ apiKeyTail: key.apiKeyTail, costPricing: { price: '0.001' } });
    const cleared = await saveFirecrawlKey(administratorId, key.id, { name: 'Inherited', enabled: true, costPricing: null });
    expect(cleared.costPricing).toBeNull();
    expect(configuredProviderRate(await providerPrices(), target)?.usdPerUnit).toBe('0.0038');
    await deleteFirecrawlKey(administratorId, key.id); keyId = '';
    expect((await listFirecrawlKeys()).defaultPricing?.price).toBe('0.0038');
    const audits = await db().select().from(schema.adminAudit).where(eq(schema.adminAudit.administratorId, administratorId));
    expect(audits.some((a) => a.action === 'pricing.update')).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('fc-test-service-price');
  });
});

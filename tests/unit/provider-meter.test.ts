import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerRateSchema, type ProviderCharge } from '@/lib/domain/provider-cost';
import { modelCostTarget, prepareProviderCall, withProviderMeter } from '@/lib/infra/ai/provider-meter';

afterEach(() => vi.unstubAllGlobals());
describe('supplier metering scope', () => {
  it('records a real high precision transcription bill and its provider generation ID', async () => {
    const charges: ProviderCharge[] = [];
    const rate = providerRateSchema.parse({ service: 'transcription', endpoint: 'https://ai-gateway.vercel.sh/v1', model: 'openai/whisper-1', unit: 'seconds', usdPerUnit: '0.0001', source: 'Gateway Whisper rate' });
    await withProviderMeter({ runId: 'whisper-precision', prices: { revision: 'v4', rates: [rate] }, record: async (charge) => { charges.push(charge); } }, async () => {
      const call = await prepareProviderCall({ service: 'transcription', endpoint: rate.endpoint, model: rate.model });
      await call!.complete({ usage: { seconds: 4.420000076293945 }, providerMetadata: { gateway: { cost: '0.0004420000076293945', generationId: 'gen_whisper_verification' } } });
    });
    expect(charges[0]).toMatchObject({ basis: 'provider_reported', costUsd: '0.0004420000076293945', generationId: 'gen_whisper_verification' });
  });
  it('keeps endpoint credentials out of persisted billing targets', () => {
    expect(modelCostTarget({ transport: 'openai_compatible', baseUrl: 'https://user:secret@custom.example/v1?api_key=hidden', model: 'embed' }, 'embedding')).toEqual({ service: 'embedding', endpoint: 'https://custom.example/v1', model: 'embed' });
  });
  it('prefers actual Gateway billed cost to the catalog estimate and snapshots calls separately', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'provider/embed', pricing: { input: '0.0000001' } }] }))));
    const charges: ProviderCharge[] = [];
    await withProviderMeter({ runId: 'one', prices: { revision: 'v1', rates: [] }, record: async (charge) => { charges.push(charge); } }, async () => {
      const call = await prepareProviderCall({ service: 'embedding', endpoint: 'https://ai-gateway.vercel.sh/v1', model: 'provider/embed' });
      await call!.complete({ usage: { inputTokens: 1000 }, providerMetadata: { gateway: { cost: '0.00005' } } });
      await call!.complete({ usage: { inputTokens: 1000 } });
    });
    expect(charges.map((charge) => [charge.costUsd, charge.basis])).toEqual([['0.000050000000', 'provider_reported'], ['0.000100000000', 'gateway_catalog']]);
    expect(charges[0]!.runId).toBe('one');
    expect(charges[1]!.rate!.usdPerUnit).toBe('0.0000001');
  });
  it('does not use a price for another endpoint, model or account', async () => {
    const rate = providerRateSchema.parse({ service: 'firecrawl', endpoint: 'https://api.firecrawl.dev', model: 'parse', account: 'key-a', unit: 'firecrawl_credits', usdPerUnit: '0.001', source: 'Invoice' });
    await withProviderMeter({ runId: 'two', prices: { revision: 'v2', rates: [rate] }, record: vi.fn() }, async () => {
      await expect(prepareProviderCall({ service: 'firecrawl', endpoint: rate.endpoint, model: 'parse', account: 'key-b' })).rejects.toThrow('pricing_unavailable');
      await expect(prepareProviderCall({ service: 'embedding', endpoint: rate.endpoint, model: 'other' })).rejects.toThrow('pricing_unavailable');
    });
  });
  it('records an unresolved response before refusing incomplete usage data', async () => {
    const charges: ProviderCharge[] = [];
    const rate = providerRateSchema.parse({ service: 'embedding', endpoint: 'https://custom.example/v1', model: 'embed', unit: 'tokens', usdPerUnit: '0.00000002', source: 'Contract' });
    await withProviderMeter({ runId: 'three', prices: { revision: 'v3', rates: [rate] }, record: async (charge) => { charges.push(charge); } }, async () => {
      const call = await prepareProviderCall({ service: 'embedding', endpoint: rate.endpoint, model: rate.model });
      await expect(call!.complete({ usage: {} })).rejects.toThrow('usage_unavailable');
    });
    expect(charges[0]).toMatchObject({ costUsd: null, basis: 'unresolved', priceRevision: 'v3' });
    expect(await prepareProviderCall({ service: 'embedding', endpoint: rate.endpoint, model: rate.model })).toBeNull();
  });
});

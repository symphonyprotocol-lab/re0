import { describe, expect, it } from 'vitest';
import { parseModelConfig } from '@/lib/domain/models';
import { parseFirecrawlKey } from '@/lib/domain/firecrawl';
import { modelPricingTarget, parseServicePricing, servicePricingOf, servicePricingRate } from '@/lib/domain/service-pricing';

const base = { unit: 'million_tokens' as const, price: '0.02', minimumUnits: 0, incrementUnits: 0, source: 'Contract' };
const target = { service: 'embedding' as const, endpoint: 'https://example.test/v1', model: 'e', account: '*' };
describe('service-bound cost editors', () => {
  it('roundtrips per-million and per-second prices without floating point loss, including verified free', () => {
    const rate = servicePricingRate(target, base, 'default');
    expect(rate.usdPerUnit).toBe('0.000000020000');
    expect(servicePricingOf(rate)).toEqual(base);
    expect(servicePricingOf(servicePricingRate(target, { ...base, price: '0.000001' }, 'default'))?.price).toBe('0.000001');
    expect(servicePricingOf(servicePricingRate(target, { ...base, price: '0' }, 'default'))?.price).toBe('0');
    const seconds = { ...base, unit: 'seconds' as const, price: '0.0001' };
    expect(servicePricingOf(servicePricingRate({ ...target, service: 'transcription' }, seconds, 'default'))).toEqual(seconds);
  });
  it('validates billing units and precision and distinguishes omitted, cleared and zero prices', () => {
    expect(parseServicePricing(undefined, 'embedding')).toBeUndefined();
    expect(parseServicePricing(null, 'embedding')).toBeNull();
    expect(parseServicePricing({ ...base, price: '0' }, 'embedding')?.price).toBe('0');
    for (const bad of [{ ...base, price: '-1' }, { ...base, price: '0.0000001' }, { ...base, unit: 'seconds' }, { ...base, outputPrice: '1' }, { ...base, minimumUnits: -1 }]) expect(() => parseServicePricing(bad, 'embedding')).toThrow('cost_pricing');
    expect(() => parseServicePricing(base, 'firecrawl')).toThrow('cost_pricing');
    expect(() => parseServicePricing({ ...base, unit: 'seconds', price: '0.0000000000001' }, 'transcription')).toThrow('cost_pricing');
  });
  it('binds model scope on the server, supports both token modalities for audio, and validates prices with the service config', () => {
    const model = { name: 'embed', kind: 'embedding', transport: 'openai_compatible', baseUrl: 'https://user:pass@example.test/v1?key=secret', model: 'e' };
    expect(parseModelConfig({ ...model, costPricing: base })).toMatchObject({ costPricing: base });
    expect(parseModelConfig({ ...model, costPricing: { ...base, price: '-1' } })).toEqual({ error: 'cost_pricing' });
    expect(modelPricingTarget(model as Parameters<typeof modelPricingTarget>[0])).toEqual(target);
    expect(parseServicePricing({ ...base, outputPrice: '1', audioPrice: '2' }, 'transcription')).toMatchObject({ outputPrice: '1', audioPrice: '2' });
    expect(parseFirecrawlKey({ name: 'key', enabled: true, costPricing: base })).toEqual({ error: 'cost_pricing' });
  });
});

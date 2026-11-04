import { describe, expect, it } from 'vitest';
import { providerRateSchema, providerRatesSchema, providerTotal, rateCost, reportedGatewayCost, type ProviderCharge } from '@/lib/domain/provider-cost';

const rate = (override: Record<string, unknown> = {}) => providerRateSchema.parse({ service: 'embedding', endpoint: 'https://models.example/v1', model: 'embed-a', unit: 'tokens', usdPerUnit: '0.00000002', source: 'Provider contract', ...override });
const charge = (costUsd: string | null): ProviderCharge => ({ service: 'embedding', endpoint: 'https://models.example/v1', model: 'embed-a', id: crypto.randomUUID(), runId: 'run', at: new Date().toISOString(), usage: {}, costUsd, basis: 'configured_rate' });

describe('third-party cost billing', () => {
  it('follows the actual model unit price and usage rather than source characters', () => {
    expect(rateCost(rate(), { inputTokens: 200_000 })).toBe('0.004000000000');
    expect(rateCost(rate({ usdPerUnit: '0.00000013' }), { inputTokens: 200_000 })).toBe('0.026000000000');
    expect(providerTotal([charge('0.004')]).credits).toBe(40);
    expect(providerTotal([charge('0.026')]).credits).toBe(260);
  });
  it('sums every supplier response and rounds to credits once', () => {
    expect(providerTotal([charge('0.00004'), charge('0.00004')])).toEqual({ costUsd: '0.000080000000', credits: 1 });
    expect(providerTotal([charge('0.03'), charge('0.00002')])).toEqual({ costUsd: '0.030020000000', credits: 301 });
    expect(providerTotal([charge('0')])).toEqual({ costUsd: '0.000000000000', credits: 0 });
    expect(providerTotal([charge('0.000100000001')]).credits).toBe(2);
  });
  it('uses Firecrawl reported credits with the account contract price', () => {
    expect(rateCost(rate({ service: 'firecrawl', model: 'parse', unit: 'firecrawl_credits', usdPerUnit: '0.001' }), { firecrawlCredits: 30 })).toBe('0.030000000000');
    // User's Hobby plan: $19 / 5000 credits. The two models use the supplied Gateway prices.
    expect(providerTotal([charge(rateCost(rate({ service: 'firecrawl', model: 'parse', unit: 'firecrawl_credits', usdPerUnit: '0.0038' }), { firecrawlCredits: 30 }))]).credits).toBe(1140);
    expect(providerTotal([charge(rateCost(rate(), { inputTokens: 1_000_000 }))]).credits).toBe(200);
    expect(providerTotal([charge(rateCost(rate({ service: 'transcription', unit: 'seconds', usdPerUnit: '0.0001' }), { seconds: 3600 }))]).credits).toBe(3600);
  });
  it('respects duration billing increments and separate transcription token prices', () => {
    expect(rateCost(rate({ service: 'transcription', unit: 'seconds', usdPerUnit: '0.0001', incrementUnits: 1 }), { seconds: 61.2 })).toBe('0.006200000000');
    expect(rateCost(rate({ service: 'transcription', unit: 'seconds', usdPerUnit: '0.01', incrementUnits: 0.01 }), { seconds: 0.14 })).toBe('0.001400000000');
    expect(rateCost(rate({ service: 'transcription', usdPerUnit: '0.0000025', audioInputUsdPerUnit: '0.000005', outputUsdPerUnit: '0.00001' }), { inputTokens: 100, audioInputTokens: 80, outputTokens: 10 })).toBe('0.000550000000');
  });
  it('refuses missing usage and unresolved costs rather than assuming free or estimating characters', () => {
    expect(() => rateCost(rate(), {})).toThrow('usage_unavailable');
    expect(() => rateCost(rate(), { inputTokens: NaN })).toThrow('usage_unavailable');
    expect(() => providerTotal([charge(null)])).toThrow('usage_unavailable');
    expect(rateCost(rate({ usdPerUnit: '0' }), { inputTokens: 200_000 })).toBe('0.000000000000');
  });
  it('preserves reported zero costs and rejects invalid rates and duplicate identities', () => {
    expect(reportedGatewayCost({ gateway: { cost: 0 } })).toBe('0.000000000000');
    expect(reportedGatewayCost({ gateway: { cost: '0.0023' } })).toBe('0.002300000000');
    expect(reportedGatewayCost({})).toBeNull();
    expect(providerRatesSchema.safeParse([rate(), rate()]).success).toBe(false);
    expect(() => rate({ endpoint: 'https://key:secret@models.example/v1' })).toThrow();
    expect(() => rate({ service: 'firecrawl' })).toThrow();
    expect(() => rate({ usdPerUnit: '-1' })).toThrow();
  });
  it('retains real Whisper billing precision and scientific notation until the final credit rounding', () => {
    const actual = '0.0004420000076293945';
    expect(reportedGatewayCost({ gateway: { cost: actual } })).toBe(actual);
    expect(providerTotal([charge(actual)])).toEqual({ costUsd: actual, credits: 5 });
    expect(reportedGatewayCost({ gateway: { cost: '4.420000076293945e-4' } })).toBe(actual);
    expect(providerTotal([charge('0.0000999999999999999'), charge('0.0000000000000000001')])).toEqual({ costUsd: '0.000100000000', credits: 1 });
    expect(rateCost(rate({ service: 'transcription', unit: 'seconds', usdPerUnit: '0.000000000001' }), { seconds: 0.000001 })).toBe('0.000000000000000001');
  });
});

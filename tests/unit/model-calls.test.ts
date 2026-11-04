import { describe, expect, it } from 'vitest';
import { generationCost, modelCallsView } from '@/lib/domain/model-calls';
import { providerRateSchema } from '@/lib/domain/provider-cost';

const rate = providerRateSchema.parse({ service: 'generation', endpoint: 'https://provider.test/v1', model: 'gen', unit: 'tokens', usdPerUnit: '0.000001', outputUsdPerUnit: '0.000002', source: 'contract' });
describe('generation reporting rules', () => {
  it('preserves missing usage, missing output rates and malformed invoices as unknown', () => {
    expect(generationCost({ gateway: false, rate, usage: { inputTokens: 100 } }).costUsd).toBeNull();
    expect(generationCost({ gateway: false, rate: { ...rate, outputUsdPerUnit: undefined }, usage: { inputTokens: 100, outputTokens: 50 } }).costUsd).toBeNull();
    expect(generationCost({ gateway: true, rate, metadata: { gateway: { cost: '-1' } }, usage: { inputTokens: 100, outputTokens: 50 } }).costUsd).toBeNull();
    expect(generationCost({ gateway: false, rate: { ...rate, usdPerUnit: '0', outputUsdPerUnit: '0' }, usage: { inputTokens: 100, outputTokens: 50 } })).toEqual({ costUsd: '0.000000000000', costBasis: 'configured_rate' });
  });
  it('normalizes unsupported filters and accepts the UTC+8 reporting calendar', () => {
    expect(modelCallsView(new URLSearchParams('status=invalid&audience=paid&purpose=invalid&page=-1&size=2'))).toMatchObject({ status: 'all', audience: 'all', purpose: 'all', page: 1, size: 20 });
    expect(modelCallsView(new URLSearchParams('status=failed&audience=plan&purpose=answer&period=custom&start=2026-11-01&end=2026-11-03'))).toMatchObject({ status: 'failed', audience: 'plan', purpose: 'answer', period: 'custom', start: '2026-11-01', end: '2026-11-03' });
  });
});

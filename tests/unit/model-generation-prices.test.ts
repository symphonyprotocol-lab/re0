import { describe, expect, it } from 'vitest';
import { parseModelConfig, perMillionUsd, perTokenUsd } from '@/lib/domain/models';
const model = { name: 'Custom', kind: 'generation', transport: 'openai_compatible', baseUrl: 'https://provider.test/v1', model: 'custom' };
describe('manual generation model prices', () => {
  it('converts prices per million tokens to exact supplier per-token rates', () => {
    for (const value of ['0', '0.15', '0.5', '1.234567', '99999999.999999']) expect(perMillionUsd(perTokenUsd(value))).toBe(value);
    expect(perTokenUsd('0.15')).toBe('0.000000150000');
    expect(perTokenUsd('0.000001')).toBe('0.000000000001');
  });
  it('preserves omitted prices and supports explicit clearing or verified free prices', () => {
    expect(parseModelConfig(model)).not.toHaveProperty('generationPricing');
    expect(parseModelConfig({ ...model, generationPricing: null })).toMatchObject({ generationPricing: null });
    expect(parseModelConfig({ ...model, generationPricing: { inputUsdPerMillion: '', outputUsdPerMillion: '' } })).toMatchObject({ generationPricing: null });
    expect(parseModelConfig({ ...model, generationPricing: { inputUsdPerMillion: '0', outputUsdPerMillion: '0' } })).toMatchObject({ generationPricing: { inputUsdPerMillion: '0', outputUsdPerMillion: '0' } });
  });
  it('rejects partial, negative, numeric and overly precise prices', () => {
    for (const prices of [ {}, { inputUsdPerMillion: '1', outputUsdPerMillion: '' }, { inputUsdPerMillion: '-1', outputUsdPerMillion: '0' }, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, { inputUsdPerMillion: '0.0000001', outputUsdPerMillion: '1' } ]) expect(parseModelConfig({ ...model, generationPricing: prices })).toEqual({ error: 'generation_pricing' });
  });
  it('does not accept manual overrides for Gateway models', () => {
    expect(parseModelConfig({ ...model, transport: 'gateway', model: 'provider/model', generationPricing: { inputUsdPerMillion: '999', outputUsdPerMillion: '999' } })).not.toHaveProperty('generationPricing');
  });
});

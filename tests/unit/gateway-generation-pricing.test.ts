import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const catalog = (input = '0.00000015') => new Response(JSON.stringify({ data: [{ id: 'zai/glm-5.3-flash', pricing: { input, output: '0.0000005', varies_by_provider: true } }] }));

describe('Gateway generation model prices', () => {
  it('reads input and output quotes from Gateway and deduplicates concurrent catalog reads', async () => {
    const fetch = vi.fn().mockResolvedValue(catalog()); vi.stubGlobal('fetch', fetch);
    const { gatewayGenerationPricing } = await import('@/lib/infra/ai/gateway-generation-pricing');
    const prices = await Promise.all([gatewayGenerationPricing('zai/glm-5.3-flash'), gatewayGenerationPricing('zai/glm-5.3-flash')]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://ai-gateway.vercel.sh/v1/models');
    expect(prices[0]).toMatchObject({ estimated: true, rate: { usdPerUnit: '0.00000015', outputUsdPerUnit: '0.0000005', source: 'https://ai-gateway.vercel.sh/v1/models' } });
    expect(prices[1]).toEqual(prices[0]);
    await gatewayGenerationPricing('zai/glm-5.3-flash');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('refreshes quotes after the short cache expires', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
    const fetch = vi.fn().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(catalog('0.0000003')); vi.stubGlobal('fetch', fetch);
    const { gatewayGenerationPricing } = await import('@/lib/infra/ai/gateway-generation-pricing');
    const first = await gatewayGenerationPricing('zai/glm-5.3-flash');
    vi.setSystemTime(new Date('2026-11-03T00:01:01Z'));
    expect((await gatewayGenerationPricing('zai/glm-5.3-flash'))?.rate.usdPerUnit).toBe('0.0000003');
    expect(first?.rate.usdPerUnit).toBe('0.00000015');
  });
  it('backs off after a failed catalog read instead of paying the timeout on every call', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
    const fetch = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(catalog()); vi.stubGlobal('fetch', fetch);
    const { gatewayGenerationPricing } = await import('@/lib/infra/ai/gateway-generation-pricing');
    expect(await gatewayGenerationPricing('zai/glm-5.3-flash')).toBeUndefined();
    expect(await gatewayGenerationPricing('zai/glm-5.3-flash')).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-11-03T00:00:31Z'));
    expect(await gatewayGenerationPricing('zai/glm-5.3-flash')).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('keeps serving the last catalog while a refresh is failing', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(catalog()).mockResolvedValueOnce(new Response('', { status: 503 })));
    const { gatewayGenerationPricing } = await import('@/lib/infra/ai/gateway-generation-pricing');
    await gatewayGenerationPricing('zai/glm-5.3-flash');
    vi.setSystemTime(new Date('2026-11-03T00:01:01Z'));
    expect((await gatewayGenerationPricing('zai/glm-5.3-flash'))?.rate.usdPerUnit).toBe('0.00000015');
  });
  it('does not invent prices when Gateway fails or omits a model', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(catalog()));
    const { gatewayGenerationPricing } = await import('@/lib/infra/ai/gateway-generation-pricing');
    expect(await gatewayGenerationPricing('openai/gpt-5-mini')).toBeUndefined();
    expect(await gatewayGenerationPricing('unknown/model')).toBeUndefined();
  });
});

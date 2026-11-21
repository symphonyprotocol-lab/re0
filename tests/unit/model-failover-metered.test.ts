/**
 * Review B1: inside a metered run, the reserve before each attempt can
 * refuse the request itself (the asker's credits) or this entry (no price
 * on file). Neither is a model failure: the first is thrown at once, the
 * second moves on to the next entry, and no model's health changes.
 */
import { generateText } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InsufficientCredits } from '@/lib/domain/credits';
import { ProviderCostUnavailable } from '@/lib/domain/provider-cost';
import { failoverLanguageModel, type LanguageModelV4, type Link } from '@/lib/infra/ai/failover';
import { forgetHealthCache, healthOf } from '@/lib/infra/ai/model-health';
import { loggedLanguageModel } from '@/lib/infra/ai/usage';
import { prepareProviderCall } from '@/lib/infra/ai/provider-meter';
import type { ModelEndpoint } from '@/lib/infra/ai/models';

vi.mock('@/lib/infra/db', () => ({ schema: { modelCall: {} }, db: () => ({ insert: () => ({ values: async () => undefined }) }) }));
vi.mock('@/lib/services/provider-pricing', async (original) => ({ ...await original<object>(), providerPrices: vi.fn().mockResolvedValue({ revision: 'v1', rates: [] }) }));
vi.mock('@/lib/infra/ai/gateway-generation-pricing', () => ({ gatewayGenerationPricing: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/infra/ai/provider-meter', async (original) => ({ ...await original<object>(), prepareProviderCall: vi.fn() }));

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const provider = (answer: string): LanguageModelV4 => ({
  specificationVersion: 'v4', provider: 'test', modelId: answer, supportedUrls: {},
  doGenerate: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: answer }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
  doStream: vi.fn(),
} as LanguageModelV4);
const endpoint = (id: string, position: number): ModelEndpoint => ({
  kind: 'generation', configId: id, name: id, transport: 'openai_compatible', baseUrl: `https://${id}.test/v1`, model: `${id}-model`, apiKey: 'k', timeoutMs: 5_000, source: 'console', position,
});
function chain(...ids: string[]) {
  const providers = ids.map((id) => provider(`answer from ${id}`));
  const links: Link<LanguageModelV4>[] = ids.map((id, index) => {
    const at = endpoint(id, index);
    return { endpoint: at, position: index, model: loggedLanguageModel(providers[index]!, { model: at.model, configId: id, transport: at.transport, baseUrl: at.baseUrl }) };
  });
  return { model: failoverLanguageModel(links), providers };
}

beforeEach(() => {
  delete process.env.DATABASE_URL;
  forgetHealthCache();
  vi.mocked(prepareProviderCall).mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('failover inside a metered run', () => {
  it('throws the asker’s insufficient credits at once: no switch, no cooldown', async () => {
    vi.mocked(prepareProviderCall).mockRejectedValue(new InsufficientCredits(10, 2));
    const { model, providers } = chain('a', 'b');
    for (let round = 0; round < 3; round += 1) {
      await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toBeInstanceOf(InsufficientCredits);
    }
    expect(prepareProviderCall).toHaveBeenCalledTimes(3);
    expect(providers.every((p) => vi.mocked(p.doGenerate).mock.calls.length === 0)).toBe(true);
    expect(await healthOf('a')).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
    expect(await healthOf('b')).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });

  it('skips an entry without a price to the next one, and cools neither', async () => {
    vi.mocked(prepareProviderCall).mockImplementation(async (target) => {
      if (target.endpoint.includes('a.test')) throw new ProviderCostUnavailable('pricing_unavailable');
      return null;
    });
    const { model, providers } = chain('a', 'b');
    const result = await generateText({ model, prompt: 'hi', maxRetries: 0 });
    expect(result.text).toBe('answer from b');
    expect(providers[0]!.doGenerate).not.toHaveBeenCalled();
    expect(await healthOf('a')).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });

  it('throws the last refusal when no entry has a price', async () => {
    vi.mocked(prepareProviderCall).mockRejectedValue(new ProviderCostUnavailable('pricing_unavailable'));
    await expect(generateText({ model: chain('a', 'b').model, prompt: 'hi', maxRetries: 0 })).rejects.toBeInstanceOf(ProviderCostUnavailable);
  });

  it('never treats our own errors as the model’s', async () => {
    vi.mocked(prepareProviderCall).mockRejectedValue(new Error('stale processing run'));
    const { model, providers } = chain('a', 'b');
    await expect(generateText({ model, prompt: 'hi', maxRetries: 0 })).rejects.toThrow('stale processing run');
    expect(prepareProviderCall).toHaveBeenCalledTimes(1);
    expect(providers[1]!.doGenerate).not.toHaveBeenCalled();
    expect(await healthOf('a')).toMatchObject({ state: 'ok', consecutiveFailures: 0 });
  });
});

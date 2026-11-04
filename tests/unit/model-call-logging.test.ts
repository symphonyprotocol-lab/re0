import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggedLanguageModel, type ModelCallRecord } from '@/lib/infra/ai/usage';
import { providerRateSchema } from '@/lib/domain/provider-cost';
import { providerPrices } from '@/lib/services/provider-pricing';
import { gatewayGenerationPricing } from '@/lib/infra/ai/gateway-generation-pricing';

const state = vi.hoisted(() => ({ records: [] as ModelCallRecord[], fail: false }));
vi.mock('@/lib/infra/db', () => ({ schema: { modelCall: {} }, db: () => ({ insert: () => ({ values: async (row: ModelCallRecord) => { if (state.fail) throw new Error('log unavailable'); state.records.push(row); } }) }) }));
vi.mock('@/lib/services/provider-pricing', async (original) => ({ ...await original<object>(), providerPrices: vi.fn() }));
vi.mock('@/lib/infra/ai/gateway-generation-pricing', () => ({ gatewayGenerationPricing: vi.fn() }));

type Model = Parameters<typeof loggedLanguageModel>[0];
type Part = Awaited<ReturnType<Model['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never;
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } };
const finish = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage } as const;
const rate = providerRateSchema.parse({ service: 'generation', endpoint: 'https://provider.test/v1', model: 'test-model', unit: 'tokens', usdPerUnit: '0.000002', outputUsdPerUnit: '0.000004', source: 'Contract v1' });
const call = { model: 'test-model', configId: 'config', configName: 'Live config', transport: 'openai_compatible', baseUrl: 'https://user:secret@provider.test/v1?key=hidden', userId: 'user', audience: 'plan' as const, purpose: 'answer' as const };
const fake = (parts: Part[] = [finish]): Model => ({ specificationVersion: 'v4', provider: 'test', modelId: 'test-model', supportedUrls: {},
  doGenerate: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'answer' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }),
  doStream: vi.fn().mockResolvedValue({ stream: new ReadableStream<Part>({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } }) }),
});
const drain = async (stream: ReadableStream<Part>) => { const reader = stream.getReader(); while (!(await reader.read()).done) { /* consume */ } };

beforeEach(() => {
  state.records = []; state.fail = false;
  process.env.DATABASE_URL = 'postgres://unused';
  vi.mocked(providerPrices).mockResolvedValue({ revision: 'v1', rates: [rate] });
  vi.mocked(gatewayGenerationPricing).mockResolvedValue(undefined);
  vi.clearAllMocks();
});

describe('generation call logging', () => {
  it('awaits one durable record with user context, sanitized endpoint and exact cost', async () => {
    await loggedLanguageModel(fake(), call).doGenerate({ prompt: [] });
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({ userId: 'user', audience: 'plan', purpose: 'answer', status: 'succeeded', inputTokens: 100, outputTokens: 50, usageKnown: true, endpoint: 'https://provider.test/v1', costUsd: '0.000400000000', costBasis: 'configured_rate', priceRevision: 'v1', rate });
    expect(JSON.stringify(state.records)).not.toMatch(/secret|hidden/);
  });
  it('records streamed completion once with the response request ID', async () => {
    const stream = await loggedLanguageModel(fake([{ type: 'response-metadata', id: 'request-1' }, finish]), call).doStream({ prompt: [] });
    await drain(stream.stream);
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({ status: 'succeeded', requestId: 'request-1', costUsd: '0.000400000000' });
  });
  it('records thrown errors and leaves unknown costs unknown, without storing provider messages', async () => {
    const source = fake();
    const error = new Error('provider secret key and prompt');
    vi.mocked(source.doGenerate).mockRejectedValue(error);
    await expect(loggedLanguageModel(source, call).doGenerate({ prompt: [] })).rejects.toBe(error);
    expect(state.records[0]).toMatchObject({ status: 'failed', costUsd: null, errorCode: 'provider_error', usageKnown: false });
    expect(JSON.stringify(state.records)).not.toContain('provider secret');
  });
  it('counts a failed provider attempt and its successful retry separately', async () => {
    const source = fake();
    vi.mocked(source.doGenerate).mockRejectedValueOnce(new Error('retry me'));
    const model = loggedLanguageModel(source, call);
    await expect(model.doGenerate({ prompt: [] })).rejects.toThrow('retry me');
    await model.doGenerate({ prompt: [] });
    expect(state.records.map((r) => r.status)).toEqual(['failed', 'succeeded']);
  });
  it('records errors emitted inside the stream and interruptions without double counting', async () => {
    await drain((await loggedLanguageModel(fake([{ type: 'error', error: new Error('failed') }, finish]), call).doStream({ prompt: [] })).stream);
    expect(state.records).toHaveLength(1);
    expect(state.records[0]?.status).toBe('failed');
    await drain((await loggedLanguageModel(fake([]), call).doStream({ prompt: [] })).stream);
    expect(state.records).toHaveLength(2);
    expect(state.records[1]).toMatchObject({ status: 'aborted', errorCode: 'incomplete_stream', costUsd: null });
  });
  it('propagates cancellation to the provider and records one interrupted attempt', async () => {
    const cancel = vi.fn();
    const source = fake();
    vi.mocked(source.doStream).mockResolvedValue({ stream: new ReadableStream<Part>({ start(c) { c.enqueue({ type: 'text-start', id: 'text' }); }, cancel }) });
    const reader = (await loggedLanguageModel(source, call).doStream({ prompt: [] })).stream.getReader();
    await reader.read(); await reader.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(state.records).toHaveLength(1);
    expect(state.records[0]?.status).toBe('aborted');
  });
  it('uses the provider-reported Gateway bill instead of the configured calculation', async () => {
    const source = fake();
    vi.mocked(source.doGenerate).mockResolvedValue({ content: [], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [], providerMetadata: { gateway: { cost: '0.0000000000012345' } } });
    await loggedLanguageModel(source, { ...call, transport: 'gateway' }).doGenerate({ prompt: [] });
    expect(state.records[0]).toMatchObject({ costUsd: '0.0000000000012345', costBasis: 'provider_reported' });
  });
  it('uses Gateway catalog prices and never a manual override for a Gateway model', async () => {
    const gatewayRate = { ...rate, endpoint: 'https://ai-gateway.vercel.sh/v1', source: 'https://ai-gateway.vercel.sh/v1/models' };
    vi.mocked(gatewayGenerationPricing).mockResolvedValue({ rate: gatewayRate, priceRevision: 'gateway-catalog:1', estimated: true });
    vi.mocked(providerPrices).mockResolvedValue({ revision: 'manual', rates: [{ ...gatewayRate, usdPerUnit: '100' }] });
    await loggedLanguageModel(fake(), { ...call, transport: 'gateway' }).doGenerate({ prompt: [] });
    expect(providerPrices).not.toHaveBeenCalled();
    expect(state.records[0]).toMatchObject({ costUsd: '0.000400000000', costBasis: 'estimated', priceRevision: 'gateway-catalog:1', rate: gatewayRate });
  });
  it('keeps historical price snapshots and tolerates failed log writes', async () => {
    const model = loggedLanguageModel(fake(), call);
    await model.doGenerate({ prompt: [] });
    vi.mocked(providerPrices).mockResolvedValue({ revision: 'v2', rates: [{ ...rate, outputUsdPerUnit: '0.000008' }] });
    await model.doGenerate({ prompt: [] });
    expect(state.records.map((r) => [r.priceRevision, r.costUsd])).toEqual([['v1', '0.000400000000'], ['v2', '0.000600000000']]);
    state.fail = true;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(model.doGenerate({ prompt: [] })).resolves.toBeDefined();
    warning.mockRestore();
  });
});

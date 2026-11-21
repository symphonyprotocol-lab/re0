/** The failover model over a list (lib/infra/ai/failover.ts), on fake providers and this instance's health alone (no database). */
import { APICallError, generateText, streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { failoverEmbeddingModel, failoverLanguageModel, type EmbeddingModelV4, type LanguageModelV4, type Link } from '@/lib/infra/ai/failover';
import { forgetHealthCache, healthOf } from '@/lib/infra/ai/model-health';
import type { ModelEndpoint } from '@/lib/infra/ai/models';
import { COOLING } from '@/lib/domain/model-failover';

type Part = Awaited<ReturnType<LanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer T> ? T : never;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage } as const;
const text = (value: string): Part[] => [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: value }, { type: 'text-end', id: 't' }, finish];

const endpoint = (id: string, model: string, position: number): ModelEndpoint => ({
  kind: 'generation', configId: id, name: `entry ${id}`, transport: 'openai_compatible', baseUrl: 'https://provider.test/v1',
  model, apiKey: 'k', timeoutMs: 5_000, source: 'console', position,
});
const api = (statusCode: number, body = '', headers: Record<string, string> = {}) =>
  new APICallError({ message: `HTTP ${statusCode}`, url: 'https://provider.test/v1', requestBodyValues: {}, statusCode, responseBody: body, responseHeaders: headers, isRetryable: false });

function fake(answer: string, failWith?: unknown): LanguageModelV4 {
  return {
    specificationVersion: 'v4', provider: 'test', modelId: answer, supportedUrls: {},
    doGenerate: vi.fn(async () => {
      if (failWith) throw failWith;
      return { content: [{ type: 'text', text: answer }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    }),
    doStream: vi.fn(async () => {
      if (failWith) throw failWith;
      return { stream: new ReadableStream<Part>({ start(c) { text(answer).forEach((p) => c.enqueue(p)); c.close(); } }) };
    }),
  } as LanguageModelV4;
}

const links = (...models: LanguageModelV4[]): Link<LanguageModelV4>[] =>
  models.map((model, index) => ({ endpoint: endpoint(`cfg-${index}`, `model-${index}`, index), position: index, model }));

let databaseUrl: string | undefined;
beforeEach(() => {
  databaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  forgetHealthCache();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  if (databaseUrl !== undefined) process.env.DATABASE_URL = databaseUrl;
  vi.restoreAllMocks();
});

describe('failoverLanguageModel', () => {
  it('moves to the backup on a 429 and names the model that answered', async () => {
    const primary = fake('primary', api(429, 'slow down', { 'retry-after': '20' }));
    const backup = fake('backup');
    const result = await generateText({ model: failoverLanguageModel(links(primary, backup)), prompt: 'hi', maxRetries: 0 });
    expect(result.text).toBe('backup');
    expect(result.response.modelId).toBe('model-1');
    const health = await healthOf('cfg-0');
    expect(health.state).toBe('cooling');
    expect(health.reason).toBe('rate_limit');
  });

  it('cools an out-of-quota primary for an hour, and the next request starts at the backup', async () => {
    const primary = fake('primary', api(429, '{"error":{"code":"insufficient_quota"}}'));
    const backup = fake('backup');
    const model = failoverLanguageModel(links(primary, backup));
    const before = Date.now();
    await generateText({ model, prompt: 'one', maxRetries: 0 });
    const health = await healthOf('cfg-0');
    expect(health.reason).toBe('quota');
    expect(health.coolingUntil!.getTime() - before).toBeGreaterThanOrEqual(COOLING.quota.base - 1000);
    await generateText({ model, prompt: 'two', maxRetries: 0 });
    expect(primary.doGenerate).toHaveBeenCalledTimes(1);
    expect(backup.doGenerate).toHaveBeenCalledTimes(2);
  });

  it('does not switch on a bad request', async () => {
    const primary = fake('primary', api(400, '{"error":{"code":"context_length_exceeded"}}'));
    const backup = fake('backup');
    await expect(generateText({ model: failoverLanguageModel(links(primary, backup)), prompt: 'hi', maxRetries: 0 })).rejects.toThrow();
    expect(backup.doGenerate).not.toHaveBeenCalled();
    expect((await healthOf('cfg-0')).state).toBe('ok');
  });

  it('throws the last error when every entry fails', async () => {
    const error = api(503);
    const model = failoverLanguageModel(links(fake('a', api(500)), fake('b', error)));
    await expect(model.doGenerate({ prompt: [] })).rejects.toBe(error);
  });

  it('with every entry cooling, still tries them', async () => {
    const primary = fake('primary', api(401));
    const backup = fake('backup', api(401));
    const model = failoverLanguageModel(links(primary, backup));
    await expect(model.doGenerate({ prompt: [] })).rejects.toThrow();
    expect((await healthOf('cfg-1')).reason).toBe('auth');
    await expect(model.doGenerate({ prompt: [] })).rejects.toThrow();
    expect(primary.doGenerate).toHaveBeenCalledTimes(2);
    expect(backup.doGenerate).toHaveBeenCalledTimes(2);
  });

  it('times out a slow attempt with the entry’s own timeout and moves on', async () => {
    vi.useFakeTimers();
    try {
      const slow = fake('slow');
      vi.mocked(slow.doGenerate).mockImplementation((options) => new Promise((_, reject) => {
        options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal!.reason));
      }));
      const pending = failoverLanguageModel(links(slow, fake('fast'))).doGenerate({ prompt: [] });
      await vi.advanceTimersByTimeAsync(5_001);
      const result = await pending;
      expect(result.content).toEqual([{ type: 'text', text: 'fast' }]);
      expect((await healthOf('cfg-0')).lastErrorCode).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never moves on when the caller aborts', async () => {
    const controller = new AbortController();
    const primary = fake('primary');
    vi.mocked(primary.doGenerate).mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const backup = fake('backup');
    await expect(failoverLanguageModel(links(primary, backup)).doGenerate({ prompt: [], abortSignal: controller.signal })).rejects.toThrow('aborted');
    expect(backup.doGenerate).not.toHaveBeenCalled();
  });
});

describe('failoverLanguageModel streams', () => {
  it('switches when the stream fails before its first content', async () => {
    const primary = fake('primary');
    vi.mocked(primary.doStream).mockResolvedValue({
      stream: new ReadableStream<Part>({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'error', error: api(429) }); c.close(); } }),
    });
    const result = streamText({ model: failoverLanguageModel(links(primary, fake('backup'))), prompt: 'hi', maxRetries: 0 });
    expect(await result.text).toBe('backup');
    expect((await result.response).modelId).toBe('model-1');
  });

  it('switches on an error after an empty text part', async () => {
    const primary = fake('primary');
    vi.mocked(primary.doStream).mockResolvedValue({
      stream: new ReadableStream<Part>({ start(c) { c.enqueue({ type: 'stream-start', warnings: [] }); c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'error', error: api(503) }); c.close(); } }),
    });
    const result = streamText({ model: failoverLanguageModel(links(primary, fake('backup'))), prompt: 'hi', maxRetries: 0 });
    expect(await result.text).toBe('backup');
  });

  it('names the configured model with a single entry too', async () => {
    const result = await generateText({ model: failoverLanguageModel(links(fake('only'))), prompt: 'hi', maxRetries: 0 });
    expect(result.response.modelId).toBe('model-0');
  });

  it('switches when opening the stream throws', async () => {
    const result = streamText({ model: failoverLanguageModel(links(fake('primary', api(402)), fake('backup'))), prompt: 'hi', maxRetries: 0 });
    expect(await result.text).toBe('backup');
  });

  it('never switches once content has been sent', async () => {
    const primary = fake('primary');
    vi.mocked(primary.doStream).mockResolvedValue({
      stream: new ReadableStream<Part>({ start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] });
        c.enqueue({ type: 'text-start', id: 't' });
        c.enqueue({ type: 'text-delta', id: 't', delta: 'half an ans' });
        c.enqueue({ type: 'error', error: api(500) });
        c.close();
      } }),
    });
    const backup = fake('backup');
    const parts: string[] = [];
    const result = streamText({ model: failoverLanguageModel(links(primary, backup)), prompt: 'hi', maxRetries: 0 });
    for await (const part of result.stream) parts.push(part.type === 'text-delta' ? part.text : part.type);
    expect(parts).toContain('half an ans');
    expect(parts).toContain('error');
    expect(parts).not.toContain('backup');
    expect(backup.doStream).not.toHaveBeenCalled();
  });
});

describe('failoverEmbeddingModel', () => {
  const embedder = (vector: number[], failWith?: unknown, max?: number): EmbeddingModelV4 => ({
    specificationVersion: 'v4', provider: 'test', modelId: 'e', maxEmbeddingsPerCall: max, supportsParallelCalls: true,
    doEmbed: vi.fn(async ({ values }) => {
      if (failWith) throw failWith;
      return { embeddings: values.map(() => vector), usage: { tokens: values.length }, warnings: [] };
    }),
  });

  it('moves a batch to the same-model backup and reports which entry took it', async () => {
    const served: string[] = [];
    const list: Link<EmbeddingModelV4>[] = [
      { endpoint: { ...endpoint('e-0', 'openai/text-embedding-3-small', 0), kind: 'embedding' }, position: 0, model: embedder([1, 0], api(429, 'insufficient_quota'), 2048) },
      { endpoint: { ...endpoint('e-1', 'text-embedding-3-small', 1), kind: 'embedding' }, position: 1, model: embedder([1, 0], undefined, 100) },
    ];
    const model = failoverEmbeddingModel(list, (link) => served.push(link.endpoint.configId!));
    expect(await model.maxEmbeddingsPerCall).toBe(100);
    const result = await model.doEmbed({ values: ['a', 'b'] });
    expect(result.embeddings).toHaveLength(2);
    expect(served).toEqual(['e-1']);
    expect((await healthOf('e-0')).reason).toBe('quota');
  });
});

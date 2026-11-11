import { MockEmbeddingModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { EMBEDDING_BATCH_TOKEN_BUDGET } from '@/lib/constants';
import {
  EmbeddingInputTooLarge,
  embedInBatches,
  embeddingTokenBound,
  inputTokenBound,
  planEmbeddingBatches,
} from '@/lib/infra/ai/embedding-batches';

type EmbedResult = Awaited<ReturnType<MockEmbeddingModelV4['doEmbed']>>;

/** A fake model whose vector for `text-<n>` is `[n]`, answering after a random delay so batches finish out of order. */
function fakeModel(options: { maxEmbeddingsPerCall?: number; fail?: (values: string[]) => boolean } = {}) {
  let inFlight = 0;
  let peak = 0;
  const model = new MockEmbeddingModelV4({
    maxEmbeddingsPerCall: options.maxEmbeddingsPerCall ?? 2048,
    supportsParallelCalls: true,
    doEmbed: async ({ values, abortSignal }): Promise<EmbedResult> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        abortSignal?.throwIfAborted();
        if (options.fail?.(values)) throw new Error('provider refused');
        return {
          embeddings: values.map((value) => [Number(value.split('-')[1])]),
          usage: { tokens: values.length * 10 },
          warnings: [],
        };
      } finally {
        inFlight -= 1;
      }
    },
  });
  return { model, peak: () => peak };
}

const texts = (count: number, size: number) =>
  Array.from({ length: count }, (_, index) => `text-${index}-${'x'.repeat(size)}`);

describe('planEmbeddingBatches', () => {
  it('covers every input once, in order, within the token and count limits', () => {
    const input = Array.from({ length: 500 }, (_, index) => `text-${index}-${'y'.repeat(index % 97)}`);
    const batches = planEmbeddingBatches(input, { maxTokens: 2_000, maxInputs: 30 });
    expect(batches[0]?.[0]).toBe(0);
    expect(batches.at(-1)?.[1]).toBe(input.length);
    batches.forEach(([start, end], index) => {
      expect(end).toBeGreaterThan(start);
      if (index > 0) expect(start).toBe(batches[index - 1]?.[1]);
      expect(end - start).toBeLessThanOrEqual(30);
      expect(embeddingTokenBound(input.slice(start, end))).toBeLessThanOrEqual(2_000);
    });
  });

  it('uses the configured budget by default and fills batches up to it', () => {
    const input = texts(400, 3_000);
    const batches = planEmbeddingBatches(input);
    expect(batches.length).toBeGreaterThan(1);
    for (const [start, end] of batches) {
      expect(embeddingTokenBound(input.slice(start, end))).toBeLessThanOrEqual(EMBEDDING_BATCH_TOKEN_BUDGET);
    }
    /* Nothing but the last batch could have taken one more input. */
    for (const [start, end] of batches.slice(0, -1)) {
      expect(embeddingTokenBound(input.slice(start, end + 1))).toBeGreaterThan(EMBEDDING_BATCH_TOKEN_BUDGET);
    }
  });

  it('bounds CJK text at no less than one token a character', () => {
    const cjk = '知识市场的检索增强生成'.repeat(100);
    expect(inputTokenBound(cjk)).toBeGreaterThanOrEqual(cjk.length * 2);
    expect(inputTokenBound('ab')).toBeGreaterThanOrEqual(2);
    /* The same number of characters fills a batch three times sooner in CJK than in ASCII. */
    const ascii = 'x'.repeat(cjk.length);
    const cjkBatches = planEmbeddingBatches(Array(300).fill(cjk), { maxTokens: 100_000 });
    const asciiBatches = planEmbeddingBatches(Array(300).fill(ascii), { maxTokens: 100_000 });
    expect(cjkBatches.length).toBeGreaterThanOrEqual(asciiBatches.length * 2);
  });

  it('fails clearly on a single input over the budget', () => {
    expect(() => planEmbeddingBatches(['ok', 'z'.repeat(1_000)], { maxTokens: 500 })).toThrow(EmbeddingInputTooLarge);
    expect(() => planEmbeddingBatches(['ok', 'z'.repeat(1_000)], { maxTokens: 500 })).toThrow(/input 1 is about 1008 tokens/);
  });

  it('returns no batches for no input', () => {
    expect(planEmbeddingBatches([])).toEqual([]);
  });
});

describe('embedInBatches', () => {
  it('returns vectors in input order with every request inside the limits', async () => {
    const { model, peak } = fakeModel({ maxEmbeddingsPerCall: 25 });
    const input = texts(300, 400);
    const { embeddings, tokens } = await embedInBatches(model, input, { timeoutMs: 5_000, maxTokens: 6_000, parallel: 3 });
    expect(embeddings).toEqual(input.map((_, index) => [index]));
    expect(tokens).toBe(300 * 10);
    expect(model.doEmbedCalls.length).toBeGreaterThan(300 / 25);
    for (const call of model.doEmbedCalls) {
      expect(call.values.length).toBeLessThanOrEqual(25);
      expect(embeddingTokenBound(call.values)).toBeLessThanOrEqual(6_000);
    }
    expect(model.doEmbedCalls.flatMap((call) => call.values).sort()).toEqual([...input].sort());
    expect(peak()).toBeLessThanOrEqual(3);
  });

  it('keeps one request for a small input', async () => {
    const { model } = fakeModel();
    const { embeddings } = await embedInBatches(model, ['text-7'], { timeoutMs: 5_000 });
    expect(embeddings).toEqual([[7]]);
    expect(model.doEmbedCalls).toHaveLength(1);
  });

  it('rejects with the provider error and stops the remaining batches', async () => {
    const { model } = fakeModel({ fail: (values) => values.includes('text-0-' + 'x'.repeat(400)) });
    const input = texts(200, 400);
    await expect(embedInBatches(model, input, { timeoutMs: 5_000, maxTokens: 2_000, maxRetries: 0, parallel: 2 })).rejects.toThrow('provider refused');
    expect(model.doEmbedCalls.length).toBeLessThan(planEmbeddingBatches(input, { maxTokens: 2_000 }).length);
  });

  it('does not call the provider for an oversized input', async () => {
    const { model } = fakeModel();
    await expect(embedInBatches(model, ['text-1', 'z'.repeat(EMBEDDING_BATCH_TOKEN_BUDGET)], { timeoutMs: 5_000 })).rejects.toThrow(EmbeddingInputTooLarge);
    expect(model.doEmbedCalls).toHaveLength(0);
  });
});

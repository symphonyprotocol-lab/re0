/**
 * Embedding a large source in provider-sized requests. `embedMany` splits only
 * by `maxEmbeddingsPerCall` (a count), so 2,048 long passages went out as one
 * request and OpenAI refused it ("maximum request size is 300000 tokens per
 * request"). Here the texts are cut into batches whose token upper bound stays
 * under `EMBEDDING_BATCH_TOKEN_BUDGET` and whose size stays under the model's
 * per-call maximum, a few batches run at a time, and the vectors come back in
 * input order.
 */
import { embedMany, type EmbeddingModel } from 'ai';
import { EMBEDDING_BATCH_MAX_INPUTS, EMBEDDING_BATCH_TOKEN_BUDGET, EMBEDDING_PARALLEL_BATCHES } from '@/lib/constants';

const utf8 = new TextEncoder();

/**
 * An upper bound of one input's tokens: byte-level BPE tokenizers never make
 * more tokens than UTF-8 bytes (CJK: 3 bytes for at most ~2 tokens a
 * character; code and ASCII: 1 byte for at most 1 token), plus a few for
 * special tokens.
 */
export function inputTokenBound(value: string): number {
  return utf8.encode(value).length + 8;
}

/** The bound of a whole call; also what a metered call reserves before it runs (`prepareProviderCall`). */
export function embeddingTokenBound(values: readonly unknown[]): number {
  return values.reduce<number>((sum, value) => sum + (typeof value === 'string' ? inputTokenBound(value) : 8), 0);
}

export class EmbeddingInputTooLarge extends Error {
  constructor(index: number, tokens: number, budget: number) {
    super(`embedding input ${index} is about ${tokens} tokens, over the ${budget}-token request budget`);
    this.name = 'EmbeddingInputTooLarge';
  }
}

/**
 * Consecutive `[start, end)` ranges of `texts`, each within `maxTokens`
 * (estimated) and `maxInputs`. A single text over the budget cannot be sent at
 * all, so it fails here, before any request, rather than at the provider.
 */
export function planEmbeddingBatches(
  texts: readonly string[],
  limits: { maxTokens?: number; maxInputs?: number } = {},
): Array<[start: number, end: number]> {
  const maxTokens = limits.maxTokens ?? EMBEDDING_BATCH_TOKEN_BUDGET;
  const maxInputs = Math.max(1, Math.floor(limits.maxInputs ?? EMBEDDING_BATCH_MAX_INPUTS));
  const batches: Array<[number, number]> = [];
  let start = 0;
  let tokens = 0;
  texts.forEach((text, index) => {
    const bound = inputTokenBound(text);
    if (bound > maxTokens) throw new EmbeddingInputTooLarge(index, bound, maxTokens);
    if (index > start && (tokens + bound > maxTokens || index - start >= maxInputs)) {
      batches.push([start, index]);
      start = index;
      tokens = 0;
    }
    tokens += bound;
  });
  if (texts.length > start) batches.push([start, texts.length]);
  return batches;
}

export interface BatchedEmbedOptions {
  /** One attempt's window; each batch gets it once per attempt. */
  timeoutMs: number;
  maxRetries?: number;
  maxTokens?: number;
  maxInputs?: number;
  parallel?: number;
}

/**
 * Every text's vector, in input order, and the summed token usage (NaN when a
 * provider did not report it, as `embedMany` does). One `embedMany` per
 * batch, so retries and the timeout are per request; the first failure
 * aborts the batches still running and is what this rejects with.
 */
export async function embedInBatches(
  model: EmbeddingModel,
  texts: readonly string[],
  options: BatchedEmbedOptions,
): Promise<{ embeddings: number[][]; tokens: number }> {
  if (texts.length === 0) return { embeddings: [], tokens: 0 };
  const maxRetries = options.maxRetries ?? 2;
  const providerMax = typeof model === 'string' ? undefined : await model.maxEmbeddingsPerCall;
  const maxInputs = Math.min(options.maxInputs ?? EMBEDDING_BATCH_MAX_INPUTS, providerMax ?? Infinity);
  const batches = planEmbeddingBatches(texts, { maxTokens: options.maxTokens, maxInputs });
  const embeddings = new Array<number[]>(texts.length);
  const stop = new AbortController();
  let tokens = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < batches.length && !stop.signal.aborted) {
      const [start, end] = batches[next++]!;
      const result = await embedMany({
        model,
        values: texts.slice(start, end),
        maxParallelCalls: 1,
        maxRetries,
        abortSignal: AbortSignal.any([stop.signal, AbortSignal.timeout(options.timeoutMs * (maxRetries + 1))]),
      });
      if (result.embeddings.length !== end - start) {
        throw new Error(`embedding returned ${result.embeddings.length} vectors for ${end - start} inputs`);
      }
      result.embeddings.forEach((vector, offset) => { embeddings[start + offset] = vector; });
      tokens += result.usage?.tokens ?? Number.NaN;
    }
  };

  const workers = Array.from({ length: Math.min(options.parallel ?? EMBEDDING_PARALLEL_BATCHES, batches.length) }, () =>
    worker().catch((error: unknown) => {
      stop.abort(error);
      throw error;
    }),
  );
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failed) throw stop.signal.reason ?? failed.reason;
  return { embeddings, tokens };
}

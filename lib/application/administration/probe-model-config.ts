/**
 * One minimal call against a retrieval model endpoint, for the console: the
 * embedding of a single word, or the scoring of two short passages. The
 * sibling of probe-llm-config for the two models the playground never calls
 * directly, which is why an operator saving one otherwise learns that it
 * answers only when the next build or search fails.
 *
 * Takes the values as typed rather than a saved entry, so a configuration can
 * be checked before it is minted, and runs through the same adapters the
 * pipeline uses, so what passes here passes there. Nothing is recorded.
 */
import type { ModelKind } from '@/lib/domain/model-config';
import {
  embeddingAdapter,
  rerankAdapter,
  type EmbeddingAdapter,
  type EmbeddingProviderConfig,
  type RerankAdapter,
  type RerankProviderConfig,
} from '@/lib/infrastructure/ai/providers';

export interface ModelProbeInput {
  kind: ModelKind;
  baseUrl: string;
  model: string;
  /** Typed into the form, or the stored one opened for it. Never reaches the browser. */
  apiKey: string;
  /** Embedding only. */
  dimensions: number | null;
  timeoutMs: number;
}

export interface ModelProbeResult {
  ok: boolean;
  latencyMs: number;
  /** What came back, in a few words: the width, or the scores. Null on failure. */
  detail: string | null;
  /** The provider's or the adapter's failure message; null on success. */
  error: string | null;
}

export interface ModelProbeDependencies {
  embedding(config: EmbeddingProviderConfig): EmbeddingAdapter;
  rerank(config: RerankProviderConfig): RerankAdapter;
}

const PROBE_TEXT = 'ping';
const PROBE_QUERY = 'What is the capital of France?';
const PROBE_PASSAGES = ['Paris is the capital of France.', 'The recipe calls for two eggs.'];

export async function probeModelConfig(
  input: ModelProbeInput,
  dependencies: ModelProbeDependencies = { embedding: embeddingAdapter, rerank: rerankAdapter },
): Promise<ModelProbeResult> {
  const startedAt = Date.now();
  const failed = (error: string): ModelProbeResult => ({
    ok: false,
    latencyMs: Date.now() - startedAt,
    detail: null,
    error,
  });
  const passed = (detail: string): ModelProbeResult => ({
    ok: true,
    latencyMs: Date.now() - startedAt,
    detail,
    error: null,
  });
  const message = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback;

  if (input.apiKey.length === 0) return failed('the model entry has no credential');

  if (input.kind === 'embedding') {
    if (input.dimensions === null) return failed('an embedding model needs a width');
    let vectors: number[][];
    try {
      vectors = await dependencies
        .embedding({
          baseUrl: input.baseUrl,
          model: input.model,
          apiKey: input.apiKey,
          dimensions: input.dimensions,
          timeoutMs: input.timeoutMs,
        })
        .embed([PROBE_TEXT]);
    } catch (error) {
      return failed(message(error, 'embedding call failed'));
    }
    /* The adapter already refused a short batch or a wrong width; an empty
       vector is the one shape it lets through that still means "nothing". */
    const vector = vectors[0];
    if (!vector || vector.every((value) => value === 0)) {
      return failed('the provider returned an empty vector');
    }
    return passed(`${input.dimensions} d`);
  }

  let scores: number[];
  try {
    scores = await dependencies
      .rerank({
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: input.apiKey,
        timeoutMs: input.timeoutMs,
      })
      .rerank(PROBE_QUERY, PROBE_PASSAGES);
  } catch (error) {
    return failed(message(error, 'rerank call failed'));
  }
  /* The adapter scores an unmentioned passage 0, so a provider that answered
     200 with no results would read as reachable. It is reachable, but it is
     not ranking, and that is what the operator is asking. */
  if (scores.length !== PROBE_PASSAGES.length || scores.every((score) => score === 0)) {
    return failed('the provider returned no scores');
  }
  return passed(scores.map((score) => score.toFixed(2)).join(' / '));
}

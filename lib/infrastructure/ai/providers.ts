/**
 * Replaceable AI provider adapters for the retrieval path: embeddings and
 * reranking.
 *
 * Both speak an HTTP shape their vendors share and are handed their endpoint,
 * model, credential and clock by the caller, so a different provider is a
 * console save rather than a code change -- and this module reads no
 * environment of its own. That is the whole point of the seam: architecture.md
 * 20 forbids a provider type from leaking into the domain or the SDK, and 15.3
 * keeps the credential's storage the application's problem rather than the
 * adapter's.
 *
 * The LLM adapter deliberately lives next door in `llm.ts` rather than here.
 * 9.5 requires that REST and MCP keep working with the generation layer
 * removed, and this module is on their request path -- so the AI SDK must not
 * be reachable from it, which an import in this file would make it.
 */
import { EMBEDDING_COLUMN_DIMENSIONS, padToColumn } from '@/lib/domain/model-config';

export interface EmbeddingAdapter {
  /** Vectors padded to the stored column width; see `padToColumn`. */
  embed(texts: string[]): Promise<number[][]>;
  /** Recorded on `library_version.embedding_model`, which freezes it. */
  readonly model: string;
  /**
   * The width the *model* is asked for, recorded on
   * `library_version.embedding_dimensions`. Not the width of what `embed`
   * returns, which is always the column's: a version built at 1024 and one
   * built at 1536 live in different spaces even though their rows are the
   * same size, and this is the number that tells them apart.
   */
  readonly dimensions: number;
}

export interface RerankAdapter {
  rerank(query: string, candidates: string[]): Promise<number[]>;
}

/**
 * The stored width of `chunk.embedding` and `library_profile_vector.embedding`.
 *
 * Re-exported from the domain so the ingestion and retrieval paths can keep
 * importing it from the adapter they already depend on.
 */
export { EMBEDDING_COLUMN_DIMENSIONS };

/** Provider request caps. A build sends thousands of chunks through this. */
const EMBEDDING_BATCH = 96;
const EMBEDDING_ATTEMPTS = 3;

export class ProviderUnavailable extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderUnavailable';
  }
}

/** What the console stores for an embedding entry, resolved and opened. */
export interface EmbeddingProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** What the provider is asked for, and what the version freezes. */
  dimensions: number;
  timeoutMs: number;
}

export function embeddingAdapter(config: EmbeddingProviderConfig): EmbeddingAdapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const { model, apiKey, dimensions, timeoutMs } = config;
  if (!apiKey) throw new ProviderUnavailable('embedding', 'the embedding model has no credential');
  if (dimensions > EMBEDDING_COLUMN_DIMENSIONS) {
    throw new ProviderUnavailable(
      'embedding',
      `${dimensions} dimensions do not fit the ${EMBEDDING_COLUMN_DIMENSIONS}-wide column`,
    );
  }

  return {
    model,
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const vectors: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += EMBEDDING_BATCH) {
        const batch = texts.slice(offset, offset + EMBEDDING_BATCH);
        vectors.push(
          ...(await embedBatch({ apiKey, baseUrl, model, dimensions, timeoutMs, batch })),
        );
      }
      return vectors;
    },
  };
}

async function embedBatch(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
  batch: string[];
}): Promise<number[][]> {
  let lastError = 'unknown';

  for (let attempt = 1; attempt <= EMBEDDING_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${input.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: input.model,
          input: input.batch,
          dimensions: input.dimensions,
        }),
        signal: AbortSignal.timeout(input.timeoutMs),
        cache: 'no-store',
      });
    } catch {
      lastError = 'unreachable';
      await backoff(attempt);
      continue;
    }

    /*
     * 429 and 5xx are retried; 4xx is not. A rejected request body does not
     * become acceptable by being sent again, and retrying it burns the budget
     * that the retryable failures need.
     */
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      lastError = `status ${response.status}`;
      await backoff(attempt);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProviderUnavailable('embedding', `embedding provider rejected: ${response.status}`);
    }

    const body = (await response.json()) as { data?: { embedding?: number[] }[] };
    const vectors = (body.data ?? []).map((entry) => entry.embedding ?? []);
    if (vectors.length !== input.batch.length) {
      throw new ProviderUnavailable('embedding', 'embedding provider returned a short batch');
    }
    /*
     * Held to the configured width, not the column's: a provider that ignored
     * the `dimensions` it was asked for has produced vectors from a different
     * space than the version records, and padding those into the column would
     * store them as if they belonged. The padding happens after the check,
     * which is the only place the two widths are allowed to differ.
     */
    for (const vector of vectors) {
      if (vector.length !== input.dimensions) {
        throw new ProviderUnavailable(
          'embedding',
          `embedding provider returned ${vector.length} dimensions, not ${input.dimensions}`,
        );
      }
    }
    return vectors.map(padToColumn);
  }

  throw new ProviderUnavailable('embedding', `embedding provider unavailable: ${lastError}`);
}

/** Exponential, so a rate-limited provider is not hammered flat. */
async function backoff(attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
}

/** What the console stores for a rerank entry, resolved and opened. */
export interface RerankProviderConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

/**
 * Speaks the Cohere-compatible `/rerank` shape (Cohere, Jina, OpenRouter and
 * most hosted rerankers accept it): query + documents in, `{index,
 * relevance_score}` pairs out. Endpoint and model are configuration, so a
 * different provider is a console save.
 *
 * One attempt, tight timeout, no retries -- unlike embeddings, a rerank is an
 * ordering refinement on an already-correct candidate list, and the caller
 * degrades to fusion order rather than waiting out a backoff.
 */
export function rerankAdapter(config: RerankProviderConfig): RerankAdapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const { model, apiKey, timeoutMs } = config;
  if (!apiKey) throw new ProviderUnavailable('rerank', 'the rerank model has no credential');

  return {
    async rerank(query: string, candidates: string[]): Promise<number[]> {
      const response = await fetch(`${baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, query, documents: candidates }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new ProviderUnavailable('rerank', `provider answered ${response.status}`);
      }

      const payload = (await response.json()) as {
        results?: { index?: number; relevance_score?: number }[];
      };
      const scores = new Array<number>(candidates.length).fill(0);
      for (const result of payload.results ?? []) {
        if (
          typeof result.index === 'number' &&
          result.index >= 0 &&
          result.index < candidates.length &&
          typeof result.relevance_score === 'number'
        ) {
          scores[result.index] = result.relevance_score;
        }
      }
      return scores;
    },
  };
}

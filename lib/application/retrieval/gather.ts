/**
 * Scatter-gather over the routed candidates. architecture.md 9.6, layer 3.
 *
 * `query-docs` is one asset by contract, and stays so: the cost model of
 * 9.1 is an exact scan of one pinned version, and a citation, a cache entry
 * and a metered call each name one version. Reading several assets for
 * one question is therefore a layer above it -- this one -- and not a change
 * to it. The web entry uses this layer; an MCP agent does its own gathering
 * by calling `query-docs` again, which is the 9.6 split of "who decides".
 *
 * What it does with the candidates the router admitted:
 *
 * - retrieves from every one in parallel, each with the full token budget
 *   -- the per-asset scan is cheap, and a fair share decided before
 *   retrieval would starve the asset that turns out to hold the answer;
 * - keeps only the assets whose own retrieval is *confirmed*
 *   (lib/domain/routing.ts): a router candidate is an asset that may be
 *   about the question, and only its chunk distances say whether it is;
 * - merges the surviving chunks by score and trims to the budget once.
 *   Scores are reciprocal-rank sums with one constant, so the merge is in
 *   effect an interleave by rank -- each confirmed asset's best passage
 *   comes before any asset's second -- and a reranker, when on, scores
 *   every asset's head on the same scale;
 * - meters one Call, and only for an exchange that has context. The top
 *   candidate reserves the seat before anything is read (query-docs.ts
 *   `meter: 'deferred'`), so quota still refuses up front; the other reads
 *   are unmetered. Once every retrieval is judged and merged, the seat is
 *   committed against the asset whose passage leads the context -- the one
 *   that is credited -- or released when no passage made it in. Charging the
 *   top candidate whatever it returned billed a reader the "nothing
 *   relevant" card, and paid an asset whose passages were thrown away while
 *   the one that answered earned nothing.
 *
 * A failure of the top candidate is the exchange's failure, as before. A
 * failure of any other candidate drops that asset and keeps the exchange:
 * one suspended or racing asset must not turn an answerable question into
 * a degraded card.
 */
import type { ChunkResult } from '@/contracts/schemas';
import { containsCjk } from '@/lib/domain/cjk';
import { excerptsOf } from '@/lib/domain/generation';
import type { EmbeddingAdapter } from '@/lib/infrastructure/ai/providers';
import { confirmsRetrieval, type RetrievalConfidence } from '@/lib/domain/routing';
import type { CallerContext } from './index';
import { releaseCall } from '@/lib/application/plans';
import {
  commitServedCall,
  defaultRetrievalDependencies,
  queryDocsDetailed,
  type QueryDocsResult,
  type RetrievalDependencies,
} from './query-docs';

export interface GatherAsset {
  assetId: string;
  title: string;
}

/** A retrieved chunk that remembers which asset and version it came from. */
export type GatheredChunk = ChunkResult & {
  assetId: string;
  assetTitle: string;
  version: string;
};

export interface GatheredAsset {
  assetId: string;
  title: string;
  /** Null when the retrieval failed before pinning a version. */
  version: string | null;
  /** Whether its passages fit the question well enough to be context. */
  confirmed: boolean;
  /** The nearest FAQ chunk the vector leg saw, with its distance (routing.ts); null when none, or the retrieval failed. */
  faqNearest: { chunkId: string; distance: number } | null;
  /** Passages it contributed after the merge. */
  chunks: number;
  failed: boolean;
  /**
   * The opening of its nearest passages, confirmed or not: what the rewrite
   * on a miss is shown of the site (lib/domain/generation.ts `excerptsOf`).
   * Empty when the retrieval failed.
   */
  excerpts: string[];
}

export interface GatherResult {
  chunks: GatheredChunk[];
  assets: GatheredAsset[];
  requestId: string;
}

export interface GatherInput {
  /** In routing order; the first reserves the exchange's seat. At least one. */
  assets: readonly GatherAsset[];
  query: string;
  maxTokens: number;
  /** False reads without metering at all (query-docs.ts `meter`). Default true. */
  meter?: boolean;
}

export async function gatherAcrossAssets(
  caller: CallerContext,
  input: GatherInput,
  dependencies: RetrievalDependencies = defaultRetrievalDependencies(),
): Promise<GatherResult> {
  const [top, ...rest] = input.assets;
  if (!top) throw new Error('gather needs at least one asset');

  const shared = shareQueryEmbedding(dependencies);

  const retrieve = (asset: GatherAsset, meter: boolean | 'deferred') =>
    queryDocsDetailed(
      caller,
      {
        assetId: asset.assetId,
        query: input.query,
        maxTokens: input.maxTokens,
        format: 'json',
      },
      shared,
      { meter },
    );

  const settled = await Promise.allSettled([
    retrieve(top, input.meter === false ? false : 'deferred'),
    ...rest.map((asset) => retrieve(asset, false)),
  ]);

  const first = settled[0]!;
  if (first.status === 'rejected') throw first.reason;
  /* Pending until the confirmations below say who served the exchange. */
  const seat = first.value.reservation;
  try {
    return await judge(input, settled, seat, caller, first.value.requestId);
  } catch (error) {
    if (seat) await releaseCall(seat.reservationId).catch(() => {});
    throw error;
  }
}

async function judge(
  input: GatherInput,
  settled: PromiseSettledResult<QueryDocsResult>[],
  seat: QueryDocsResult['reservation'],
  caller: CallerContext,
  requestId: string,
): Promise<GatherResult> {
  const questionHasHan = containsCjk(input.query);
  const results: { asset: GatherAsset; result: QueryDocsResult | null }[] = [];
  input.assets.forEach((asset, at) => {
    const outcome = settled[at]!;
    if (outcome.status === 'fulfilled') {
      results.push({ asset, result: outcome.value });
    } else {
      /* The asset, never the question (architecture.md 17.1). */
      console.error(
        `gather skipped ${asset.assetId}: ${
          outcome.reason instanceof Error ? outcome.reason.message : 'unknown'
        }`,
      );
      results.push({ asset, result: null });
    }
  });

  /*
   * A cache entry from before the confidence existed carries none, and is
   * trusted as it was -- the same rule the single-asset path applied.
   *
   * `crossScript` is the question against *this* asset's passages, not the
   * question alone. The two thresholds exist because a non-multilingual
   * embedding puts a question and an answer written in different scripts
   * further apart than it puts two in the same one -- so the comparison needs
   * both sides. Read off the question alone it was neither: a Chinese question
   * about a Chinese corpus took the loose cross-script gate and confirmed
   * passages that had nothing to do with it, while an English question about
   * that same corpus took the strict one and refused the passages that did.
   */
  const confirmed = results.map(({ result }) =>
    result === null ? false : readConfirms(result, questionHasHan),
  );

  const { pool, chunks, contributed } = mergeReads(
    results.map(({ asset, result }, order) =>
      result && confirmed[order] ? { title: asset.title, result } : null,
    ),
    input.maxTokens,
  );

  /*
   * The exchange's one Call: charged, and credited to the asset whose
   * passage leads the merged context -- or released when nothing made it
   * in, which is the "nothing relevant" card and no answer at all.
   */
  if (seat) {
    const lead = pool.find((entry) => chunks.includes(entry.chunk));
    const served = lead ? results[lead.order]?.result?.served : undefined;
    if (served) await commitServedCall(caller, seat, served);
    else await releaseCall(seat.reservationId);
  }

  return {
    chunks,
    assets: results.map(({ asset, result }, order) => ({
      assetId: asset.assetId,
      title: asset.title,
      version: result?.version ?? null,
      confirmed: confirmed[order]!,
      faqNearest: result?.confidence?.faqNearest ?? null,
      chunks: contributed.get(order) ?? 0,
      failed: result === null,
      excerpts: result ? excerptsOf(result.chunks.map((chunk) => chunk.text)) : [],
    })),
    requestId,
  };
}

/**
 * Whether one read fits its query well enough to be context.
 *
 * Shared with the playground's agent (playground/agent.ts), whose reads are
 * one asset and one query each, and with A2A `ask` and the channel twin
 * (agent/ask.ts), whose read is one ranked recall across a scope -- so no
 * generation entry can disagree about what "confirmed" means.
 */
export function readConfirms(
  result: { confidence?: RetrievalConfidence | null; chunks: readonly { text: string }[] },
  queryHasHan: boolean,
): boolean {
  /* Null: a cache entry from before the confidence existed, trusted as it was. Absent: nothing to judge by. */
  if (result.confidence === null) return true;
  if (result.confidence === undefined) return false;
  const corpusHasHan = result.chunks.some((chunk) => containsCjk(chunk.text));
  return confirmsRetrieval(result.confidence, { crossScript: queryHasHan !== corpusHasHan });
}

/**
 * Confirmed reads merged into one context: by score, then read order, then
 * rank within the read, trimmed to the budget once. A null entry is a read
 * that did not confirm and keeps its place in the order. A chunk two reads
 * both returned is kept once, at its better position.
 */
export function mergeReads(
  reads: readonly ({ title: string; result: QueryDocsResult } | null)[],
  maxTokens: number,
): {
  pool: { chunk: GatheredChunk; order: number; rank: number }[];
  chunks: GatheredChunk[];
  contributed: Map<number, number>;
} {
  const pool: { chunk: GatheredChunk; order: number; rank: number }[] = [];
  reads.forEach((read, order) => {
    if (!read) return;
    read.result.chunks.forEach((chunk, rank) => {
      pool.push({
        chunk: {
          ...chunk,
          assetId: read.result.assetId,
          assetTitle: read.title,
          version: read.result.version,
        },
        order,
        rank,
      });
    });
  });
  pool.sort((a, b) => b.chunk.score - a.chunk.score || a.order - b.order || a.rank - b.rank);

  const chunks: GatheredChunk[] = [];
  const seen = new Set<string>();
  const contributed = new Map<number, number>();
  let budget = maxTokens;
  for (const entry of pool) {
    if (seen.has(entry.chunk.chunkId) || entry.chunk.tokens > budget) continue;
    seen.add(entry.chunk.chunkId);
    budget -= entry.chunk.tokens;
    chunks.push(entry.chunk);
    contributed.set(entry.order, (contributed.get(entry.order) ?? 0) + 1);
  }
  return { pool, chunks, contributed };
}

/**
 * The same dependencies, with one embedding of the question instead of one
 * per candidate.
 *
 * Every candidate ran the identical `embed([query])` inside its own
 * `query-docs`, so a three-candidate exchange made three identical POSTs to
 * the provider for a vector that cannot differ -- three billings and three
 * shares of the rate limit for one question. The query is embedded once here
 * and every leg awaits the same promise; the vector is not cached beyond the
 * call, because it belongs to this question and this request.
 *
 * Only the single-text case is shared. A batch is ingestion's shape, never a
 * query's, and is passed straight through.
 */
function shareQueryEmbedding(dependencies: RetrievalDependencies): RetrievalDependencies {
  const inflight = new Map<string, Promise<number[][]>>();
  let shared: EmbeddingAdapter | null = null;

  return {
    ...dependencies,
    async embeddings(): Promise<EmbeddingAdapter> {
      const base = await dependencies.embeddings();
      shared ??= {
        model: base.model,
        dimensions: base.dimensions,
        embed(texts: string[]): Promise<number[][]> {
          const only = texts.length === 1 ? texts[0] : null;
          if (only === null) return base.embed(texts);
          const key = `${base.model}\u0000${only}`;
          let pending = inflight.get(key);
          if (!pending) {
            pending = base.embed(texts);
            inflight.set(key, pending);
          }
          return pending;
        },
      };
      return shared;
    },
  };
}

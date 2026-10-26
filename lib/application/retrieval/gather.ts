/**
 * Scatter-gather over the routed candidates. architecture.md 9.6, layer 3.
 *
 * `query-docs` is one library by contract, and stays so: the cost model of
 * 9.1 is an exact scan of one pinned version, and a citation, a cache entry
 * and a metered call each name one version. Reading several libraries for
 * one question is therefore a layer above it -- this one -- and not a change
 * to it. The web entry uses this layer; an MCP agent does its own gathering
 * by calling `query-docs` again, which is the 9.6 split of "who decides".
 *
 * What it does with the candidates the router admitted:
 *
 * - retrieves from every one in parallel, each with the full token budget
 *   -- the per-library scan is cheap, and a fair share decided before
 *   retrieval would starve the library that turns out to hold the answer;
 * - keeps only the libraries whose own retrieval is *confirmed*
 *   (lib/domain/routing.ts): a router candidate is a library that may be
 *   about the question, and only its chunk distances say whether it is;
 * - merges the surviving chunks by score and trims to the budget once.
 *   Scores are reciprocal-rank sums with one constant, so the merge is in
 *   effect an interleave by rank -- each confirmed library's best passage
 *   comes before any library's second -- and a reranker, when on, scores
 *   every library's head on the same scale;
 * - meters one Call, and only for an exchange that has context. The top
 *   candidate reserves the seat before anything is read (query-docs.ts
 *   `meter: 'deferred'`), so quota still refuses up front; the other reads
 *   are unmetered. Once every retrieval is judged and merged, the seat is
 *   committed against the library whose passage leads the context -- the one
 *   that is credited -- or released when no passage made it in. Charging the
 *   top candidate whatever it returned billed a reader the "nothing
 *   relevant" card, and paid a library whose passages were thrown away while
 *   the one that answered earned nothing.
 *
 * A failure of the top candidate is the exchange's failure, as before. A
 * failure of any other candidate drops that library and keeps the exchange:
 * one suspended or racing library must not turn an answerable question into
 * a degraded card.
 */
import type { ChunkResult } from '@/contracts/schemas';
import { containsCjk } from '@/lib/domain/cjk';
import { excerptsOf } from '@/lib/domain/generation';
import type { EmbeddingAdapter } from '@/lib/infrastructure/ai/providers';
import { confirmsRetrieval } from '@/lib/domain/routing';
import type { CallerContext } from './index';
import { releaseCall } from '@/lib/application/plans';
import {
  commitServedCall,
  defaultRetrievalDependencies,
  queryDocsDetailed,
  type QueryDocsResult,
  type RetrievalDependencies,
} from './query-docs';

export interface GatherLibrary {
  libraryId: string;
  title: string;
}

/** A retrieved chunk that remembers which library and version it came from. */
export type GatheredChunk = ChunkResult & {
  libraryId: string;
  libraryTitle: string;
  version: string;
};

export interface GatheredLibrary {
  libraryId: string;
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
  libraries: GatheredLibrary[];
  requestId: string;
}

export interface GatherInput {
  /** In routing order; the first reserves the exchange's seat. At least one. */
  libraries: readonly GatherLibrary[];
  query: string;
  maxTokens: number;
  /** False reads without metering at all (query-docs.ts `meter`). Default true. */
  meter?: boolean;
}

export async function gatherAcrossLibraries(
  caller: CallerContext,
  input: GatherInput,
  dependencies: RetrievalDependencies = defaultRetrievalDependencies(),
): Promise<GatherResult> {
  const [top, ...rest] = input.libraries;
  if (!top) throw new Error('gather needs at least one library');

  const shared = shareQueryEmbedding(dependencies);

  const retrieve = (library: GatherLibrary, meter: boolean | 'deferred') =>
    queryDocsDetailed(
      caller,
      {
        libraryId: library.libraryId,
        query: input.query,
        maxTokens: input.maxTokens,
        format: 'json',
      },
      shared,
      { meter },
    );

  const settled = await Promise.allSettled([
    retrieve(top, input.meter === false ? false : 'deferred'),
    ...rest.map((library) => retrieve(library, false)),
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
  const results: { library: GatherLibrary; result: QueryDocsResult | null }[] = [];
  input.libraries.forEach((library, at) => {
    const outcome = settled[at]!;
    if (outcome.status === 'fulfilled') {
      results.push({ library, result: outcome.value });
    } else {
      /* The library, never the question (architecture.md 17.1). */
      console.error(
        `gather skipped ${library.libraryId}: ${
          outcome.reason instanceof Error ? outcome.reason.message : 'unknown'
        }`,
      );
      results.push({ library, result: null });
    }
  });

  /*
   * A cache entry from before the confidence existed carries none, and is
   * trusted as it was -- the same rule the single-library path applied.
   *
   * `crossScript` is the question against *this* library's passages, not the
   * question alone. The two thresholds exist because a non-multilingual
   * embedding puts a question and an answer written in different scripts
   * further apart than it puts two in the same one -- so the comparison needs
   * both sides. Read off the question alone it was neither: a Chinese question
   * about a Chinese corpus took the loose cross-script gate and confirmed
   * passages that had nothing to do with it, while an English question about
   * that same corpus took the strict one and refused the passages that did.
   */
  const confirmed = results.map(({ result }) => {
    if (result === null) return false;
    if (result.confidence === null) return true;
    const corpusHasHan = result.chunks.some((chunk) => containsCjk(chunk.text));
    return confirmsRetrieval(result.confidence, { crossScript: questionHasHan !== corpusHasHan });
  });

  const pool: { chunk: GatheredChunk; order: number; rank: number }[] = [];
  results.forEach(({ library, result }, order) => {
    if (!result || !confirmed[order]) return;
    result.chunks.forEach((chunk, rank) => {
      pool.push({
        chunk: {
          ...chunk,
          libraryId: result.libraryId,
          libraryTitle: library.title,
          version: result.version,
        },
        order,
        rank,
      });
    });
  });
  pool.sort((a, b) => b.chunk.score - a.chunk.score || a.order - b.order || a.rank - b.rank);

  const chunks: GatheredChunk[] = [];
  const contributed = new Map<number, number>();
  let budget = input.maxTokens;
  for (const entry of pool) {
    if (entry.chunk.tokens > budget) continue;
    budget -= entry.chunk.tokens;
    chunks.push(entry.chunk);
    contributed.set(entry.order, (contributed.get(entry.order) ?? 0) + 1);
  }

  /*
   * The exchange's one Call: charged, and credited to the library whose
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
    libraries: results.map(({ library, result }, order) => ({
      libraryId: library.libraryId,
      title: library.title,
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

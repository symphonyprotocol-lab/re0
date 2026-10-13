/**
 * Recall, fusion, rerank and trim within one pinned version -- the part of
 * `queryDocs` that reads chunks, with none of the part that decides who may
 * (architecture.md 9.2).
 *
 * Separate so a second caller can rank against a version without being a
 * served call: the build's benchmark evaluation (ingestion/evaluate.ts) asks
 * a library its own test questions, and those must go through exactly the
 * retrieval a user's question would, or the score measures something else.
 * Authorization, the policy, the reservation and the cache all stay in
 * `queryDocs`; nothing here may be reached from /v1 or MCP except through it.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ChunkResult } from '@/contracts/schemas';
import { cjkSearchTokens, containsCjk } from '@/lib/domain/cjk';
import { searchTokens } from '@/lib/domain/profile';
import type { RetrievalSettings } from '@/lib/domain/retrieval-config';
import type { RetrievalConfidence } from '@/lib/domain/routing';
import { schema, type db } from '@/lib/infrastructure/postgres/client';
import type { PinnedVersion, RetrievalDependencies } from './query-docs';
import { toTsquery } from './resolve-library';

export interface RankTarget {
  libraryId: string;
  version: Pick<PinnedVersion, 'id' | 'searchConfig' | 'embeddingModel' | 'embeddingDimensions'>;
  query: string;
  maxTokens: number;
}

export async function rankChunks(
  database: ReturnType<typeof db>,
  target: RankTarget,
  dependencies: Pick<RetrievalDependencies, 'embeddings' | 'rerank' | 'configured'>,
  settings: RetrievalSettings,
): Promise<{ chunks: ChunkResult[]; confidence: RetrievalConfidence }> {
  const { version } = target;

  /* ---------------------------------------------------------- recall */

  /* Which stages this installation can run. The default seams answer this
     and hand out the adapters from one read of `provider_model_config`, so
     a stage reported here cannot vanish before it is called. */
  const configured = await dependencies.configured();

  /*
   * OR over the query's tokens, ranked -- AND semantics (plainto) would
   * demand every word in one chunk, and a question's words usually straddle
   * chunks. Each quoted token is still normalised through the version's
   * frozen configuration, so stemming matches how the chunks were indexed.
   *
   * A query with Han text also matches the pre-segmented CJK vector
   * (lib/domain/cjk.ts) -- the main vector cannot see inside a Han run, and
   * without this branch Chinese keyword recall is silently zero.
   */
  const tsquery = toTsquery(searchTokens(target.query));
  const cjkQuery = containsCjk(target.query) ? toTsquery(cjkSearchTokens(target.query)) : null;

  const matches = tsquery
    ? cjkQuery
      ? sql`(${schema.chunk.searchVector} @@ to_tsquery(${version.searchConfig}::regconfig, ${tsquery})
            or ${schema.chunk.searchVectorCjk} @@ to_tsquery('simple', ${cjkQuery}))`
      : sql`${schema.chunk.searchVector} @@ to_tsquery(${version.searchConfig}::regconfig, ${tsquery})`
    : null;
  const rank = tsquery
    ? cjkQuery
      ? sql`ts_rank(${schema.chunk.searchVector}, to_tsquery(${version.searchConfig}::regconfig, ${tsquery}))
            + ts_rank(${schema.chunk.searchVectorCjk}, to_tsquery('simple', ${cjkQuery}))`
      : sql`ts_rank(${schema.chunk.searchVector}, to_tsquery(${version.searchConfig}::regconfig, ${tsquery}))`
    : null;

  const keyword =
    matches && rank
      ? await database
          .select({
            id: schema.chunk.id,
            body: schema.chunk.body,
            tokens: schema.chunk.tokens,
            citation: schema.chunk.citation,
          })
          .from(schema.chunk)
          .where(and(scopedTo(target.libraryId, version.id), matches))
          .orderBy(desc(rank))
          .limit(settings.recallLimit)
      : [];

  /*
   * The vector leg only runs when the configured adapter is the model the
   * version's vectors were built with, at the same width (both frozen on the
   * version, requirement.md 8.1): a query embedded by a different model --
   * or by the same model asked for a different number of dimensions -- lives
   * in a different vector space, and comparing across spaces returns
   * confident nonsense. The stored rows are all the column's width, since
   * narrower vectors are padded into it, so the width has to be compared
   * against what the version recorded rather than against what came back.
   * On a mismatch the keyword leg carries the request alone.
   */
  let semantic: ((typeof keyword)[number] & { distance: number })[] = [];
  const embeddings = configured.embeddings ? await dependencies.embeddings() : null;
  if (
    embeddings &&
    embeddings.model === version.embeddingModel &&
    embeddings.dimensions === version.embeddingDimensions
  ) {
    const [queryVector] = await embeddings.embed([target.query]);
    if (queryVector) {
      const literal = `[${queryVector.join(',')}]`;
      semantic = await database
        .select({
          id: schema.chunk.id,
          body: schema.chunk.body,
          tokens: schema.chunk.tokens,
          citation: schema.chunk.citation,
          distance: sql<number>`${schema.chunk.embedding} <=> ${literal}::vector`,
        })
        .from(schema.chunk)
        .where(scopedTo(target.libraryId, version.id))
        .orderBy(sql`${schema.chunk.embedding} <=> ${literal}::vector`)
        .limit(settings.recallLimit);
    }
  }

  /*
   * What this retrieval can say about its own fit, for the playground's
   * confirmation (lib/domain/routing.ts). The vector leg is ordered by
   * distance, so its first row is the best; a leg that did not run says
   * nothing rather than zero.
   */
  const confidence: RetrievalConfidence = {
    bestDistance: semantic.length > 0 ? Number(semantic[0]!.distance) : null,
    keywordHits: keyword.length,
  };

  /* --------------------------------------- fuse, dedupe, trim, format */

  const fused = new Map<string, { score: number; row: (typeof keyword)[number] }>();
  for (const list of [keyword, semantic]) {
    list.forEach((row, index) => {
      const entry = fused.get(row.id);
      const gain = 1 / (settings.rrfK + index + 1);
      if (entry) entry.score += gain;
      else fused.set(row.id, { score: gain, row });
    });
  }

  let ordered = [...fused.values()].sort((a, b) => b.score - a.score);

  /*
   * §9.2 rerank, over the fused head only. A failure keeps fusion order:
   * rerank refines an already-correct list, so it is never worth an error
   * or a retry -- the adapter carries a tight timeout for the same reason.
   */
  if (configured.rerank && ordered.length > 1) {
    const head = ordered.slice(0, settings.rerankWindow);
    try {
      const scores = await (await dependencies.rerank()).rerank(
        target.query,
        head.map((entry) => entry.row.body.slice(0, settings.rerankDocumentChars)),
      );
      if (scores.length === head.length) {
        const reranked = head
          .map((entry, at) => ({ ...entry, score: scores[at]! }))
          .sort((a, b) => b.score - a.score);
        ordered = [...reranked, ...ordered.slice(settings.rerankWindow)];
      }
    } catch {
      /* fusion order stands */
    }
  }

  const seenBodies = new Set<string>();
  const chunks: ChunkResult[] = [];
  let budget = target.maxTokens;

  for (const { score, row } of ordered) {
    /* §9.3: near-duplicates collapse; the key mirrors the builder's. */
    const bodyKey = `${row.body.length}:${row.body.slice(0, 200)}`;
    if (seenBodies.has(bodyKey)) continue;
    const citation = toCitation(row.citation);
    if (!citation) continue; /* §9.3: a chunk without a citation is not returned */
    if (row.tokens > budget) continue;
    seenBodies.add(bodyKey);
    budget -= row.tokens;
    chunks.push({
      chunkId: row.id,
      text: row.body,
      score: Number(score.toFixed(6)),
      tokens: row.tokens,
      citation,
    });
  }

  return { chunks, confidence };
}

/** §9.1: every chunk read is scoped, and unsafe rows are excluded in the same predicate. */
function scopedTo(libraryId: string, versionId: string) {
  return and(
    eq(schema.chunk.libraryId, libraryId),
    eq(schema.chunk.versionId, versionId),
    sql`${schema.chunk.safetyStatus} not in ('quarantined', 'unsafe')`,
  );
}

function toCitation(raw: Record<string, unknown>): ChunkResult['citation'] | null {
  const url = typeof raw.url === 'string' ? raw.url : null;
  const title = typeof raw.title === 'string' ? raw.title : null;
  if (!url || !title) return null;
  return {
    sourceUrl: url,
    documentTitle: title,
    section: typeof raw.section === 'string' ? raw.section : null,
    lines: null,
  };
}

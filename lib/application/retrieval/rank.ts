/**
 * Recall, fusion, rerank and trim within pinned versions -- the part of
 * `queryDocs` that reads chunks, with none of the part that decides who may
 * (architecture.md 9.2).
 *
 * One version for a read of one asset; a set of them for a read of a
 * channel (agent-first-proposal.md 3.7): the exact scan was always filtered
 * by asset, and a channel only widens the filter from one to a group, so a
 * channel is still one keyword query and one vector query, never a query per
 * asset merged afterwards. Versions frozen with a different text-search
 * configuration each get their own keyword predicate inside the same
 * statement; the vector leg reads only versions built with the model in
 * force, exactly as for one asset.
 *
 * Separate so a second caller can rank against a version without being a
 * served call: a reviewer's probe (administration/review-content.ts) asks a
 * asset a question, and it must go through exactly the retrieval a user's
 * question would, or the reviewer sees ranks a caller never gets.
 * Authorization, the policy, the reservation and the cache all stay in
 * `queryDocs`; nothing here may be reached from /v1 or MCP except through it.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ChunkResult } from '@/contracts/schemas';
import { cjkSearchTokens, containsCjk } from '@/lib/domain/cjk';
import { keywordEvidenceOf } from '@/lib/domain/keyword-evidence';
import { searchTokens } from '@/lib/domain/profile';
import type { RetrievalSettings } from '@/lib/domain/retrieval-config';
import type { RetrievalConfidence } from '@/lib/domain/routing';
import { schema, type db } from '@/lib/infrastructure/postgres/client';
import type { PinnedVersion, RetrievalDependencies } from './query-docs';
import { toTsquery } from './resolve-asset';

/** How many of the keyword leg's top-ranked chunks are read for evidence. */
const KEYWORD_EVIDENCE_CHUNKS = 10;

export interface RankTarget {
  assetId: string;
  version: Pick<PinnedVersion, 'id' | 'searchConfig' | 'embeddingModel' | 'embeddingDimensions'>;
  query: string;
  maxTokens: number;
}

/** One pinned version of one asset, as a member of a ranked set. */
export interface RankScopeMember {
  assetId: string;
  version: Pick<PinnedVersion, 'id' | 'searchConfig' | 'embeddingModel' | 'embeddingDimensions'>;
}

/** A ranked chunk plus which asset and version it came from. */
export type ScopedChunk = ChunkResult & { assetId: string; versionId: string };

export async function rankChunks(
  database: ReturnType<typeof db>,
  target: RankTarget,
  dependencies: Pick<RetrievalDependencies, 'embeddings' | 'rerank' | 'configured'>,
  settings: RetrievalSettings,
): Promise<{ chunks: ChunkResult[]; confidence: RetrievalConfidence }> {
  const ranked = await rankAcross(
    database,
    { members: [{ assetId: target.assetId, version: target.version }], query: target.query, maxTokens: target.maxTokens },
    dependencies,
    settings,
  );
  return {
    chunks: ranked.chunks.map(({ assetId: _assetId, versionId: _versionId, ...chunk }) => chunk),
    confidence: ranked.confidence,
  };
}

export async function rankAcross(
  database: ReturnType<typeof db>,
  target: { members: readonly RankScopeMember[]; query: string; maxTokens: number },
  dependencies: Pick<RetrievalDependencies, 'embeddings' | 'rerank' | 'configured'>,
  settings: RetrievalSettings,
): Promise<{ chunks: ScopedChunk[]; confidence: RetrievalConfidence }> {
  const { members } = target;
  if (members.length === 0) {
    return {
      chunks: [],
      confidence: { bestDistance: null, faqNearest: null, keywordHits: 0, keywordEvidence: null },
    };
  }

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

  /* Grouped by the configuration each version froze; usually one group. */
  const byConfig = new Map<string, string[]>();
  for (const member of members) {
    const ids = byConfig.get(member.version.searchConfig) ?? [];
    ids.push(member.version.id);
    byConfig.set(member.version.searchConfig, ids);
  }
  const groups = [...byConfig.entries()];
  const versionIn = (ids: string[]) => sql`${schema.chunk.versionId} in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;
  const mainMatch = (config: string) =>
    sql`${schema.chunk.searchVector} @@ to_tsquery(${config}::regconfig, ${tsquery})`;
  const mainRank = (config: string) =>
    sql`ts_rank(${schema.chunk.searchVector}, to_tsquery(${config}::regconfig, ${tsquery}))`;

  const matches = tsquery
    ? sql`(${sql.join(
        groups.map(([config, ids]) =>
          cjkQuery
            ? sql`(${versionIn(ids)} and (${mainMatch(config)} or ${schema.chunk.searchVectorCjk} @@ to_tsquery('simple', ${cjkQuery})))`
            : sql`(${versionIn(ids)} and ${mainMatch(config)})`,
        ),
        sql` or `,
      )})`
    : null;
  const mainRankOf =
    groups.length === 1
      ? mainRank(groups[0]![0])
      : sql`(case ${sql.join(
          groups.map(([config, ids]) => sql`when ${versionIn(ids)} then ${mainRank(config)}`),
          sql` `,
        )} else 0 end)`;
  const rank = tsquery
    ? cjkQuery
      ? sql`${mainRankOf} + ts_rank(${schema.chunk.searchVectorCjk}, to_tsquery('simple', ${cjkQuery}))`
      : mainRankOf
    : null;

  const keyword =
    matches && rank
      ? await database
          .select({
            id: schema.chunk.id,
            body: schema.chunk.body,
            tokens: schema.chunk.tokens,
            citation: schema.chunk.citation,
            assetId: schema.chunk.assetId,
            versionId: schema.chunk.versionId,
          })
          .from(schema.chunk)
          .where(and(scopedTo(members), matches))
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
  const sameSpace = embeddings
    ? members.filter(
        (member) =>
          member.version.embeddingModel === embeddings.model &&
          member.version.embeddingDimensions === embeddings.dimensions,
      )
    : [];
  if (embeddings && sameSpace.length > 0) {
    const [queryVector] = await embeddings.embed([target.query]);
    if (queryVector) {
      const literal = `[${queryVector.join(',')}]`;
      semantic = await database
        .select({
          id: schema.chunk.id,
          body: schema.chunk.body,
          tokens: schema.chunk.tokens,
          citation: schema.chunk.citation,
          assetId: schema.chunk.assetId,
          versionId: schema.chunk.versionId,
          distance: sql<number>`${schema.chunk.embedding} <=> ${literal}::vector`,
        })
        .from(schema.chunk)
        .where(scopedTo(sameSpace))
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
  const nearestFaq = semantic.find((row) => row.citation.kind === 'faq');
  const confidence: RetrievalConfidence = {
    bestDistance: semantic.length > 0 ? Number(semantic[0]!.distance) : null,
    faqNearest: nearestFaq ? { chunkId: nearestFaq.id, distance: Number(nearestFaq.distance) } : null,
    keywordHits: keyword.length,
    /* What the best-ranked keyword chunks hold of the question itself; the
       head of the list is enough, ts_rank put the fullest matches there. */
    keywordEvidence:
      keyword.length > 0
        ? keywordEvidenceOf(
            target.query,
            keyword.slice(0, KEYWORD_EVIDENCE_CHUNKS).map((row) => row.body),
          )
        : null,
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
  const chunks: ScopedChunk[] = [];
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
      assetId: row.assetId,
      versionId: row.versionId,
    });
  }

  return { chunks, confidence };
}

/**
 * §9.1: every chunk read is scoped to pinned (asset, version) pairs, and
 * unsafe rows are excluded in the same predicate. One pair keeps the plain
 * equality the single-asset read always planned with.
 */
function scopedTo(members: readonly RankScopeMember[]) {
  const safe = sql`${schema.chunk.safetyStatus} not in ('quarantined', 'unsafe')`;
  if (members.length === 1) {
    return and(
      eq(schema.chunk.assetId, members[0]!.assetId),
      eq(schema.chunk.versionId, members[0]!.version.id),
      safe,
    );
  }
  return and(
    inArray(schema.chunk.assetId, members.map((member) => member.assetId)),
    inArray(schema.chunk.versionId, members.map((member) => member.version.id)),
    safe,
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
    ...(raw.kind === 'faq' ? { kind: 'faq' as const } : {}),
  };
}

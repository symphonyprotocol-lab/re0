/**
 * Library-level discovery: route a question to candidate libraries.
 * architecture.md 9.6.
 *
 * The display name is not the search key -- on a platform of user-uploaded
 * libraries it usually says nothing about the content ("昆虫大全" holds the
 * rove-beetle article). Recall therefore runs over the content-derived profile
 * (`library_profile`, written by the build's `profile` step), through up to
 * three paths that are fused by reciprocal rank:
 *
 *   1. profile FTS  -- the query's tokens against the pre-segmented profile
 *                      index (`simple` config; segmentation happened at build
 *                      and query time in the domain tokenizer, so CJK works);
 *   2. profile ANN  -- the query embedding against the centroid vectors, when
 *                      an embedding provider is configured. Semantic fallback
 *                      for synonyms and paraphrase;
 *   3. rare terms   -- the query's specific tokens against the chunk table's
 *                      own inverted indexes, bounded by a row-sample cap. The
 *                      paragraph-level net under the profile: a term that
 *                      lives in one chapter of one library reaches the
 *                      profile only if the extractor kept it, and this path
 *                      does not depend on that;
 *   4. name hint    -- optional `libraryName`, for Context7-style callers.
 *
 * Ranking folds in Trust/Benchmark deliberately (architecture.md 9.6: routing
 * over content invites entity-stuffing, and quality scores are the counter),
 * and every candidate carries evidence -- which titles and terms matched -- so
 * the calling agent can decide in one round without trusting the name.
 *
 * Recall is generous, so admission is a separate step (lib/domain/routing.ts):
 * a candidate stays only if some path found *evidence* -- a profile term,
 * a rare term in its chunks, a name hint, or a semantic match close enough to
 * stand alone. Without it, the nearest centroid of a one-library platform
 * answered every question, and the workspace policy filters candidates
 * before ranking (architecture.md 10.2: Library Search applies policy at the
 * metadata stage -- recall is content, admission is policy, and a blocked
 * library must not appear at all). The scatter-gather confirmation stage is
 * not here either, by design: it reads chunks, and lives in gather.ts on top
 * of query-docs.
 */
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { CallerContext } from './index';
import type { LibraryCandidate, ResolveLibraryInput, ResolveLibraryOutput } from '@/contracts/schemas';
import { routingTokens, searchTokens } from '@/lib/domain/profile';
import { containsCjk } from '@/lib/domain/cjk';
import { admitsCandidate, RARE_TERM_MAX_DOCUMENTS } from '@/lib/domain/routing';
import { pinPolicy, policyIsOpen, policyVerdicts } from '@/lib/application/policies';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { readableBy } from '@/lib/application/channels/visibility';
import type { EmbeddingAdapter } from '@/lib/infrastructure/ai/providers';
import {
  activeRetrievalSettings,
  type ActiveRetrievalSettings,
} from '@/lib/application/administration/manage-retrieval-config';
import { modelAdapters } from '@/lib/application/administration/manage-model-config';

export interface ResolveDependencies {
  /** Awaited, like the retrieval seam's: the model is a configuration row. */
  embeddings(): EmbeddingAdapter | Promise<EmbeddingAdapter>;
  configured(): { embeddings: boolean } | Promise<{ embeddings: boolean }>;
  /** The routing limits in force (lib/domain/retrieval-config.ts); see query-docs. */
  settings?(): Promise<ActiveRetrievalSettings>;
}

/** Per call, for the same reason as `defaultRetrievalDependencies`. */
function defaultDependencies(): ResolveDependencies {
  const { embeddings, configured } = modelAdapters();
  return { embeddings, configured, settings: activeRetrievalSettings };
}

/*
 * Three of the limits here are console settings (`routingRecallLimit`,
 * `routingRareSampleCap`, `routingResultLimit`), read per request:
 *
 * - recall width: the fusion sees at most this many per path;
 * - rare sample cap: the rare-term path reads at most this many chunk rows,
 *   whatever the term's frequency. That cap is the whole cost model
 *   (architecture.md 9.6): an inverted-index probe is priced by posting-list
 *   length, so a genuinely rare term is covered completely, and a common one
 *   stops at the sample instead of walking the corpus -- no word-frequency
 *   table needed to know which is which;
 * - result limit: candidates returned to the caller.
 */

/** Specific tokens per query; longest first, the rest add little. */
const RARE_TOKEN_CAP = 8;
/** Standard reciprocal-rank-fusion constant. */
const RRF_K = 60;
/**
 * How much a perfect quality score (Trust + Benchmark = 200) adds. Sized to a
 * fraction of one top rank step (1 / (RRF_K + 1)), so quality reorders
 * near-ties but a stuffed library cannot out-rank a genuine content match.
 */
const QUALITY_WEIGHT = 0.008;
/**
 * How much the keyword path's own relevance magnitude adds, normalised by the
 * query's best ts_rank. RRF alone keeps only positions, and positions lie
 * about distance: a profile matching four of the query's terms and one that
 * brushed a single common word sit in adjacent ranks, 0.0003 apart -- close
 * enough for the quality weight above to flip them. The magnitude term keeps
 * strong matches ahead of incidental ones by more than quality can bridge.
 */
const RELEVANCE_WEIGHT = 0.02;

const EVIDENCE_TERMS = 8;
const EVIDENCE_TITLES = 5;
/** Pinnable labels listed per candidate; the newest are the likely asks. */
const VERSION_LABELS = 10;

export async function resolveLibrary(
  caller: CallerContext,
  input: ResolveLibraryInput,
  dependencies: ResolveDependencies = defaultDependencies(),
): Promise<ResolveLibraryOutput> {
  const database = db();
  const settings = await (dependencies.settings ?? activeRetrievalSettings)();
  const visible = visibleTo(caller);
  /* Minus stopwords: "how do I use the" is evidence of nothing. */
  const tokens = routingTokens(input.query);

  /* ------------------------------------------------------- path 1: profile FTS */

  const tsquery = toTsquery(tokens);
  const keyword = tsquery
    ? await database
        .select({
          libraryId: schema.library.id,
          rank: sql<number>`ts_rank(${schema.libraryProfile.searchVector}, to_tsquery('simple', ${tsquery}))`,
        })
        .from(schema.library)
        .innerJoin(
          schema.libraryProfile,
          eq(schema.libraryProfile.versionId, schema.library.currentVersionId),
        )
        .where(
          and(
            visible,
            sql`${schema.libraryProfile.searchVector} @@ to_tsquery('simple', ${tsquery})`,
          ),
        )
        .orderBy(desc(sql`ts_rank(${schema.libraryProfile.searchVector}, to_tsquery('simple', ${tsquery}))`))
        .limit(settings.routingRecallLimit)
    : [];

  /* ------------------------------------------------------- path 2: profile ANN */

  let semantic: { libraryId: string; distance: number }[] = [];
  const embeddings = (await dependencies.configured()).embeddings
    ? await dependencies.embeddings()
    : null;
  if (embeddings) {
    const [queryVector] = await embeddings.embed([input.query]);
    if (queryVector) {
      const literal = `[${queryVector.join(',')}]`;
      semantic = await database
        .select({
          libraryId: schema.libraryProfileVector.libraryId,
          distance: sql<number>`min(${schema.libraryProfileVector.embedding} <=> ${literal}::vector)`,
        })
        .from(schema.libraryProfileVector)
        .innerJoin(
          schema.library,
          and(
            eq(schema.library.id, schema.libraryProfileVector.libraryId),
            /* Centroids of superseded versions must not route. */
            eq(schema.library.currentVersionId, schema.libraryProfileVector.versionId),
          ),
        )
        /*
         * Only centroids from the query's own vector space: the same model at
         * the same width, both frozen on the version (the guard query-docs
         * applies to chunks). The embedding model is a console save, and
         * after one every library keeps its old centroids until it rebuilds
         * -- padded to the same column width, so comparing across the change
         * raises no error and routes by nonsense. Those libraries still route
         * through the name and rare-term paths meanwhile.
         */
        .innerJoin(
          schema.libraryVersion,
          and(
            eq(schema.libraryVersion.id, schema.libraryProfileVector.versionId),
            eq(schema.libraryVersion.embeddingModel, embeddings.model),
            eq(schema.libraryVersion.embeddingDimensions, embeddings.dimensions),
          ),
        )
        .where(visible)
        .groupBy(schema.libraryProfileVector.libraryId)
        .orderBy(sql`min(${schema.libraryProfileVector.embedding} <=> ${literal}::vector)`)
        .limit(settings.routingRecallLimit);
    }
  }

  /* -------------------------------------------------------- path 3: rare terms */

  /*
   * The query's most specific tokens, probed against the chunk table's own
   * inverted indexes and grouped by library. This is what finds the term that
   * lives in one paragraph of one chapter: the profile only carries what the
   * extractor kept, the sample cap makes the probe affordable regardless, and
   * only chunks of a library's *current* version may route to it.
   */
  let rare: { libraryId: string }[] = [];
  const specific = specificTokens(tokens);
  const rareQuery = specific.length > 0 ? specific.map(rareTermQuery).join(' | ') : null;
  if (rareQuery) {
    const sampled = database
      .select({ libraryId: schema.chunk.libraryId })
      .from(schema.chunk)
      .innerJoin(
        schema.library,
        and(
          eq(schema.library.id, schema.chunk.libraryId),
          eq(schema.library.currentVersionId, schema.chunk.versionId),
        ),
      )
      .where(
        and(
          visible,
          sql`(${schema.chunk.searchVector} @@ to_tsquery('simple', ${rareQuery})
               or ${schema.chunk.searchVectorCjk} @@ to_tsquery('simple', ${rareQuery}))`,
        ),
      )
      .limit(settings.routingRareSampleCap)
      .as('sampled');

    rare = await database
      .select({
        libraryId: sampled.libraryId,
        hits: sql<number>`count(*)::int`,
      })
      .from(sampled)
      .groupBy(sampled.libraryId)
      .orderBy(desc(sql`count(*)`), sampled.libraryId)
      .limit(settings.routingRecallLimit);
  }

  /*
   * Which of those terms are actually rare. The sampled probe above ranks
   * libraries by how many chunks matched any specific term, which is fine
   * for order and useless for admission: "next" and "app" match chunks in
   * every technical corpus. So each term is probed on its own, reading at
   * most RARE_TERM_MAX_DOCUMENTS + 1 rows, and only a term that stops short
   * of that -- one that lives in a paragraph or two, platform-wide -- is
   * evidence for the libraries it lives in.
   */
  const rareEvidence = new Map<string, number>();
  /* Concurrently: one probe per term, up to RARE_TOKEN_CAP of them, with no
     data dependency between them -- awaited in turn they were that many
     round trips of pure latency on the routing path every question pays. */
  const probes = await Promise.all(
    specific.map((token) => {
      const query = rareTermQuery(token);
      const probe = database
        .select({ libraryId: schema.chunk.libraryId })
        .from(schema.chunk)
        .innerJoin(
          schema.library,
          and(
            eq(schema.library.id, schema.chunk.libraryId),
            eq(schema.library.currentVersionId, schema.chunk.versionId),
          ),
        )
        .where(
          and(
            visible,
            sql`(${schema.chunk.searchVector} @@ to_tsquery('simple', ${query})
               or ${schema.chunk.searchVectorCjk} @@ to_tsquery('simple', ${query}))`,
          ),
        )
        .limit(RARE_TERM_MAX_DOCUMENTS + 1)
        .as('probe');
      return database
        .select({ libraryId: probe.libraryId, hits: sql<number>`count(*)::int` })
        .from(probe)
        .groupBy(probe.libraryId);
    }),
  );

  for (const rows of probes) {
    const total = rows.reduce((sum, row) => sum + Number(row.hits), 0);
    if (total === 0 || total > RARE_TERM_MAX_DOCUMENTS) continue;
    for (const row of rows) {
      rareEvidence.set(row.libraryId, (rareEvidence.get(row.libraryId) ?? 0) + 1);
    }
  }

  /* -------------------------------------------------------- path 4: name hint */

  const named = input.libraryName
    ? await database
        .select({ libraryId: schema.library.id })
        .from(schema.library)
        .where(
          and(
            visible,
            or(
              sql`${schema.library.title} ilike ${`%${escapeLike(input.libraryName)}%`}`,
              sql`${schema.library.publicId} ilike ${`%${escapeLike(input.libraryName)}%`}`,
            ),
          ),
        )
        .orderBy(schema.library.publicId)
        .limit(settings.routingRecallLimit)
    : [];

  /* ------------------------------------------------------------------- fusion */

  const fused = new Map<string, number>();
  for (const list of [keyword, semantic, rare, named]) {
    list.forEach((row, index) => {
      fused.set(row.libraryId, (fused.get(row.libraryId) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  /* The keyword path also contributes its magnitude, not just its order. */
  const bestRank = keyword.reduce((best, row) => Math.max(best, Number(row.rank) || 0), 0);
  if (bestRank > 0) {
    for (const row of keyword) {
      fused.set(
        row.libraryId,
        (fused.get(row.libraryId) ?? 0) + ((Number(row.rank) || 0) / bestRank) * RELEVANCE_WEIGHT,
      );
    }
  }
  if (fused.size === 0) return { results: [], requestId: caller.requestId };

  /*
   * Admission (lib/domain/routing.ts): fusion ranks whatever recall
   * returned, and recall returns its nearest neighbours whatever the
   * distance. A candidate without evidence is not a weak match, it is no
   * match, and leaves here before policy, ranking or evidence assembly.
   */
  const profileRank = new Map(keyword.map((row) => [row.libraryId, Number(row.rank) || 0]));
  const centroid = new Map(semantic.map((row) => [row.libraryId, Number(row.distance)]));
  const namedIds = new Set(named.map((row) => row.libraryId));
  let candidateIds = [...fused.keys()].filter((id) =>
    admitsCandidate({
      profileRank: profileRank.get(id) ?? 0,
      centroidDistance: centroid.get(id) ?? null,
      rareTerms: rareEvidence.get(id) ?? 0,
      nameHint: namedIds.has(id),
    }),
  );
  if (candidateIds.length === 0) return { results: [], requestId: caller.requestId };

  /*
   * §10.2: policy admission at the metadata stage, over the bounded candidate
   * set and before any ranking or evidence assembly. Refused candidates
   * simply do not appear; the reason codes stay server side here, because a
   * search result is not the place to explain each absence.
   */
  if (caller.workspaceId) {
    const pinned = await pinPolicy(caller.workspaceId);
    if (!policyIsOpen(pinned.policy)) {
      const verdicts = await policyVerdicts(pinned.policy, candidateIds);
      candidateIds = candidateIds.filter((id) => verdicts.get(id)?.allowed !== false);
      if (candidateIds.length === 0) return { results: [], requestId: caller.requestId };
    }
  }

  const details = await database
    .select({
      libraryId: schema.library.id,
      publicId: schema.library.publicId,
      title: schema.library.title,
      description: schema.library.description,
      versionLabel: schema.libraryVersion.label,
      versionCreatedAt: schema.libraryVersion.createdAt,
      totalChunks: schema.libraryVersion.totalChunks,
      documentTitles: schema.libraryProfile.documentTitles,
      terms: schema.libraryProfile.terms,
    })
    .from(schema.library)
    .innerJoin(schema.libraryVersion, eq(schema.libraryVersion.id, schema.library.currentVersionId))
    .innerJoin(schema.libraryProfile, eq(schema.libraryProfile.versionId, schema.library.currentVersionId))
    .where(inArray(schema.library.id, candidateIds));

  const scores = await database
    .select({
      libraryId: schema.libraryScore.libraryId,
      trustScore: schema.libraryScore.trustScore,
      benchmarkScore: schema.libraryScore.benchmarkScore,
      computedAt: schema.libraryScore.computedAt,
    })
    .from(schema.libraryScore)
    .where(inArray(schema.libraryScore.libraryId, candidateIds))
    .orderBy(desc(schema.libraryScore.computedAt));

  const newestScore = new Map<string, { trust: number; benchmark: number }>();
  for (const row of scores) {
    if (!newestScore.has(row.libraryId)) {
      newestScore.set(row.libraryId, { trust: row.trustScore, benchmark: row.benchmarkScore });
    }
  }

  const tokenSet = new Set(tokens);
  const ranked = details
    .map((row) => {
      const quality = newestScore.get(row.libraryId) ?? { trust: 0, benchmark: 0 };
      return {
        row,
        quality,
        score:
          (fused.get(row.libraryId) ?? 0) +
          ((quality.trust + quality.benchmark) / 200) * QUALITY_WEIGHT,
      };
    })
    .sort(
      (a, b) => b.score - a.score || a.row.publicId.localeCompare(b.row.publicId),
    )
    .slice(0, settings.routingResultLimit);

  /*
   * The labels each returned library can be pinned to -- what
   * `pinLabeledVersion` accepts, so the list never offers one that would then
   * be refused. Read for the returned few only, after ranking.
   */
  const pinnable = await database
    .select({
      libraryId: schema.libraryVersion.libraryId,
      label: schema.libraryVersion.label,
    })
    .from(schema.libraryVersion)
    .where(
      and(
        inArray(
          schema.libraryVersion.libraryId,
          ranked.map(({ row }) => row.libraryId),
        ),
        inArray(schema.libraryVersion.indexStatus, ['ready', 'stale']),
      ),
    )
    .orderBy(desc(schema.libraryVersion.createdAt));
  const versionsOf = new Map<string, string[]>();
  for (const row of pinnable) {
    const labels = versionsOf.get(row.libraryId) ?? [];
    if (labels.length < VERSION_LABELS) labels.push(row.label);
    versionsOf.set(row.libraryId, labels);
  }

  const results: LibraryCandidate[] = ranked.map(({ row, quality }) => ({
    libraryId: row.publicId,
    title: row.title,
    description: row.description,
    version: row.versionLabel,
    versions: versionsOf.get(row.libraryId) ?? [row.versionLabel],
    trustScore: quality.trust,
    benchmarkScore: quality.benchmark,
    chunks: row.totalChunks,
    updatedAt: row.versionCreatedAt.toISOString(),
    evidence: {
      matchedTitles: row.documentTitles
        .filter((title) => searchTokens(title).some((token) => tokenSet.has(token)))
        .slice(0, EVIDENCE_TITLES),
      matchedTerms: row.terms.filter((term) => tokenSet.has(term)).slice(0, EVIDENCE_TERMS),
    },
  }));

  return { results, requestId: caller.requestId };
}

/**
 * architecture.md 5.2 and 9.6: an invisible asset and a nonexistent one must
 * be indistinguishable, so invisibility is a recall predicate, never an
 * application-layer filter over recalled rows. Who may see what is
 * channels/visibility.ts's alone (agent-first-proposal.md 6.2).
 */
export function visibleTo(caller: Pick<CallerContext, 'workspaceId'>): SQL {
  const routable = and(
    eq(schema.library.lifecycleStatus, 'published'),
    eq(schema.library.indexStatus, 'ready'),
    isNotNull(schema.library.currentVersionId),
    /* Implied by the three above for a tombstone; stated so it stays true. */
    isNull(schema.library.deletedAt),
  )!;
  return and(routable, readableBy(caller.workspaceId))!;
}

/**
 * An OR-query over the segmented tokens. `plainto_tsquery` would AND them,
 * and a natural-language question rarely has every token in one profile --
 * or in one chunk (query-docs recalls with this too, through the version's
 * own configuration, which still stems each quoted token). Tokens are quoted
 * for `to_tsquery`, with quote characters stripped first.
 */
export function toTsquery(tokens: readonly string[]): string | null {
  const safe = tokens
    .map((token) => token.replace(/['\\]/g, ''))
    .filter((token) => token.length > 0)
    .map((token) => `'${token}'`);
  return safe.length > 0 ? safe.join(' | ') : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * The query's specific tokens: the ones long enough to carry routing signal
 * on their own. Han grams of three or more characters, latin words of three
 * or more -- stopwords are already gone, so "eth" and "evm" qualify, and
 * whether a word is *rare* is measured against the corpus, not its length.
 * Longest first, capped: past a handful the rest add little.
 */
function specificTokens(tokens: readonly string[]): string[] {
  return tokens
    .map((token) => token.replace(/['\\]/g, ''))
    .filter((token) => token.length >= 3)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, RARE_TOKEN_CAP);
}

/**
 * One specific token as a tsquery. A Han gram is rewritten as a phrase of
 * its consecutive bigrams (「影翅虫」 becomes 影翅 <-> 翅虫), which is exactly
 * how the CJK chunk index stores text -- adjacent bigram positions -- so the
 * phrase matches the precise character sequence. Latin tokens are quoted
 * as-is; rare identifiers stem to themselves, and a stemmed miss only costs
 * this one path its vote.
 */
function rareTermQuery(token: string): string {
  if (!containsCjk(token)) return `'${token}'`;
  const bigrams: string[] = [];
  /* By code point: slicing UTF-16 units would split astral Han characters. */
  const chars = Array.from(token);
  for (let at = 0; at + 2 <= chars.length; at += 1) {
    bigrams.push(`'${chars[at]!}${chars[at + 1]!}'`);
  }
  return `(${bigrams.join(' <-> ')})`;
}

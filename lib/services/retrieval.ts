/**
 * Retrieval (rebuild-proposal.md 5): a Ree's passages for a question, by
 * meaning and by keyword, fused; and the question's embedding, shared by
 * posts, follow-ups, private posts, 试问, MCP and discovery.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { RETRIEVAL_KEYWORD_ROWS, RETRIEVAL_OVERVIEWS_MAX, RETRIEVAL_RECALL, RETRIEVAL_TOP_K } from '@/lib/constants';
import type { Passage } from '@/lib/domain/answer';
import { rewriteTarget, scriptOf } from '@/lib/domain/cross-lingual';
import { fuse, hasEvidence, isLibraryQuestion, isWordTerm, keywordCoverage, overviewText, searchTerms, wordPattern, type Ranked } from '@/lib/domain/retrieval';
import { embedTexts } from '@/lib/infra/ai/models';
import { db, schema } from '@/lib/infra/db';
import { chunkVector, spaceOf } from '@/lib/services/embedding-space';
import type { Rewriter } from '@/lib/services/question-rewrite';

export interface Retrieval {
  passages: Passage[];
  evidence: boolean;
  bestSimilarity: number | null;
  model: string;
  /** The rewrite searched in the question's place, when the knowledge near it is in another language (cross-lingual.ts). */
  rewrite: string | null;
}

/** Passages answers may use: ready, enabled ("参与回答") and not in the trash (8.2). Explore's second level uses the same. */
export function answerable(): SQL[] {
  return [eq(schema.knowledge.status, 'ready'), eq(schema.knowledge.enabled, true), isNull(schema.knowledge.deletedAt)];
}

type Recalled = Omit<Passage, 'chunkId' | 'similarity'> & { id: string };

/**
 * The vector leg: an exact scan of the Ree's own passages (the `+ 0` keeps
 * the planner off the global HNSW index, which filters after it searches
 * and can miss a small Ree's rows entirely), nearest first.
 */
async function semanticRecall(reeId: string, embedded: QuestionVector): Promise<(Recalled & { similarity: number })[]> {
  const literal = `[${embedded.vector.join(',')}]`;
  /* Only passages with a vector in the question's space: never a comparison across models (embedding-space.ts). */
  const stored = chunkVector(embedded.space);
  const rows = await db()
    .select({
      id: schema.chunk.id,
      knowledgeId: schema.chunk.knowledgeId,
      content: schema.chunk.content,
      locator: schema.chunk.locator,
      title: schema.knowledge.title,
      kind: schema.knowledge.kind,
      similarity: sql<number>`1 - (${stored} <=> ${literal}::vector)`,
    })
    .from(schema.chunk)
    .innerJoin(schema.knowledge, eq(schema.knowledge.id, schema.chunk.knowledgeId))
    .where(and(eq(schema.chunk.reeId, reeId), ...answerable(), sql`${stored} is not null`))
    /* Equal distances by id, so a tie across the limit reads the same rows every time. */
    .orderBy(sql`(${stored} <=> ${literal}::vector) + 0`, schema.chunk.id)
    .limit(RETRIEVAL_RECALL);
  return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
}

/**
 * The keyword leg: the passages holding the largest share of `terms`, word
 * for word. The rows read are those matching the most terms (not the first
 * that match any): a term found in nearly every passage -- the product's own
 * name in its docs -- must not fill the read with passages that have
 * nothing else.
 *
 * Every passage of the Ree is looked at once (no index; see below): lowered
 * once (`offset 0` keeps the planner from inlining it into every term), and
 * rejected before any scoring unless one term appears in it at all. Only a
 * term that does appear is then tested as a whole word, with the same
 * pattern `keywordCoverage` uses, so "set" does not count "settings" and the
 * rows read are ranked by what is scored afterwards. Ties go by id, so the
 * same question reads the same rows.
 *
 * A trigram index would spare the scan, but production migrations run in one
 * transaction, where `create index concurrently` cannot, and a plain build
 * would hold up writes to `chunk` for the whole build.
 */
async function keywordRecall(reeId: string, terms: readonly string[]): Promise<(Recalled & { coverage: number })[]> {
  if (terms.length === 0) return [];
  const c = schema.chunk;
  const k = schema.knowledge;
  const present = (term: string) => sql`strpos(lowered.text, ${term}) > 0`;
  const hits = sql.join(
    terms.map((term) => (isWordTerm(term) ? sql`(case when ${present(term)} then (lowered.text ~ ${wordPattern(term)})::int else 0 end)` : sql`(${present(term)})::int`)),
    sql` + `,
  );
  const result = await db().execute<Recalled & { hits: number }>(sql`
    select * from (
      select ${c.id} as id, ${c.knowledgeId} as "knowledgeId", ${c.content} as content, ${c.locator} as locator, ${k.title} as title, ${k.kind} as kind, ${hits} as hits
      from ${c}
      inner join ${k} on ${k.id} = ${c.knowledgeId}
      cross join lateral (select lower(${c.content}) as text offset 0) as lowered
      where ${and(eq(c.reeId, reeId), ...answerable())} and (${sql.join(terms.map(present), sql` or `)})
    ) as matched
    where hits > 0
    order by hits desc, id
    limit ${RETRIEVAL_KEYWORD_ROWS}`);
  return result.rows
    .map(({ hits: _hits, ...row }) => ({ ...row, coverage: keywordCoverage(terms, row.content) }))
    .filter((row) => row.coverage > 0)
    .sort((a, b) => b.coverage - a.coverage)
    .slice(0, RETRIEVAL_RECALL);
}

/**
 * The question's own keyword matches still worth ranking once it is searched
 * as a rewrite: passages in the question's own script that hold at least one
 * of its own-script terms word for word. In a Ree with knowledge in both
 * languages these are its direct matches; a passage in the other language
 * that only shares the product's name never is, so it cannot tip rank
 * fusion's near-ties again. They are ranked by both of the question's own
 * legs, as the rewrite's passages are by both of its: with one vote against
 * two, a direct match fell below passages holding nothing but the product's
 * name.
 */
function ownMatches<T extends { content: string }>(question: string, terms: readonly string[], keyword: readonly T[]): T[] {
  const script = scriptOf(question);
  const own = terms.filter((term) => scriptOf(term) === script);
  if (!script || own.length === 0) return [];
  return keyword.filter((row) => scriptOf(row.content) === script && keywordCoverage(own, row.content) > 0);
}

/**
 * Vector and keyword recall over this Ree's ready passages, fused by rank.
 * With `rewrite`, a question whose recall is nearly all in another language
 * (a Chinese question over English docs) is searched again as its rewrite
 * into that language, and the rewrite's two legs rank the passages, with
 * the question's own direct matches in its own language (`ownMatches`),
 * ranked by its own two legs.
 * The rest of its own legs only matched the product's name in every
 * passage, and even at a fraction of the weight they tip rank fusion's
 * near-ties towards those (cross-lingual.ts). Whatever was evidence as
 * asked still is, and the question's own legs stand in should both of the
 * rewrite's come back empty.
 */
export async function retrieve(reeId: string, question: string, embedded?: QuestionVector, options: { rewrite?: Rewriter } = {}): Promise<Retrieval> {
  const asked = embedded ?? (await embedQuestion(question));
  const terms = searchTerms(question);
  const [semantic, keyword] = await Promise.all([semanticRecall(reeId, asked), keywordRecall(reeId, terms)]);

  const target = options.rewrite ? rewriteTarget(question, semantic.map((row) => row.content)) : null;
  const rewrite = target ? await options.rewrite!(target) : null;
  /* A model switch between the two embeddings leaves the rewrite's vector in another space: its keyword leg still counts. */
  const [again, rewriteKeyword] = rewrite
    ? await Promise.all([rewrite.vector && rewrite.vector.space === asked.space ? semanticRecall(reeId, rewrite.vector) : [], keywordRecall(reeId, rewrite.terms)])
    : [[], []];
  const searched = rewrite && (again.length > 0 || rewriteKeyword.length > 0) ? rewrite : null;
  const own = searched ? ownMatches(question, terms, keyword) : [];
  const ownIds = new Set(own.map((row) => row.id));
  const byVector = (rows: readonly { id: string; similarity: number }[]): Ranked[] => rows.map((row) => ({ id: row.id, score: row.similarity }));
  const byWords = (rows: readonly { id: string; coverage: number }[]): Ranked[] => rows.map((row) => ({ id: row.id, score: row.coverage }));
  const lists = searched
    ? [byVector(again), byWords(rewriteKeyword), byWords(own), byVector(semantic.filter((row) => ownIds.has(row.id)))]
    : [byVector(semantic), byWords(keyword)];

  const byId = new Map<string, Recalled & { similarity: number }>();
  for (const row of [...semantic, ...again]) {
    const seen = byId.get(row.id);
    if (!seen || row.similarity > seen.similarity) byId.set(row.id, row);
  }
  for (const row of [...keyword, ...rewriteKeyword]) if (!byId.has(row.id)) byId.set(row.id, { ...row, similarity: 0 });
  const order = fuse(lists.filter((list) => list.length > 0)).slice(0, RETRIEVAL_TOP_K);
  const passages: Passage[] = order.map((id) => {
    const row = byId.get(id)!;
    return {
      chunkId: id,
      knowledgeId: row.knowledgeId,
      title: row.title,
      kind: row.kind,
      content: row.content,
      locator: row.locator,
      similarity: row.similarity,
    };
  });
  const nearest = [semantic[0]?.similarity, again[0]?.similarity].filter((value): value is number => value !== undefined);
  const bestSimilarity = nearest.length ? Math.max(...nearest) : null;
  /* As asked, or as rewritten: a rewrite only ever adds evidence. */
  const evidence =
    passages.length > 0 &&
    (hasEvidence({ bestSimilarity, bestCoverage: keyword[0]?.coverage ?? 0, terms: terms.length }) ||
      (searched !== null && hasEvidence({ bestSimilarity, bestCoverage: rewriteKeyword[0]?.coverage ?? 0, terms: searched.terms.length })));
  const model = asked.model;
  const rewritten = searched ? searched.query || searched.terms.join(' ') : null;
  /* A question about the sources themselves also sees each source whole, the closest sources first. */
  if (isLibraryQuestion(question)) {
    const overviews = await sourceOverviews(reeId, [...new Set([...semantic, ...again].map((row) => row.knowledgeId))]);
    if (overviews.length) return { passages: [...overviews, ...passages], bestSimilarity, evidence: true, model, rewrite: rewritten };
  }
  return { passages, bestSimilarity, evidence, model, rewrite: rewritten };
}

/** Characters read from each end of a source to build its overview (more than the overview keeps). */
const OVERVIEW_READ_CHARS = 2000;

/**
 * Overviews of a Ree's answerable sources, built from the stored text at
 * question time (nothing to keep in sync, nothing to backfill): the sources
 * recall ranked first, then the most recently updated.
 */
export async function sourceOverviews(reeId: string, ranked: readonly string[]): Promise<Passage[]> {
  const k = schema.knowledge;
  const rows = await db()
    .select({
      id: k.id,
      title: k.title,
      kind: k.kind,
      chars: sql<number>`char_length(coalesce(${k.content}, ''))`,
      head: sql<string>`left(coalesce(${k.content}, ''), ${OVERVIEW_READ_CHARS})`,
      tail: sql<string>`right(coalesce(${k.content}, ''), ${OVERVIEW_READ_CHARS})`,
      parts: sql<number>`jsonb_array_length(coalesce(${k.children}, '[]'::jsonb))`,
      seconds: sql<number | null>`case when ${k.kind} = 'audio' then (${k.children} -> -1 ->> 'end')::float end`,
      labels: sql<string[] | null>`case when ${k.kind} in ('github', 'site') then (select jsonb_agg(c ->> 'label') from (select jsonb_array_elements(${k.children}) as c limit 20) as first) end`,
    })
    .from(k)
    .where(and(eq(k.reeId, reeId), ...answerable()))
    .orderBy(ranked.length ? sql`case when ${inArray(k.id, [...ranked])} then 0 else 1 end` : sql`1`, desc(k.updatedAt))
    .limit(RETRIEVAL_OVERVIEWS_MAX);
  const rank = (id: string) => (ranked.includes(id) ? ranked.indexOf(id) : ranked.length);
  return rows
    .filter((row) => row.chars > 0)
    .sort((a, b) => rank(a.id) - rank(b.id))
    .map((row) => ({
      chunkId: `overview:${row.id}`,
      knowledgeId: row.id,
      title: row.title,
      kind: row.kind,
      content: overviewText({
        kind: row.kind,
        chars: Number(row.chars),
        parts: Number(row.parts),
        seconds: row.seconds === null ? null : Number(row.seconds),
        labels: row.labels,
        head: row.head,
        tail: row.tail,
      }),
      locator: { overview: true },
      similarity: 0,
    }));
}

export interface QuestionVector {
  vector: number[];
  model: string;
  /** The embedding space `vector` is in; retrieval compares it with that space's vectors only. */
  space: string;
}

/** One embedding per question, shared by every asked Ree and by the suggestions. */
export async function embedQuestion(question: string): Promise<QuestionVector> {
  const { vectors, endpoint } = await embedTexts([question]);
  return { vector: vectors[0]!, model: endpoint.model, space: spaceOf(endpoint) };
}


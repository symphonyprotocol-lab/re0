/**
 * Finding a Ree with a question (rebuild-proposal.md 2.4):
 *
 *   1. the profile table, one HNSW search, gives the 20 Rees whose profile
 *      is nearest the question;
 *   2. passages are searched only inside those 20 Rees -- the same
 *      "answerable" passages a Ree answers from -- 50 of them;
 *   3. per Ree, the best passage's similarity times the Ree's quality, ties
 *      to the owner's role; the top 10, each with that passage as its excerpt.
 *
 * Without a question, the public Rees most active in the last 30 days. Only
 * retrieval, no generation: nothing is charged, but searches are counted
 * per IP and per account. The cards' figures are other people's questions
 * only, so an owner testing their own Ree does not move them.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  EMBEDDING_DIMENSIONS,
  EXPLORE_EF_SEARCH,
  EXPLORE_INDEX_CHECK_MS,
  EXPLORE_NAME_REES,
  EXPLORE_PASSAGE_EF_SEARCH,
  EXPLORE_PASSAGE_SCAN_MAX,
  EXPLORE_PASSAGES,
  EXPLORE_PROFILE_REES,
  EXPLORE_RATE_LIMIT,
  EXPLORE_RESULTS,
  EXPLORE_VECTOR_CACHE_MS,
  EXPLORE_VECTOR_CACHE_SIZE,
  PROFILE_MAX_VECTORS,
  QUERY_BASE_FEE,
  type ReeCategory,
} from '@/lib/constants';
import type { SuggestedRee } from '@/lib/domain/chat-message';
import {
  decodeExploreCursor,
  encodeExploreCursor,
  excerptOf,
  nameBoost,
  nameMatch,
  NEUTRAL_QUALITY,
  queryNameKeys,
  positiveRate,
  rankHits,
  type ExploreBatch,
  type ExploreKey,
  type ExploreQuery,
  type ExploreSort,
} from '@/lib/domain/explore';
import { isUuid } from '@/lib/domain/list';
import { hasEvidence, keywordCoverage, searchTerms } from '@/lib/domain/retrieval';
import { db, schema } from '@/lib/infra/db';
import { embedQuestion, type QuestionVector } from '@/lib/services/chat';
import { BASE_SPACE, chunkVector, profileInSpace, spaceOf } from '@/lib/services/embedding-space';
import { endpointFor } from '@/lib/infra/ai/models';
import type { IntroProps } from '@/lib/domain/video';
import { introsFor } from '@/lib/services/video';
import { votesByOthers } from '@/lib/services/ree-feedback';
import { hitRateBucket } from '@/lib/services/rate-limit';
import { untimed, type Timing } from '@/lib/infra/timing';
import { SEARCH_INDEXES } from '@/lib/infra/search-indexes';

const reeId = sql.raw('"ree"."id"');
const reeOwner = sql.raw('"ree"."owner_id"');

/** Public: shown, not taken down, not deleted. */
export function publicRee(): SQL {
  return and(eq(schema.ree.isPublic, true), eq(schema.ree.isPublished, true), isNull(schema.ree.moderatedAt), isNull(schema.ree.deletedAt))!;
}

/** Ready, enabled sources (the count a public page and a card show; titles never). */
export const readySources = sql<number>`(select count(*)::int from ${schema.knowledge} k where k.ree_id = ${reeId} and k.status = 'ready' and k.enabled and k.deleted_at is null)`;
/** Successful answers to other people, all time, signed-out visitors' (anonymous-chat.ts) included. */
export const answersByOthers = sql<number>`((select count(*)::int from ${schema.message} m join ${schema.conversation} c on c.id = m.conversation_id where m.ree_id = ${reeId} and m.role = 'ree' and not m.no_answer and c.user_id <> ${reeOwner})
  + (select count(*)::int from ${schema.anonymousAnswer} aa where aa.ree_id = ${reeId}))`;

export interface ReeCard {
  id: string;
  slug: string;
  name: string;
  description: string;
  avatarBlob: string | null;
  coverBlob: string | null;
  color: string;
  category: string;
  tags: string[];
  ownerId: string;
  ownerName: string;
  role: 'normal' | 'verified' | 'official';
  queryFee: number;
  /** The advertised price of one answer: base fee plus query fee (the same for every viewer). */
  price: number;
  sources: number;
  answers: number;
  positiveRate: number | null;
  /** The matched passage, when the card answers a question. */
  excerpt: string | null;
  createdAt: Date;
  /** Pinned by an administrator; it leads Discover's default order and the home page. */
  pinned: boolean;
  /** Introduction when requested by the caller and available. */
  video: IntroProps | null;
}

const cardColumns = {
  id: schema.ree.id,
  slug: schema.ree.slug,
  name: schema.ree.name,
  description: schema.ree.description,
  avatarBlob: schema.ree.avatarBlob,
  coverBlob: schema.ree.coverBlob,
  color: schema.ree.color,
  category: schema.ree.category,
  tags: schema.ree.tags,
  ownerId: schema.ree.ownerId,
  ownerName: schema.user.name,
  role: schema.user.role,
  queryFee: schema.ree.queryFee,
  sources: readySources,
  answers: answersByOthers,
  up: votesByOthers('up'),
  down: votesByOthers('down'),
  createdAt: schema.ree.createdAt,
  pinned: sql<boolean>`${schema.ree.pinOrder} is not null`,
};

/** Every card query starts here; callers add the filter, order and page. */
function cardQuery() {
  return db().select(cardColumns).from(schema.ree).innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId));
}

type CardRow = Awaited<ReturnType<typeof cardQuery>>[number];

function toCard(row: CardRow, excerpt: string | null = null): ReeCard {
  const { up, down, ...rest } = row;
  return { ...rest, price: QUERY_BASE_FEE + row.queryFee, positiveRate: positiveRate(up, down), excerpt, video: null };
}

/** Step 7: each card's introduction, if it has one. */
async function withIntros(cards: ReeCard[]): Promise<ReeCard[]> {
  const intros = await introsFor(cards.map((card) => card.id));
  return cards.map((card) => ({ ...card, video: intros.get(card.id) ?? null }));
}

/** Cards for these public Rees, in the order given. */
export async function reeCards(
  ids: readonly string[],
  excerpts: ReadonlyMap<string, string> = new Map(),
  { includeIntros = true } = {},
): Promise<ReeCard[]> {
  if (ids.length === 0) return [];
  const rows = await cardQuery().where(and(inArray(schema.ree.id, [...ids]), publicRee()));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const cards = ids.map((id) => byId.get(id)).filter((row): row is CardRow => Boolean(row)).map((row) => toCard(row, excerpts.get(row.id) ?? null));
  return includeIntros ? withIntros(cards) : cards;
}

/* ------------------------------------------------------------- the search */

export interface SearchHit {
  reeId: string;
  similarity: number;
  quality: number;
  role: string;
  excerpt: string;
  /** The source the excerpt came from. */
  title: string;
  /** What the query naming this Ree adds to its score (`nameBoost`). */
  boost: number;
}

/* A Ree's public name and tags as one lowered string without spaces, dots, slashes, hyphens or underscores, for a coarse first look. */
const compactNameAndTags = sql`regexp_replace(lower(${schema.ree.name} || ' ' || array_to_string(${schema.ree.tags}, ' ')), '[[:space:]./_-]+', '', 'g')`;

/**
 * The public Rees a query names by their name or a tag ("nextjs" names
 * "Next.js Docs Assistant"), with what that adds to each one's score; the
 * strongest EXPLORE_NAME_REES. Public fields only, never knowledge or the
 * persona prompt.
 */
export async function namedRees(question: string, filter: { category?: ReeCategory | null; exclude: readonly string[] }): Promise<Map<string, number>> {
  const keys = queryNameKeys(question);
  if (!keys.length) return new Map();
  const rows = await db()
    .select({ id: schema.ree.id, name: schema.ree.name, tags: schema.ree.tags })
    .from(schema.ree)
    .where(
      and(
        publicRee(),
        filter.category ? eq(schema.ree.category, filter.category) : undefined,
        filter.exclude.length ? sql`${schema.ree.id} not in (${sql.join(filter.exclude.map((id) => sql`${id}::uuid`), sql`, `)})` : undefined,
        sql`${compactNameAndTags} like any (${sql`array[${sql.join(keys.map((key) => sql`${`%${key}%`}`), sql`, `)}]::text[]`})`,
      ),
    )
    .orderBy(schema.ree.id)
    .limit(200);
  return new Map(
    rows
      .map((row) => ({ id: row.id, boost: nameBoost(nameMatch(question, row)) }))
      .filter((row) => row.boost > 0)
      .sort((a, b) => b.boost - a.boost)
      .slice(0, EXPLORE_NAME_REES)
      .map((row) => [row.id, row.boost]),
  );
}

/** One vector slot of the chunk table: its column, its space tag (the base space when untagged, slot 0 only) and its HNSW index's expression. */
const SLOTS = [
  { vector: sql.raw('c.embedding'), inSpace: (space: string) => sql`coalesce(c.embedding_space, ${BASE_SPACE}::uuid) = ${space}::uuid` },
  { vector: sql.raw('c.embedding_next'), inSpace: (space: string) => sql`c.embedding_next_space = ${space}::uuid` },
] as const;

type Passage = { reeId: string; content: string; title: string; similarity: number };

/* Whether both search indexes are valid, as of at most EXPLORE_INDEX_CHECK_MS ago (per server instance). */
let indexCheck: { at: number; ready: Promise<boolean> } | null = null;

/** Both of Discover's passage indexes exist and are valid; false while they are missing, invalid or being built, or when the check fails. */
export async function searchIndexesReady(now = Date.now()): Promise<boolean> {
  if (indexCheck && now - indexCheck.at < EXPLORE_INDEX_CHECK_MS) return indexCheck.ready;
  const ready = db()
    .execute<{ valid: number }>(
      sql`select count(*)::int as valid from pg_index i join pg_class c on c.oid = i.indexrelid
        where c.relnamespace = 'public'::regnamespace and i.indisvalid and i.indisready
          and c.relname in (${sql.join(SEARCH_INDEXES.map((index) => sql`${index.name}`), sql`, `)})`,
    )
    .then(({ rows }) => Number(rows[0]?.valid ?? 0) === SEARCH_INDEXES.length)
    .catch(() => false);
  indexCheck = { at: now, ready };
  return ready;
}

/** Forgets the last index check (tests, and right after building the indexes in-process). */
export function forgetSearchIndexCheck(): void {
  indexCheck = null;
}

/**
 * The nearest answerable passages of `rees` to the question, nearest first,
 * at most `limit`.
 *
 * First through each vector slot's HNSW index (lib/infra/search-indexes.ts), on half-precision
 * copies, with an iterative scan so the filter still fills the list; the
 * similarity is then computed again on the stored vectors of the rows
 * found. Only those rows' vectors and texts are read -- not, as an exact
 * scan does, every passage of every candidate (some 50,000 vectors of
 * 6 KB, three times each, per search). The planner cannot tell how many
 * passages the space tag keeps, so it is told to skip the sort-everything
 * plan (`enable_sort`, `jit` off for the statement).
 *
 * An index scan gives up after EXPLORE_PASSAGE_SCAN_MAX entries; when that
 * leaves the list short, `rees` hold few passages near the question, and an
 * exact scan of them (all they have) is cheap. The exact scan is also the
 * answer when the index search fails, and the only search while either
 * index is missing or invalid (not built yet, or being built): without the
 * index, the "indexed" statement would sort every candidate passage anyway,
 * slower than the exact scan.
 */
async function nearestPassages(vector: QuestionVector, rees: readonly string[], limit: number): Promise<Passage[]> {
  if (!rees.length || limit < 1) return [];
  const search = passageSearch(vector, rees, limit);
  const toPassages = (rows: Passage[]) =>
    rows
      .map((row) => ({ ...row, similarity: Number(row.similarity) }))
      .sort((x, y) => y.similarity - x.similarity)
      .slice(0, limit);
  const indexed = (await searchIndexesReady())
    ? await db()
        .transaction(async (tx) => {
          await tx.execute(search.settings);
          const { rows } = await tx.execute<Passage>(search.indexed);
          return toPassages(rows);
        })
        .catch((error: unknown) => {
          /* Say, but answer: the exact scan below is the search before the indexes. */
          console.error(`explore: index search failed, scanning exactly (${error instanceof Error ? error.message : String(error)})`);
          return [];
        })
    : [];
  if (indexed.length >= limit) return indexed;
  const { rows } = await db().execute<Passage>(search.exact);
  return toPassages(rows);
}

/** `nearestPassages`' statements: the transaction's settings, the index search (one leg per slot), and the exact scan. Exported for the plan test. */
export function passageSearch(vector: QuestionVector, rees: readonly string[], limit: number): { settings: SQL; indexed: SQL; exact: SQL } {
  const literal = `[${vector.vector.join(',')}]`;
  const half = sql.raw(`halfvec(${EMBEDDING_DIMENSIONS})`);
  const inRees = sql`c.ree_id in (${sql.join(rees.map((id) => sql`${id}::uuid`), sql`, `)})`;
  /* `answerable()` (chat.ts) under the alias `k`. */
  const ready = sql`k.status = 'ready' and k.enabled and k.deleted_at is null`;
  const stored = chunkVector(vector.space, 'c');
  const columns = sql`c.ree_id as "reeId", c.content, k.title, 1 - (${stored} <=> ${literal}::vector) as similarity`;
  const legs = SLOTS.map(
    (slot) => sql`(select ${columns} from ${schema.chunk} c join ${schema.knowledge} k on k.id = c.knowledge_id
      where ${inRees} and ${ready} and ${slot.vector} is not null and ${slot.inSpace(vector.space)}
      order by ${slot.vector}::${half} <=> ${literal}::${half}
      limit ${limit})`,
  );
  return {
    settings: sql`select
      set_config('hnsw.ef_search', ${String(EXPLORE_PASSAGE_EF_SEARCH)}, true),
      set_config('hnsw.iterative_scan', 'relaxed_order', true),
      set_config('hnsw.max_scan_tuples', ${String(EXPLORE_PASSAGE_SCAN_MAX)}, true),
      set_config('enable_sort', 'off', true),
      set_config('jit', 'off', true)`,
    indexed: sql.join(legs, sql` union all `),
    exact: sql`
      select ${columns} from ${schema.chunk} c join ${schema.knowledge} k on k.id = c.knowledge_id
      where ${inRees} and ${ready} and ${stored} is not null
      order by (${stored} <=> ${literal}::vector) + 0
      limit ${limit}`,
  };
}

/**
 * The two levels. With a category or Rees to leave out, the first level
 * scans that slice of the profile table exactly (`+ 0` keeps the planner off
 * the global index, which filters after it searches); otherwise the HNSW
 * index answers, with a candidate list long enough for 20 Rees × 16 vectors.
 * Both levels read only vectors in the question's embedding space; right
 * after a model switch, profiles not yet rebuilt in the new space drop out
 * of the first level until `rebuildProfiles` reaches them (reembed.ts).
 *
 * A query that names a Ree (`namedRees`) brings it into the candidates
 * whatever its profile's distance, scores it with its nearest passage even
 * when that passage is not among the 50, and adds the name boost: a bare
 * product name puts that product's Ree first, while a question that only
 * mentions one keeps ranking mostly by its passages.
 *
 * The profile search and the name lookup run side by side, and so do the
 * 50 passages and each named Ree's own nearest one (`nearestPassages`);
 * `explore` starts the name lookup while the question is still being
 * embedded and hands it in as `named`.
 */
export async function searchRees(input: {
  question: string;
  vector: QuestionVector;
  category?: ReeCategory | null;
  exclude?: readonly string[];
  limit?: number;
  named?: Promise<Map<string, number>>;
  timing?: Pick<Timing, 'measure'>;
}): Promise<SearchHit[]> {
  const database = db();
  const timing = input.timing ?? untimed;
  const literal = `[${input.vector.vector.join(',')}]`;
  const exclude = (input.exclude ?? []).filter((id) => isUuid(id));
  /* A category can leave too few rows behind an index search; up to five excluded Rees only need a longer list (ef_search covers 25 × 16). */
  const filtered = Boolean(input.category);
  const distance = sql`${schema.reeProfileVector.embedding} <=> ${literal}::vector`;
  const [firstLevel, named] = await Promise.all([
    timing.measure('profiles', () =>
      database.transaction(async (tx) => {
        if (!filtered) await tx.execute(sql.raw(`set local hnsw.ef_search = ${EXPLORE_EF_SEARCH}`));
        const nearest = tx
          .select({ reeId: schema.reeProfileVector.reeId, distance: sql<number>`${distance}`.as('distance') })
          .from(schema.reeProfileVector)
          .innerJoin(schema.ree, eq(schema.ree.id, schema.reeProfileVector.reeId))
          .where(
            and(
              publicRee(),
              profileInSpace(input.vector.space),
              input.category ? eq(schema.ree.category, input.category) : undefined,
              exclude.length ? sql`${schema.ree.id} not in (${sql.join(exclude.map((id) => sql`${id}::uuid`), sql`, `)})` : undefined,
            ),
          )
          .orderBy(filtered ? sql`(${distance}) + 0` : distance)
          .limit((EXPLORE_PROFILE_REES + exclude.length) * PROFILE_MAX_VECTORS)
          .as('nearest');
        return tx
          .select({ reeId: nearest.reeId, similarity: sql<number>`max(1 - ${nearest.distance})` })
          .from(nearest)
          .groupBy(nearest.reeId)
          .orderBy(desc(sql`max(1 - ${nearest.distance})`))
          .limit(EXPLORE_PROFILE_REES);
      }),
    ),
    input.named ?? timing.measure('names', () => namedRees(input.question, { category: input.category, exclude })),
  ]);
  const candidates = [...new Set([...firstLevel.map((row) => row.reeId), ...named.keys()])];
  if (candidates.length === 0) return [];

  /*
   * The 50, and each named Ree's nearest passage, for a named Ree none of
   * whose passages makes the 50. Through the indexes both are quick, so they
   * run side by side; with exact scans only (indexes not built yet), the
   * named Rees' scans wait for the 50 and run only for those still missing.
   */
  const ownNearestOf = (ids: string[]) => timing.measure('named-passages', () => Promise.all(ids.map((id) => nearestPassages(input.vector, [id], 1))));
  const indexed = await searchIndexesReady();
  const [passages, early] = await Promise.all([
    timing.measure('passages', () => nearestPassages(input.vector, candidates, EXPLORE_PASSAGES)),
    indexed ? ownNearestOf([...named.keys()]) : Promise.resolve(null),
  ]);
  const ownNearest = early ?? (await ownNearestOf([...named.keys()].filter((id) => !passages.some((passage) => passage.reeId === id))));

  const terms = searchTerms(input.question);
  const best = new Map<string, { similarity: number; coverage: number; content: string; title: string }>();
  for (const passage of passages) {
    const coverage = keywordCoverage(terms, passage.content);
    const current = best.get(passage.reeId);
    if (!current) best.set(passage.reeId, { similarity: passage.similarity, coverage, content: passage.content, title: passage.title });
    else current.coverage = Math.max(current.coverage, coverage);
  }
  for (const [passage] of ownNearest) {
    if (passage && !best.has(passage.reeId)) {
      best.set(passage.reeId, { similarity: passage.similarity, coverage: keywordCoverage(terms, passage.content), content: passage.content, title: passage.title });
    }
  }
  if (best.size === 0) return [];
  const meta = await timing.measure('quality', () => database
    .select({ id: schema.ree.id, rank: schema.ree.rank, role: schema.user.role })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(inArray(schema.ree.id, [...best.keys()])));
  const hits: SearchHit[] = [];
  for (const row of meta) {
    const found = best.get(row.id)!;
    const boost = named.get(row.id) ?? 0;
    /* Being named is evidence enough that the Ree is about the query; it still needs a passage to answer from. */
    if (!boost && !hasEvidence({ bestSimilarity: found.similarity, bestCoverage: found.coverage, terms: terms.length })) continue;
    hits.push({ reeId: row.id, similarity: found.similarity, quality: row.rank.quality ?? NEUTRAL_QUALITY, role: row.role, excerpt: excerptOf(found.content, terms), title: found.title, boost });
  }
  return rankHits(hits, input.limit ?? EXPLORE_RESULTS);
}

/*
 * The question's vector, kept a few minutes per server instance: the same
 * words searched again (a shared link, back and forward, the next viewer)
 * skip the embedding call, the slowest step left. Only while the embedding
 * model and its space are still the active ones.
 */
const searchVectors = new Map<string, { at: number; vector: Promise<QuestionVector> }>();

async function searchVector(question: string, now = Date.now()): Promise<QuestionVector> {
  const kept = searchVectors.get(question);
  if (kept && now - kept.at < EXPLORE_VECTOR_CACHE_MS) {
    const [vector, endpoint] = await Promise.all([kept.vector, endpointFor('embedding')]);
    if (vector.model === endpoint.model && vector.space === spaceOf(endpoint)) return vector;
  }
  const vector = embedQuestion(question);
  searchVectors.delete(question);
  searchVectors.set(question, { at: now, vector });
  vector.catch(() => {
    if (searchVectors.get(question)?.vector === vector) searchVectors.delete(question);
  });
  /* Oldest first in a Map: past the limit, the oldest go. */
  for (const key of searchVectors.keys()) {
    if (searchVectors.size <= EXPLORE_VECTOR_CACHE_SIZE) break;
    searchVectors.delete(key);
  }
  return vector;
}

/** "这些公开 Ree 可能知道": the search's best public Rees, for a question nobody in the conversation could answer. */
export async function suggestRees(input: { question: string; vector: QuestionVector; viewerId: string; exclude: readonly string[]; limit: number }): Promise<SuggestedRee[]> {
  const hits = await searchRees({ question: input.question, vector: input.vector, exclude: input.exclude, limit: input.limit });
  const cards = await reeCards(hits.map((hit) => hit.reeId));
  return cards.map((card) => ({
    id: card.id,
    slug: card.slug,
    name: card.name,
    description: card.description,
    avatarBlob: card.avatarBlob,
    color: card.color,
    role: card.role,
    price: QUERY_BASE_FEE + (card.ownerId === input.viewerId ? 0 : card.queryFee),
  }));
}

/* --------------------------------------------------------------- the page */

export interface ExploreResult {
  mode: 'search' | 'browse';
  items: ReeCard[];
  /** Every Ree the list holds, not only this batch. */
  total: number;
  /** Where the next batch starts; null at the end of the list. */
  nextCursor: string | null;
}

/** Thrown for a `cursor` that is not one this list handed out. */
export class ExploreCursorError extends Error {
  constructor() {
    super('invalid_cursor');
  }
}

const activity = sql<number>`coalesce((${schema.ree.rank} ->> 'activity30')::int, 0)`;
/* Materialised hourly by `/api/cron/rank`: ordering by the live count aggregated every message of every public Ree per request. */
const answersRanked = sql<number>`coalesce((${schema.ree.rank} ->> 'answersAll')::int, 0)`;
const roleOrder = sql<number>`case ${schema.user.role} when 'official' then 2 when 'verified' then 1 else 0 end`;
/* Pinned first, lower `pin_order` first (negated, so it sorts descending with the rest); every unpinned Ree ties below them all. */
const pinKey = sql<number>`(-coalesce(${schema.ree.pinOrder}, 1000))`;
/* Microseconds, as stored: a JS Date would round them away and the next batch could repeat or skip a Ree created in the same millisecond. */
const createdKey = sql<string>`to_char(${schema.ree.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Each order's key, every part descending (the lowest fee as the highest
 * negated fee) so one row comparison finds where a batch ended: the leading
 * integers (`EXPLORE_KEY_PARTS`), then the creation time, then the id.
 * Only "推荐优先" puts pinned Rees first; the other two are plain sorts.
 */
const browseKeys: Record<ExploreSort, SQL[]> = {
  active: [pinKey, activity, roleOrder],
  answers: [answersRanked, roleOrder],
  free: [sql`(-${schema.ree.queryFee})`, roleOrder, activity],
};

function keyColumns(sort: ExploreSort): SQL[] {
  return [...browseKeys[sort], sql`${schema.ree.createdAt}`, sql`${schema.ree.id}`];
}

/** Rows strictly after the key a batch ended on. */
function afterKey(sort: ExploreSort, key: ExploreKey): SQL {
  const ints = browseKeys[sort].length;
  const values = key.map((part, at) => (at < ints ? sql`${part}::int` : at === ints ? sql`${part}::timestamptz` : sql`${part}::uuid`));
  return sql`(${sql.join(keyColumns(sort), sql`, `)}) < (${sql.join(values, sql`, `)})`;
}

/**
 * `/explore` and `GET /api/explore`. A question: the two-level search's top
 * 10, re-sorted when "回答最多" or "查询费最低" is chosen (prototype), all in
 * the first batch, never pinned. No question: public Rees, under "推荐优先"
 * the pinned ones first, then the most active in 30 days, the role only
 * breaking ties (8.2, "explore 排序"), a batch at a time after
 * the previous batch's key, so a list that changes while it scrolls neither
 * repeats nor shifts a card.
 */
export async function explore(
  query: ExploreQuery,
  batch: ExploreBatch,
  { includeIntros = true, timing = untimed }: { includeIntros?: boolean; timing?: Pick<Timing, 'measure'> } = {},
): Promise<ExploreResult> {
  if (query.q) {
    if (batch.cursor) return { mode: 'search', items: [], total: 0, nextCursor: null };
    /* The names need no vector: they are looked up while the question is embedded. */
    const named = timing.measure('names', () => namedRees(query.q, { category: query.category, exclude: [] }));
    /* Awaited inside searchRees; if the embedding fails first, its own failure must not go unhandled. */
    named.catch(() => {});
    const vector = await timing.measure('embed', () => searchVector(query.q));
    const hits = await searchRees({ question: query.q, vector, category: query.category, named, timing });
    let cards = await timing.measure('cards', () => reeCards(
      hits.map((hit) => hit.reeId),
      new Map(hits.map((hit) => [hit.reeId, hit.excerpt])),
      { includeIntros },
    ));
    if (query.sort === 'answers') cards = [...cards].sort((a, b) => b.answers - a.answers);
    if (query.sort === 'free') cards = [...cards].sort((a, b) => a.queryFee - b.queryFee);
    return { mode: 'search', items: cards, total: cards.length, nextCursor: null };
  }
  const key = batch.cursor ? decodeExploreCursor(query.sort, batch.cursor) : null;
  if (batch.cursor && !key) throw new ExploreCursorError();
  const where = and(publicRee(), query.category ? eq(schema.ree.category, query.category) : undefined);
  const [{ total } = { total: 0 }] = await db()
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.ree)
    .where(where);
  const keys = browseKeys[query.sort];
  const rows = await db()
    .select({ ...cardColumns, key: sql<ExploreKey>`json_build_array(${sql.join([...keys, createdKey, sql`${schema.ree.id}`], sql`, `)})` })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(and(where, key ? afterKey(query.sort, key) : undefined))
    .orderBy(...keyColumns(query.sort).map((column) => desc(column)))
    .limit(batch.size + 1);
  const more = rows.length > batch.size;
  const page = rows.slice(0, batch.size);
  const last = page.at(-1);
  const cards = page.map(({ key: _key, ...row }) => toCard(row));
  return {
    mode: 'browse',
    items: includeIntros ? await withIntros(cards) : cards,
    total,
    nextCursor: more && last ? encodeExploreCursor(query.sort, last.key) : null,
  };
}

/**
 * Discover's default order, pinned Rees first, then the most active, then the
 * newest. The home page's examples pass `officialOnly`: only Rees made by
 * official accounts, never a fallback to anyone else's.
 */
export async function activeRees(limit: number, { officialOnly = false }: { officialOnly?: boolean } = {}): Promise<ReeCard[]> {
  const rows = await cardQuery()
    .where(and(publicRee(), officialOnly ? eq(schema.user.role, 'official') : undefined))
    .orderBy(...keyColumns('active').map((column) => desc(column)))
    .limit(limit);
  return withIntros(rows.map((row) => toCard(row)));
}

/* ----------------------------------------------------------- rate limits */

export { clearRateBuckets, hitRateBucket } from '@/lib/services/rate-limit';

/** One free search against the IP's and the account's one-minute limits. */
export async function allowSearch(keys: { ip: string | null; userId: string | null }, now = new Date()): Promise<boolean> {
  const checks: [string, number][] = [];
  if (keys.ip) checks.push([`explore:ip:${keys.ip}`, EXPLORE_RATE_LIMIT.perIp]);
  if (keys.userId) checks.push([`explore:user:${keys.userId}`, EXPLORE_RATE_LIMIT.perUser]);
  let allowed = true;
  for (const [key, limit] of checks) {
    if (!(await hitRateBucket(key, limit, EXPLORE_RATE_LIMIT.windowSeconds, now))) allowed = false;
  }
  return allowed;
}

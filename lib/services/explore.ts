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
  EXPLORE_EF_SEARCH,
  EXPLORE_NAME_REES,
  EXPLORE_PASSAGES,
  EXPLORE_PROFILE_REES,
  EXPLORE_RATE_LIMIT,
  EXPLORE_RESULTS,
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
import { answerable, embedQuestion, type QuestionVector } from '@/lib/services/chat';
import { chunkVector, profileInSpace } from '@/lib/services/embedding-space';
import type { IntroProps } from '@/lib/domain/video';
import { introsFor } from '@/lib/services/video';
import { votesByOthers } from '@/lib/services/ree-feedback';
import { hitRateBucket } from '@/lib/services/rate-limit';

const reeId = sql.raw('"ree"."id"');
const reeOwner = sql.raw('"ree"."owner_id"');

/** Public: shown, not taken down, not deleted. */
export function publicRee(): SQL {
  return and(eq(schema.ree.isPublic, true), eq(schema.ree.isPublished, true), isNull(schema.ree.moderatedAt), isNull(schema.ree.deletedAt))!;
}

/** Ready, enabled sources (the count a public page and a card show; titles never). */
export const readySources = sql<number>`(select count(*)::int from ${schema.knowledge} k where k.ree_id = ${reeId} and k.status = 'ready' and k.enabled and k.deleted_at is null)`;
/** Successful answers to other people, all time. */
export const answersByOthers = sql<number>`(select count(*)::int from ${schema.message} m join ${schema.conversation} c on c.id = m.conversation_id where m.ree_id = ${reeId} and m.role = 'ree' and not m.no_answer and c.user_id <> ${reeOwner})`;

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
async function namedRees(question: string, filter: { category?: ReeCategory | null; exclude: readonly string[] }): Promise<Map<string, number>> {
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
 */
export async function searchRees(input: {
  question: string;
  vector: QuestionVector;
  category?: ReeCategory | null;
  exclude?: readonly string[];
  limit?: number;
}): Promise<SearchHit[]> {
  const database = db();
  const literal = `[${input.vector.vector.join(',')}]`;
  const exclude = (input.exclude ?? []).filter((id) => isUuid(id));
  /* A category can leave too few rows behind an index search; up to five excluded Rees only need a longer list (ef_search covers 25 × 16). */
  const filtered = Boolean(input.category);
  const distance = sql`${schema.reeProfileVector.embedding} <=> ${literal}::vector`;
  const firstLevel = await database.transaction(async (tx) => {
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
  });
  const named = await namedRees(input.question, { category: input.category, exclude });
  const candidates = [...new Set([...firstLevel.map((row) => row.reeId), ...named.keys()])];
  if (candidates.length === 0) return [];
  const stored = chunkVector(input.vector.space);

  const passages = await database
    .select({
      reeId: schema.chunk.reeId,
      content: schema.chunk.content,
      title: schema.knowledge.title,
      similarity: sql<number>`1 - (${stored} <=> ${literal}::vector)`,
    })
    .from(schema.chunk)
    .innerJoin(schema.knowledge, eq(schema.knowledge.id, schema.chunk.knowledgeId))
    .where(and(inArray(schema.chunk.reeId, candidates), ...answerable(), sql`${stored} is not null`))
    .orderBy(sql`(${stored} <=> ${literal}::vector) + 0`)
    .limit(EXPLORE_PASSAGES);

  const terms = searchTerms(input.question);
  const best = new Map<string, { similarity: number; coverage: number; content: string; title: string }>();
  for (const passage of passages) {
    const similarity = Number(passage.similarity);
    const coverage = keywordCoverage(terms, passage.content);
    const current = best.get(passage.reeId);
    if (!current) best.set(passage.reeId, { similarity, coverage, content: passage.content, title: passage.title });
    else current.coverage = Math.max(current.coverage, coverage);
  }
  /* A named Ree none of whose passages made the 50: its nearest one, for the score and the excerpt. */
  const unscored = [...named.keys()].filter((id) => !best.has(id));
  if (unscored.length) {
    const nearest = await database
      .selectDistinctOn([schema.chunk.reeId], {
        reeId: schema.chunk.reeId,
        content: schema.chunk.content,
        title: schema.knowledge.title,
        similarity: sql<number>`1 - (${stored} <=> ${literal}::vector)`,
      })
      .from(schema.chunk)
      .innerJoin(schema.knowledge, eq(schema.knowledge.id, schema.chunk.knowledgeId))
      .where(and(inArray(schema.chunk.reeId, unscored), ...answerable(), sql`${stored} is not null`))
      .orderBy(schema.chunk.reeId, sql`${stored} <=> ${literal}::vector`);
    for (const passage of nearest) {
      best.set(passage.reeId, { similarity: Number(passage.similarity), coverage: keywordCoverage(terms, passage.content), content: passage.content, title: passage.title });
    }
  }
  const meta = await database
    .select({ id: schema.ree.id, rank: schema.ree.rank, role: schema.user.role })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(inArray(schema.ree.id, [...best.keys()]));
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
  { includeIntros = true } = {},
): Promise<ExploreResult> {
  if (query.q) {
    if (batch.cursor) return { mode: 'search', items: [], total: 0, nextCursor: null };
    const vector = await embedQuestion(query.q);
    const hits = await searchRees({ question: query.q, vector, category: query.category });
    let cards = await reeCards(
      hits.map((hit) => hit.reeId),
      new Map(hits.map((hit) => [hit.reeId, hit.excerpt])),
      { includeIntros },
    );
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

/** The home page's examples: Discover's default order, pinned Rees first, then the most active. */
export async function activeRees(limit: number): Promise<ReeCard[]> {
  const rows = await cardQuery()
    .where(publicRee())
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

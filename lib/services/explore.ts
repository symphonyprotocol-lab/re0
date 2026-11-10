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
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  EXPLORE_EF_SEARCH,
  EXPLORE_PASSAGES,
  EXPLORE_PROFILE_REES,
  EXPLORE_RATE_LIMIT,
  EXPLORE_RESULTS,
  PROFILE_MAX_VECTORS,
  QUERY_BASE_FEE,
  type ReeCategory,
} from '@/lib/constants';
import type { SuggestedRee } from '@/lib/domain/chat-message';
import { excerptOf, NEUTRAL_QUALITY, positiveRate, rankHits, type ExploreQuery } from '@/lib/domain/explore';
import { clampPage, type ListResult } from '@/lib/domain/list';
import { hasEvidence, keywordCoverage, searchTerms } from '@/lib/domain/retrieval';
import { db, schema } from '@/lib/infra/db';
import { answerable, embedQuestion, type QuestionVector } from '@/lib/services/chat';
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
}

/**
 * The two levels. With a category or Rees to leave out, the first level
 * scans that slice of the profile table exactly (`+ 0` keeps the planner off
 * the global index, which filters after it searches); otherwise the HNSW
 * index answers, with a candidate list long enough for 20 Rees × 16 vectors.
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
  const exclude = (input.exclude ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
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
  const candidates = firstLevel.map((row) => row.reeId);
  if (candidates.length === 0) return [];

  const passages = await database
    .select({
      reeId: schema.chunk.reeId,
      content: schema.chunk.content,
      title: schema.knowledge.title,
      similarity: sql<number>`1 - (${schema.chunk.embedding} <=> ${literal}::vector)`,
    })
    .from(schema.chunk)
    .innerJoin(schema.knowledge, eq(schema.knowledge.id, schema.chunk.knowledgeId))
    .where(and(inArray(schema.chunk.reeId, candidates), ...answerable()))
    .orderBy(sql`(${schema.chunk.embedding} <=> ${literal}::vector) + 0`)
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
  const meta = await database
    .select({ id: schema.ree.id, rank: schema.ree.rank, role: schema.user.role })
    .from(schema.ree)
    .innerJoin(schema.user, eq(schema.user.id, schema.ree.ownerId))
    .where(inArray(schema.ree.id, [...best.keys()]));
  const hits: SearchHit[] = [];
  for (const row of meta) {
    const found = best.get(row.id)!;
    if (!hasEvidence({ bestSimilarity: found.similarity, bestCoverage: found.coverage, terms: terms.length })) continue;
    hits.push({ reeId: row.id, similarity: found.similarity, quality: row.rank.quality ?? NEUTRAL_QUALITY, role: row.role, excerpt: excerptOf(found.content, terms), title: found.title });
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

export interface ExploreResult extends ListResult<ReeCard> {
  mode: 'search' | 'browse';
}

const activity = sql<number>`coalesce((${schema.ree.rank} ->> 'activity30')::int, 0)`;
/* Materialised hourly by `/api/cron/rank`: ordering by the live count aggregated every message of every public Ree per request. */
const answersRanked = sql<number>`coalesce((${schema.ree.rank} ->> 'answersAll')::int, 0)`;
const roleOrder = sql<number>`case ${schema.user.role} when 'official' then 2 when 'verified' then 1 else 0 end`;

/**
 * `/explore` and `GET /api/explore`. A question: the two-level search's top
 * 10, re-sorted when "回答最多" or "查询费最低" is chosen (prototype). No
 * question: public Rees, most active in 30 days first, the role only
 * breaking ties (8.2, "explore 排序").
 */
export async function explore(query: ExploreQuery, { includeIntros = true } = {}): Promise<ExploreResult> {
  if (query.q) {
    const vector = await embedQuestion(query.q);
    const hits = await searchRees({ question: query.q, vector, category: query.category });
    let cards = await reeCards(
      hits.map((hit) => hit.reeId),
      new Map(hits.map((hit) => [hit.reeId, hit.excerpt])),
      { includeIntros },
    );
    if (query.sort === 'answers') cards = [...cards].sort((a, b) => b.answers - a.answers);
    if (query.sort === 'free') cards = [...cards].sort((a, b) => a.queryFee - b.queryFee);
    const page = clampPage(query.page, cards.length, query.size);
    return { mode: 'search', items: cards.slice((page - 1) * query.size, page * query.size), total: cards.length, page, size: query.size };
  }
  const where = and(publicRee(), query.category ? eq(schema.ree.category, query.category) : undefined);
  const [{ total } = { total: 0 }] = await db()
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.ree)
    .where(where);
  const page = clampPage(query.page, total, query.size);
  const order = {
    active: [desc(activity), desc(roleOrder), desc(schema.ree.createdAt)],
    answers: [desc(answersRanked), desc(roleOrder), desc(schema.ree.createdAt)],
    free: [asc(schema.ree.queryFee), desc(roleOrder), desc(activity), desc(schema.ree.createdAt)],
  }[query.sort];
  const rows = await cardQuery()
    .where(where)
    .orderBy(...order)
    .limit(query.size)
    .offset((page - 1) * query.size);
  const cards = rows.map((row) => toCard(row));
  return { mode: 'browse', items: includeIntros ? await withIntros(cards) : cards, total, page, size: query.size };
}

/** The most active public Rees (home page examples). */
export async function activeRees(limit: number): Promise<ReeCard[]> {
  const rows = await cardQuery()
    .where(publicRee())
    .orderBy(desc(activity), desc(roleOrder), desc(schema.ree.createdAt))
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

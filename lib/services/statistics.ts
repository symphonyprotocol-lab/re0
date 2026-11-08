/**
 * User-side statistics (8.2 "用户侧统计", prototype dot-statistics.js,
 * workspace.js, workspace-details.js) and the console's per-Ree tab.
 *
 * What counts:
 * - a successful answer is a `query_base` settlement in the ledger, one per
 *   answering Ree per question -- so clearing a test conversation keeps the
 *   usage, as in the prototype;
 * - a saved record is an answer message still on file (question, answer,
 *   first citation);
 * - query income is a `query_fee_earned` entry attributed to the Ree, never
 *   answers times the fee;
 * - sources are the current snapshot, not a figure of the period.
 */
import { and, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import type { CitationSnapshot } from '@/lib/domain/answer';
import { clampPage, likePattern, param, type ListResult } from '@/lib/domain/list';
import { fillBuckets, periodFilter, periodRange, trendBuckets, type PeriodFilter, type Range } from '@/lib/domain/statistics';
import { db, schema } from '@/lib/infra/db';
import { shareStatistics, type ShareStatistics } from '@/lib/services/share';

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

export interface SourceSummary {
  total: number;
  ready: number;
  processing: number;
  failed: number;
  paused: number;
}

/** A paused source counts as paused whatever its status (prototype `sourceSummary`). */
export const sourceState = sql<'ready' | 'processing' | 'failed' | 'paused'>`case
  when not "knowledge"."enabled" then 'paused'
  when "knowledge"."status" in ('ready', 'failed') then "knowledge"."status"
  else 'processing' end`;

export async function sourceSummary(reeIds: readonly string[]): Promise<SourceSummary> {
  const empty = { total: 0, ready: 0, processing: 0, failed: 0, paused: 0 };
  if (!reeIds.length) return empty;
  const rows = await db()
    .select({ state: sourceState, n: sql<number>`count(*)::int` })
    .from(schema.knowledge)
    .where(and(inArray(schema.knowledge.reeId, [...reeIds]), isNull(schema.knowledge.deletedAt)))
    .groupBy(sourceState);
  const summary = { ...empty };
  for (const row of rows) {
    summary[row.state] = row.n;
    summary.total += row.n;
  }
  return summary;
}

/* -------------------------------------------------------------- filters */

export const STATISTICS_VIEWS = ['answers', 'income'] as const;

export function statisticsQuery(params: Params, now = new Date()) {
  const size = Number(param(params, 'size'));
  const page = Number(param(params, 'page'));
  return {
    ...periodFilter(params, now),
    view: param(params, 'view') === 'income' ? ('income' as const) : ('answers' as const),
    q: param(params, 'q').trim().slice(0, 200),
    size: (LIST_PAGE_SIZES as readonly number[]).includes(size) ? size : LIST_PAGE_SIZES[0],
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}
export type StatisticsQuery = ReturnType<typeof statisticsQuery>;

function within(column: typeof schema.creditEntry.createdAt | typeof schema.message.createdAt | typeof schema.answerCheck.createdAt, range: Range | null): SQL[] {
  return range ? [gte(column, new Date(range.start)), lt(column, new Date(range.end))] : [];
}

/* -------------------------------------------------------- the pieces */

const answerEvents = (reeIds: readonly string[], range: Range | null) =>
  and(eq(schema.creditEntry.reason, 'query_base'), inArray(schema.creditEntry.reeId, [...reeIds]), ...within(schema.creditEntry.createdAt, range));

const incomeEntries = (reeIds: readonly string[], range: Range | null) =>
  and(eq(schema.creditEntry.reason, 'query_fee_earned'), inArray(schema.creditEntry.reeId, [...reeIds]), ...within(schema.creditEntry.createdAt, range));

/** Successful answers per Ree in a period. */
export async function answerCounts(reeIds: readonly string[], range: Range | null): Promise<Map<string, number>> {
  if (!reeIds.length) return new Map();
  const rows = await db()
    .select({ reeId: schema.creditEntry.reeId, n: sql<number>`count(distinct ${schema.creditEntry.refId})::int` })
    .from(schema.creditEntry)
    .where(answerEvents(reeIds, range))
    .groupBy(schema.creditEntry.reeId);
  return new Map(rows.map((row) => [row.reeId!, row.n]));
}

const savedAnswers = (reeIds: readonly string[], range: Range | null) =>
  and(eq(schema.message.role, 'ree'), eq(schema.message.noAnswer, false), inArray(schema.message.reeId, [...reeIds]), ...within(schema.message.createdAt, range));

/** Saved answers per Ree in a period. */
export async function savedCounts(reeIds: readonly string[], range: Range | null): Promise<Map<string, number>> {
  if (!reeIds.length) return new Map();
  const rows = await db()
    .select({ reeId: schema.message.reeId, n: sql<number>`count(*)::int` })
    .from(schema.message)
    .where(savedAnswers(reeIds, range))
    .groupBy(schema.message.reeId);
  return new Map(rows.map((row) => [row.reeId!, row.n]));
}

export interface AnswerRecord {
  id: string;
  reeId: string;
  reeName: string;
  question: string;
  answer: string;
  citation: CitationSnapshot | null;
  createdAt: Date;
}

const question = sql<string>`coalesce((select q.content from ${schema.message} q where q.id = "message"."request_id"), '')`;

export async function answerRecords(reeIds: readonly string[], range: Range | null, q: string, size: number, page: number): Promise<ListResult<AnswerRecord>> {
  if (!reeIds.length) return { items: [], total: 0, page: 1, size };
  const conditions = [savedAnswers(reeIds, range)!];
  if (q) {
    const pattern = likePattern(q);
    conditions.push(or(ilike(schema.message.content, pattern), sql`${question} ilike ${pattern}`, ilike(schema.ree.name, pattern))!);
  }
  const where = and(...conditions);
  const database = db();
  const [counted] = await database
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.message)
    .innerJoin(schema.ree, eq(schema.ree.id, schema.message.reeId))
    .where(where);
  const total = counted?.total ?? 0;
  const current = clampPage(page, total, size);
  const rows = await database
    .select({
      id: schema.message.id,
      reeId: schema.message.reeId,
      reeName: schema.ree.name,
      answer: schema.message.content,
      citations: schema.message.citations,
      createdAt: schema.message.createdAt,
      question,
    })
    .from(schema.message)
    .innerJoin(schema.ree, eq(schema.ree.id, schema.message.reeId))
    .where(where)
    .orderBy(desc(schema.message.createdAt), desc(schema.message.id))
    .limit(size)
    .offset((current - 1) * size);
  return {
    items: rows.map((row) => ({
      id: row.id,
      reeId: row.reeId!,
      reeName: row.reeName,
      question: row.question,
      answer: row.answer,
      citation: row.citations[0] ?? null,
      createdAt: row.createdAt,
    })),
    total,
    page: current,
    size,
  };
}

export interface IncomeRecord {
  id: string;
  amount: number;
  note: string | null;
  createdAt: Date;
}

async function incomeRecords(reeIds: readonly string[], range: Range | null, q: string, size: number, page: number): Promise<ListResult<IncomeRecord>> {
  const conditions = [incomeEntries(reeIds, range)!];
  if (q) conditions.push(ilike(schema.creditEntry.note, likePattern(q)));
  const where = and(...conditions);
  const database = db();
  const [counted] = await database.select({ total: sql<number>`count(*)::int` }).from(schema.creditEntry).where(where);
  const total = counted?.total ?? 0;
  const current = clampPage(page, total, size);
  const rows = await database
    .select({ id: schema.creditEntry.id, amount: schema.creditEntry.delta, note: schema.creditEntry.note, createdAt: schema.creditEntry.createdAt })
    .from(schema.creditEntry)
    .where(where)
    .orderBy(desc(schema.creditEntry.createdAt), desc(schema.creditEntry.id))
    .limit(size)
    .offset((current - 1) * size);
  return { items: rows, total, page: current, size };
}

/* ------------------------------------------------------- one Ree's page */

export interface ReeStatistics {
  filter: PeriodFilter;
  query: StatisticsQuery;
  answers: number;
  saved: number;
  sources: SourceSummary;
  income: number;
  trend: { grouping: 'hour' | 'day' | 'days'; bars: { start: number; end: number; value: number }[] } | null;
  answerList: ListResult<AnswerRecord> | null;
  incomeList: ListResult<IncomeRecord> | null;
  /** The share page `/s/[slug]` in the period: visits, visitors and the conversations it started. */
  share: ShareStatistics;
  /** 回答核验 in the period, for the owner only (ree-council-proposal.md 3.3). */
  checks: CheckFigures;
}

export interface CheckFigures {
  /** Answers whose check completed. */
  answers: number;
  /** Sentences with citations that were judged, and how many of them were not, or only partly, supported. */
  cited: number;
  unsupported: number;
  partial: number;
  /** Statements of fact without a citation. */
  uncited: number;
}

/**
 * What the checks of this Ree's answers in the period found, from the
 * tallies kept per check: clearing a test conversation does not take them
 * back, as it does not take back the answers counted.
 */
export async function checkFigures(reeId: string, range: Range | null): Promise<CheckFigures> {
  const sum = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)::int`;
  const [row] = await db()
    .select({
      answers: sql<number>`count(*)::int`,
      cited: sum(schema.answerCheck.cited),
      unsupported: sum(schema.answerCheck.unsupported),
      partial: sum(schema.answerCheck.partial),
      uncited: sum(schema.answerCheck.uncited),
    })
    .from(schema.answerCheck)
    .where(and(eq(schema.answerCheck.reeId, reeId), ...within(schema.answerCheck.createdAt, range)));
  return { answers: row?.answers ?? 0, cited: row?.cited ?? 0, unsupported: row?.unsupported ?? 0, partial: row?.partial ?? 0, uncited: row?.uncited ?? 0 };
}

/**
 * `/rees/[id]/statistics` and the console's statistics tab. `withIncome` is
 * false for an official owner on the user side: its income shows only in
 * the console (2.7).
 */
export async function reeStatistics(reeId: string, query: StatisticsQuery, options: { withIncome: boolean }): Promise<ReeStatistics> {
  const range = periodRange(query);
  const view = options.withIncome ? query.view : 'answers';
  const ids = [reeId];
  const database = db();
  const [answers, saved, sources, incomeRow, share, checks] = await Promise.all([
    answerCounts(ids, range),
    savedCounts(ids, range),
    sourceSummary(ids),
    options.withIncome
      ? database.select({ sum: sql<number>`coalesce(sum(${schema.creditEntry.delta}), 0)::bigint` }).from(schema.creditEntry).where(incomeEntries(ids, range))
      : Promise.resolve([{ sum: 0 }]),
    shareStatistics(reeId, range),
    checkFigures(reeId, range),
  ]);
  let trend: ReeStatistics['trend'] = null;
  if (range) {
    const { buckets, grouping } = trendBuckets(query);
    const points =
      view === 'income'
        ? await database.select({ at: schema.creditEntry.createdAt, value: schema.creditEntry.delta }).from(schema.creditEntry).where(incomeEntries(ids, range))
        : await database
            .select({ at: sql<Date>`min(${schema.creditEntry.createdAt})`, value: sql<number>`1` })
            .from(schema.creditEntry)
            .where(answerEvents(ids, range))
            .groupBy(schema.creditEntry.refId);
    const values = fillBuckets(
      buckets,
      points.map((point) => [new Date(point.at).getTime(), Number(point.value)] as const),
    );
    trend = { grouping, bars: buckets.map((bucket, index) => ({ ...bucket, value: values[index]! })) };
  }
  return {
    filter: query,
    query: { ...query, view },
    answers: answers.get(reeId) ?? 0,
    saved: saved.get(reeId) ?? 0,
    sources,
    income: Number(incomeRow[0]?.sum ?? 0),
    trend,
    answerList: view === 'answers' ? await answerRecords(ids, range, query.q, query.size, query.page) : null,
    incomeList: view === 'income' ? await incomeRecords(ids, range, query.q, query.size, query.page) : null,
    share,
    checks,
  };
}

/* ------------------------------------------------------------ workspace */

/** The owner's live Rees (the trash of Rees excluded), newest first. */
export async function ownedReeRows(ownerId: string) {
  return db()
    .select({ id: schema.ree.id, name: schema.ree.name, avatarBlob: schema.ree.avatarBlob, color: schema.ree.color, isPublic: schema.ree.isPublic, moderatedAt: schema.ree.moderatedAt })
    .from(schema.ree)
    .where(and(eq(schema.ree.ownerId, ownerId), isNull(schema.ree.deletedAt)))
    .orderBy(desc(schema.ree.createdAt));
}

export const WORKSPACE_SOURCE_STATES = ['all', 'ready', 'processing', 'failed', 'paused'] as const;
export const WORKSPACE_KINDS = ['all', 'document', 'audio', 'github', 'page', 'site', 'text'] as const;

export function workspaceQuery(params: Params, reeIds: readonly string[], answers: boolean, now = new Date()) {
  const size = Number(param(params, 'size'));
  const page = Number(param(params, 'page'));
  const pick = <T extends string>(name: string, values: readonly T[], fallback: T): T =>
    (values as readonly string[]).includes(param(params, name)) ? (param(params, name) as T) : fallback;
  return {
    ...(answers ? periodFilter(params, now) : { period: 'all' as const, date: '' }),
    ree: reeIds.includes(param(params, 'ree')) ? param(params, 'ree') : 'all',
    status: pick('status', WORKSPACE_SOURCE_STATES, 'all'),
    kind: pick('kind', WORKSPACE_KINDS, 'all'),
    view: pick('view', ['summary', 'records'] as const, 'summary'),
    q: param(params, 'q').trim().slice(0, 200),
    size: (LIST_PAGE_SIZES as readonly number[]).includes(size) ? size : LIST_PAGE_SIZES[0],
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
  };
}
export type WorkspaceQuery = ReturnType<typeof workspaceQuery>;

export interface WorkspaceSource {
  id: string;
  title: string;
  kind: string;
  state: 'ready' | 'processing' | 'failed' | 'paused';
  reeId: string;
  reeName: string;
  updatedAt: Date;
}

export async function workspaceSources(ownerId: string, query: WorkspaceQuery): Promise<ListResult<WorkspaceSource> & { all: number }> {
  const rees = await ownedReeRows(ownerId);
  const ids = query.ree === 'all' ? rees.map((ree) => ree.id) : [query.ree];
  if (!ids.length) return { items: [], total: 0, page: 1, size: query.size, all: 0 };
  const base = and(inArray(schema.knowledge.reeId, rees.length ? rees.map((ree) => ree.id) : ids), isNull(schema.knowledge.deletedAt));
  const conditions: SQL[] = [inArray(schema.knowledge.reeId, ids), isNull(schema.knowledge.deletedAt)];
  if (query.status !== 'all') conditions.push(sql`${sourceState} = ${query.status}`);
  if (query.kind !== 'all') conditions.push(eq(schema.knowledge.kind, query.kind as never));
  if (query.q) {
    const pattern = likePattern(query.q);
    conditions.push(or(ilike(schema.knowledge.title, pattern), ilike(schema.ree.name, pattern), ilike(schema.knowledge.source, pattern))!);
  }
  const database = db();
  const where = and(...conditions);
  const [[counted], [everything]] = await Promise.all([
    database.select({ total: sql<number>`count(*)::int` }).from(schema.knowledge).innerJoin(schema.ree, eq(schema.ree.id, schema.knowledge.reeId)).where(where),
    database.select({ total: sql<number>`count(*)::int` }).from(schema.knowledge).where(base),
  ]);
  const total = counted?.total ?? 0;
  const current = clampPage(query.page, total, query.size);
  const items = await database
    .select({
      id: schema.knowledge.id,
      title: schema.knowledge.title,
      kind: schema.knowledge.kind,
      state: sourceState,
      reeId: schema.knowledge.reeId,
      reeName: schema.ree.name,
      updatedAt: schema.knowledge.updatedAt,
    })
    .from(schema.knowledge)
    .innerJoin(schema.ree, eq(schema.ree.id, schema.knowledge.reeId))
    .where(where)
    .orderBy(desc(schema.knowledge.updatedAt), desc(schema.knowledge.id))
    .limit(query.size)
    .offset((current - 1) * query.size);
  return { items, total, page: current, size: query.size, all: everything?.total ?? 0 };
}

export interface AnswerSummaryRow {
  reeId: string;
  name: string;
  answers: number;
  saved: number;
}

/** `/workspace/answers`: by Ree (answers and saved records in the period) or record by record. */
export async function workspaceAnswers(ownerId: string, query: WorkspaceQuery) {
  const rees = await ownedReeRows(ownerId);
  const range = periodRange(query);
  const scoped = rees.filter((ree) => query.ree === 'all' || ree.id === query.ree);
  const ids = scoped.map((ree) => ree.id);
  const [answers, saved] = await Promise.all([answerCounts(ids, range), savedCounts(ids, range)]);
  const totals = {
    answers: [...answers.values()].reduce((sum, value) => sum + value, 0),
    saved: [...saved.values()].reduce((sum, value) => sum + value, 0),
  };
  if (query.view === 'records') {
    return { totals, summary: null, records: await answerRecords(ids, range, query.q, query.size, query.page) };
  }
  const needle = query.q.toLocaleLowerCase();
  const rows: AnswerSummaryRow[] = scoped
    .filter((ree) => !needle || ree.name.toLocaleLowerCase().includes(needle))
    .map((ree) => ({ reeId: ree.id, name: ree.name, answers: answers.get(ree.id) ?? 0, saved: saved.get(ree.id) ?? 0 }));
  const total = rows.length;
  const current = clampPage(query.page, total, query.size);
  return {
    totals,
    summary: { items: rows.slice((current - 1) * query.size, current * query.size), total, page: current, size: query.size },
    records: null,
  };
}

/* ------------------------------------------------------------ dashboard */

export interface DashboardData {
  sources: SourceSummary;
  ranking: { reeId: string; name: string; answers: number }[];
  attention: { reeId: string; name: string; moderated: boolean; sources: SourceSummary }[];
  attentionTotal: number;
  earned: number;
  /** The owner's Rees an administrator took down, for the "已下架" marks. */
  moderated: string[];
}

export async function dashboardData(ownerId: string): Promise<DashboardData> {
  const rees = await ownedReeRows(ownerId);
  const ids = rees.map((ree) => ree.id);
  const database = db();
  const [sources, perRee, answers, earnedRow] = await Promise.all([
    sourceSummary(ids),
    ids.length
      ? database
          .select({ reeId: schema.knowledge.reeId, state: sourceState, n: sql<number>`count(*)::int` })
          .from(schema.knowledge)
          .where(and(inArray(schema.knowledge.reeId, ids), isNull(schema.knowledge.deletedAt)))
          .groupBy(schema.knowledge.reeId, sourceState)
      : Promise.resolve([]),
    answerCounts(ids, null),
    database
      .select({ sum: sql<number>`coalesce(sum(${schema.creditGrant.remaining}), 0)::bigint` })
      .from(schema.creditGrant)
      .where(and(eq(schema.creditGrant.userId, ownerId), eq(schema.creditGrant.source, 'earned'))),
  ]);
  const byRee = new Map<string, SourceSummary>();
  for (const row of perRee) {
    const summary = byRee.get(row.reeId) ?? { total: 0, ready: 0, processing: 0, failed: 0, paused: 0 };
    summary[row.state] += row.n;
    summary.total += row.n;
    byRee.set(row.reeId, summary);
  }
  const attention = rees
    .map((ree) => ({ reeId: ree.id, name: ree.name, moderated: Boolean(ree.moderatedAt), sources: byRee.get(ree.id) ?? { total: 0, ready: 0, processing: 0, failed: 0, paused: 0 } }))
    .filter((row) => row.moderated || !row.sources.total || row.sources.failed || row.sources.processing);
  const ranking = rees
    .map((ree) => ({ reeId: ree.id, name: ree.name, answers: answers.get(ree.id) ?? 0 }))
    .sort((a, b) => b.answers - a.answers)
    .slice(0, 5);
  return {
    sources,
    ranking,
    attention: attention.slice(0, 5),
    attentionTotal: attention.length,
    earned: Number(earnedRow[0]?.sum ?? 0),
    moderated: rees.filter((ree) => ree.moderatedAt).map((ree) => ree.id),
  };
}

/**
 * Site-wide traffic (console 「流量」): page views the root layout's beacon
 * reports (`POST /api/track/view`), the daily rollup, and the console's
 * report. The rules for paths, sources and visits are in
 * lib/domain/traffic.ts; this file stores and counts.
 *
 * - a visitor is the share page's `re0_visitor` cookie; a browser without
 *   it is answered `cookie` and counted when it comes back with it, so the
 *   handshake never counts a view twice and a client that keeps no cookies
 *   counts nothing; no IP and no user agent is stored;
 * - an IP is limited per minute; past it nothing is read or stored;
 * - one visitor's views are taken one at a time (an advisory lock), so two
 *   beacons at once cannot both land a new visit;
 * - days are cut in UTC+8 (lib/domain/statistics.ts). The cron rolls up each
 *   finished day once into `site_traffic_day` / `site_traffic_landing` and
 *   marks it in `site_traffic_rollup`; a day not marked yet -- today, or
 *   yesterday before the cron ran -- is read from `site_view`. Raw views
 *   older than `TRAFFIC_RETENTION_DAYS` are deleted after their day is
 *   rolled up.
 */
import { sql, type SQL } from 'drizzle-orm';
import { dayStart, reportingDate, type Range } from '@/lib/domain/statistics';
import {
  channelOf,
  classifySource,
  INTERNAL_SOURCE,
  TRAFFIC_RETENTION_DAYS,
  TRAFFIC_VISIT_SECONDS,
  trackedPath,
  utmValue,
  visitOf,
  type PageKind,
  type SourceChannel,
} from '@/lib/domain/traffic';
import { db, schema } from '@/lib/infra/db';
import { assertConsole, type Administrator } from '@/lib/services/admin';
import { hitRateBucket } from '@/lib/services/rate-limit';

const DAY = 24 * 60 * 60 * 1000;
const ZONE = 'Asia/Shanghai';

/** Beacons per IP per minute; a person clicking through the site stays far below it. */
export const TRAFFIC_IP_PER_MINUTE = 120;
/** Raw views deleted per statement, so retention never holds one long lock. */
const PURGE_BATCH = 5_000;

export type ViewResult = 'recorded' | 'cookie' | 'ignored' | 'limited';

export interface ViewInput {
  path: unknown;
  referrer: unknown;
  utmSource: unknown;
  utmMedium: unknown;
  utmCampaign: unknown;
  visitorId: string;
  freshVisitor: boolean;
  userId: string | null;
  ip: string | null;
  /** This site's hosts, so its own pages are not a source. */
  ownHosts: readonly string[];
}

/** One page view. `ignored`: a path that is never counted (the console, an API route, not a path). */
export async function recordPageView(input: ViewInput, now = new Date()): Promise<ViewResult> {
  const page = trackedPath(input.path);
  if (!page) return 'ignored';
  if (input.ip && !(await hitRateBucket(`traffic:ip:${input.ip}`, TRAFFIC_IP_PER_MINUTE, 60, now))) return 'limited';
  if (input.freshVisitor) return 'cookie';
  const arrived = classifySource({ referrer: input.referrer, utmSource: input.utmSource, ownHosts: input.ownHosts });
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`re0:traffic:${input.visitorId}`}))`);
    const since = new Date(now.getTime() - (TRAFFIC_VISIT_SECONDS + 60) * 1_000).toISOString();
    const last = await tx.execute<{ created_at: string | Date; source: string }>(sql`
      select created_at, source from ${schema.siteView}
      where visitor_id = ${input.visitorId} and created_at >= ${since}::timestamptz
      order by created_at desc limit 1`);
    const previous = last.rows[0];
    const visit = visitOf(previous ? { at: new Date(previous.created_at), source: previous.source } : null, arrived, now);
    await tx.insert(schema.siteView).values({
      visitorId: input.visitorId,
      userId: input.userId,
      path: page.path,
      pageKind: page.kind,
      landing: visit.landing,
      source: visit.source,
      /* The referrer and utm values belong to the view that landed; later ones only inherit the source. */
      referrerHost: visit.landing ? arrived.referrerHost : null,
      utmSource: visit.landing ? utmValue(input.utmSource, true) : null,
      utmMedium: visit.landing ? utmValue(input.utmMedium, true) : null,
      utmCampaign: visit.landing ? utmValue(input.utmCampaign) : null,
      createdAt: now,
    });
  });
  return 'recorded';
}

/* ------------------------------------------------------------- rollup */

const localDay = sql`(v.created_at at time zone ${sql.raw(`'${ZONE}'`)})::date`;
const notRolled = sql`not exists (select 1 from ${schema.siteTrafficRollup} r where r.day = ${localDay})`;

/** A view's `[start, end)` in instants, as SQL on `site_view v`. */
function rawWindow(range: Range | null): SQL {
  if (!range) return sql`true`;
  return sql`v.created_at >= ${new Date(range.start).toISOString()}::timestamptz and v.created_at < ${new Date(range.end).toISOString()}::timestamptz`;
}

/** The day-level grouping sets over `site_view v` rows matching `where`: the day's total, per source, per page kind, and per both. */
function dayAggregate(where: SQL): SQL {
  return sql`
    select ${localDay} as day,
      case when grouping(v.source) = 1 then '' else v.source end as source,
      case when grouping(v.page_kind) = 1 then '' else v.page_kind end as page_kind,
      count(*)::int as views,
      count(distinct v.visitor_id)::int as visitors,
      (count(*) filter (where v.landing))::int as visits
    from ${schema.siteView} v
    where ${where}
    group by grouping sets ((${localDay}), (${localDay}, v.source), (${localDay}, v.page_kind), (${localDay}, v.source, v.page_kind))`;
}

/** Rolls one finished day up, replacing whatever an interrupted run left, and marks it. */
async function rollUpDay(day: string): Promise<void> {
  const range = { start: dayStart(day), end: dayStart(day) + DAY };
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`re0:traffic-rollup:${day}`}))`);
    const done = await tx.execute(sql`select 1 from ${schema.siteTrafficRollup} where day = ${day}::date`);
    if (done.rows.length) return;
    await tx.execute(sql`delete from ${schema.siteTrafficDay} where day = ${day}::date`);
    await tx.execute(sql`delete from ${schema.siteTrafficLanding} where day = ${day}::date`);
    await tx.execute(sql`insert into ${schema.siteTrafficDay} (day, source, page_kind, views, visitors, visits) ${dayAggregate(rawWindow(range))}`);
    await tx.execute(sql`
      insert into ${schema.siteTrafficLanding} (day, source, path, page_kind, visits)
      select ${localDay}, v.source, v.path, min(v.page_kind), count(*)::int
      from ${schema.siteView} v where v.landing and ${rawWindow(range)}
      group by ${localDay}, v.source, v.path`);
    await tx.insert(schema.siteTrafficRollup).values({ day }).onConflictDoNothing();
  });
}

/**
 * The daily cron: rolls up every finished day that has views and is not
 * rolled up yet (oldest first), then deletes raw views older than
 * `TRAFFIC_RETENTION_DAYS`. Idempotent: a rolled-up day is never rolled up
 * again, and a run cut short is finished by the next.
 */
export async function rollUpTraffic(now = new Date(), deadline = Number.POSITIVE_INFINITY): Promise<{ days: string[]; purged: number }> {
  const todayStart = new Date(dayStart(reportingDate(now))).toISOString();
  const pending = await db().execute<{ day: string }>(sql`
    select distinct to_char(${localDay}, 'YYYY-MM-DD') as day from ${schema.siteView} v
    where v.created_at < ${todayStart}::timestamptz and ${notRolled}
    order by 1`);
  const days: string[] = [];
  for (const { day } of pending.rows) {
    if (Date.now() > deadline) break;
    await rollUpDay(day);
    days.push(day);
  }
  /* Only what is rolled up is deleted: a day the loop did not reach keeps its views for the next run. */
  const cutoff = new Date(now.getTime() - TRAFFIC_RETENTION_DAYS * DAY).toISOString();
  let purged = 0;
  for (;;) {
    if (Date.now() > deadline) break;
    const deleted = await db().execute(sql`
      delete from ${schema.siteView} where id in (
        select v.id from ${schema.siteView} v where v.created_at < ${cutoff}::timestamptz and not ${notRolled} limit ${PURGE_BATCH})`);
    const count = deleted.rowCount ?? 0;
    purged += count;
    if (count < PURGE_BATCH) break;
  }
  return { days, purged };
}

/* ------------------------------------------------------------- report */

export interface TrafficFigures {
  views: number;
  visitors: number;
  /** Visits that came from outside the site: every visit but `internal` ones. */
  inbound: number;
}

export interface TrafficDay extends TrafficFigures {
  day: string;
}

export interface TrafficSource extends TrafficFigures {
  source: string;
  channel: SourceChannel;
}

export interface TrafficLanding {
  path: string;
  kind: PageKind;
  visits: number;
}

export interface TrafficReport {
  /** The range's figures. `visitors` is exact when `exactVisitors`, otherwise the sum of each day's visitors. */
  totals: TrafficFigures & { exactVisitors: boolean; internal: number };
  /** One point per day (or month, for long ranges), oldest first. */
  trend: { unit: 'day' | 'month'; points: TrafficDay[] };
  sources: TrafficSource[];
  kinds: (TrafficFigures & { kind: PageKind })[];
  /** Top landing pages, overall and for each source in `sources` order. */
  landing: { all: TrafficLanding[]; bySource: { source: string; pages: TrafficLanding[] }[] };
}

/** Landing pages kept per source. */
export const TRAFFIC_LANDING_TOP = 10;
/** Trends longer than this many days are drawn by month. */
const TREND_DAY_LIMIT = 92;

type DayRow = {
  day: string;
  source: string;
  page_kind: string;
  views: number;
  visitors: number;
  visits: number;
};

/** Every rolled-up and raw day row of a range, at all four groupings. */
async function dayRows(range: Range | null): Promise<DayRow[]> {
  const days = range ? sql`d.day >= ${reportingDate(range.start)}::date and d.day < ${reportingDate(range.end)}::date` : sql`true`;
  const result = await db().execute<DayRow>(sql`
    select to_char(day, 'YYYY-MM-DD') as day, source, page_kind, views, visitors, visits from (${dayAggregate(sql`${rawWindow(range)} and ${notRolled}`)}) raw
    union all
    select to_char(d.day, 'YYYY-MM-DD'), d.source, d.page_kind, d.views, d.visitors, d.visits from ${schema.siteTrafficDay} d where ${days}`);
  return result.rows.map((row) => ({ ...row, views: Number(row.views), visitors: Number(row.visitors), visits: Number(row.visits) }));
}

/** Top landing pages per source, or (`bySource` false) over every inbound source, `source` then `''`. */
async function landingRows(range: Range | null, bySource: boolean): Promise<{ source: string; path: string; kind: PageKind; visits: number }[]> {
  const days = range ? sql`l.day >= ${reportingDate(range.start)}::date and l.day < ${reportingDate(range.end)}::date` : sql`true`;
  const source = bySource ? sql`source` : sql`''`;
  const inbound = bySource ? sql`true` : sql`v.source <> ${INTERNAL_SOURCE}`;
  const inboundRolled = bySource ? sql`true` : sql`l.source <> ${INTERNAL_SOURCE}`;
  const result = await db().execute<{ source: string; path: string; kind: PageKind; visits: number }>(sql`
    with pages as (
      select ${source} as source, path, min(page_kind) as kind, sum(visits)::int as visits from (
        select v.source, v.path, v.page_kind, count(*)::int as visits from ${schema.siteView} v
        where v.landing and ${inbound} and ${rawWindow(range)} and ${notRolled} group by 1, 2, 3
        union all
        select l.source, l.path, l.page_kind, l.visits from ${schema.siteTrafficLanding} l where ${inboundRolled} and ${days}
      ) x group by 1, 2
    )
    select source, path, kind, visits from (
      select *, row_number() over (partition by source order by visits desc, path) as place from pages
    ) ranked where place <= ${TRAFFIC_LANDING_TOP} order by source, visits desc, path`);
  return result.rows.map((row) => ({ ...row, visits: Number(row.visits) }));
}

/** Exact distinct visitors of a range -- overall (`''`), per source and per page kind; only while every view of it is still kept. */
async function exactVisitors(range: Range): Promise<{ sources: Map<string, number>; kinds: Map<string, number> }> {
  const result = await db().execute<{ source: string | null; page_kind: string | null; visitors: number }>(sql`
    select case when grouping(v.source) = 1 then null else v.source end as source,
      case when grouping(v.page_kind) = 1 then null else v.page_kind end as page_kind,
      count(distinct v.visitor_id)::int as visitors
    from ${schema.siteView} v where ${rawWindow(range)}
    group by grouping sets ((), (v.source), (v.page_kind))`);
  const sources = new Map<string, number>();
  const kinds = new Map<string, number>();
  for (const row of result.rows) {
    if (row.page_kind !== null) kinds.set(row.page_kind, Number(row.visitors));
    else sources.set(row.source ?? '', Number(row.visitors));
  }
  return { sources, kinds };
}

const figures = (row: { views: number; visitors: number; visits: number } | undefined, internal = 0): TrafficFigures => ({
  views: row?.views ?? 0,
  visitors: row?.visitors ?? 0,
  inbound: Math.max(0, (row?.visits ?? 0) - internal),
});

function addFigures(into: TrafficFigures, more: TrafficFigures): TrafficFigures {
  return { views: into.views + more.views, visitors: into.visitors + more.visitors, inbound: into.inbound + more.inbound };
}

/** Consecutive reporting days `[first, last]`. */
function daysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let at = dayStart(first); at <= dayStart(last); at += DAY) out.push(reportingDate(at));
  return out;
}

/**
 * The console's traffic report for a range (`null`: all time). Today and
 * any day the cron has not rolled up come from raw views, every other day
 * from the rollup, so the two never count one view twice.
 */
export async function trafficReport(administrator: Administrator, range: Range | null, now = new Date()): Promise<TrafficReport> {
  assertConsole(administrator);
  const cappedRange = range ? { start: range.start, end: Math.min(range.end, dayStart(reportingDate(now)) + DAY) } : null;
  const retained = cappedRange !== null && cappedRange.start >= dayStart(reportingDate(now.getTime() - (TRAFFIC_RETENTION_DAYS - 1) * DAY));
  const [rows, landingAll, landingBySource, exact] = await Promise.all([
    dayRows(cappedRange),
    landingRows(cappedRange, false),
    landingRows(cappedRange, true),
    retained ? exactVisitors(cappedRange) : Promise.resolve(null),
  ]);

  const totalOf = new Map<string, DayRow>();
  const internalOf = new Map<string, number>();
  const sourceSums = new Map<string, TrafficFigures>();
  const kindSums = new Map<string, TrafficFigures>();
  for (const row of rows) {
    if (row.source === '' && row.page_kind === '') totalOf.set(row.day, row);
    else if (row.page_kind === '') {
      if (row.source === INTERNAL_SOURCE) internalOf.set(row.day, row.visits);
      sourceSums.set(row.source, addFigures(sourceSums.get(row.source) ?? figures(undefined), figures(row, row.source === INTERNAL_SOURCE ? row.visits : 0)));
    } else if (row.source === '') {
      kindSums.set(row.page_kind, addFigures(kindSums.get(row.page_kind) ?? figures(undefined), figures(row)));
    } else if (row.source === INTERNAL_SOURCE) {
      /* A kind's landings that began inside the site are not inbound. */
      kindSums.set(row.page_kind, addFigures(kindSums.get(row.page_kind) ?? figures(undefined), { views: 0, visitors: 0, inbound: -row.visits }));
    }
  }

  const knownDays = [...totalOf.keys()].sort();
  const last = cappedRange ? reportingDate(cappedRange.end - 1) : reportingDate(now);
  const first = cappedRange ? reportingDate(cappedRange.start) : (knownDays[0] ?? last);
  const daily = daysBetween(first <= last ? first : last, last).map((day) => ({ day, ...figures(totalOf.get(day), internalOf.get(day) ?? 0) }));
  const points =
    daily.length > TREND_DAY_LIMIT
      ? [...daily.reduce((months, point) => months.set(point.day.slice(0, 7), addFigures(months.get(point.day.slice(0, 7)) ?? figures(undefined), point)), new Map<string, TrafficFigures>())].map(([day, value]) => ({ day, ...value }))
      : daily;

  const summed = daily.reduce<TrafficFigures>((sum, point) => addFigures(sum, point), figures(undefined));
  const internal = [...internalOf.values()].reduce((sum, n) => sum + n, 0);
  const sources = [...sourceSums]
    .map(([source, value]) => ({ source, channel: channelOf(source), ...value, visitors: exact?.sources.get(source) ?? value.visitors }))
    .sort((a, b) => b.inbound - a.inbound || b.views - a.views || a.source.localeCompare(b.source));
  const kinds = [...kindSums]
    .map(([kind, value]) => ({ kind: kind as PageKind, ...value, visitors: exact?.kinds.get(kind) ?? value.visitors }))
    .sort((a, b) => b.views - a.views);
  const bySource = sources.map(({ source }) => ({
    source,
    pages: landingBySource.filter((row) => row.source === source).map(({ path, kind, visits }) => ({ path, kind, visits })),
  }));
  return {
    totals: { ...summed, visitors: exact?.sources.get('') ?? summed.visitors, exactVisitors: exact !== null, internal },
    trend: { unit: points === daily ? 'day' : 'month', points },
    sources,
    kinds,
    landing: { all: landingAll.map(({ path, kind, visits }) => ({ path, kind, visits })), bySource },
  };
}

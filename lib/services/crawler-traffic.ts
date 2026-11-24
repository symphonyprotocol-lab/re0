/**
 * Crawler and infrastructure traffic (console 「流量」 → 「爬虫 / 基础设施」).
 *
 * The page-view beacon (lib/services/traffic.ts) counts people only. What
 * crawlers fetch, and what serving them costs, is already in Vercel's own
 * request records, so nothing is counted on the request path: once a day
 * the cron `/api/cron/crawler-traffic` reads each finished UTC+8 day from
 * Vercel Observability -- CDN requests, function invocations and Fast
 * Origin Transfer bytes, by user agent and by route -- folds the agents
 * into crawler families (lib/domain/crawler-traffic.ts), and stores the
 * day. It also refreshes the project's billing charges. Observability keeps
 * about 30 days, so a day not fetched within them is lost; any day it still
 * has can be fetched again (`refetch`).
 *
 * With no `VERCEL_OBSERVABILITY_TOKEN` the cron fetches nothing and the
 * report says it is not configured.
 */
import { sql, type SQL } from 'drizzle-orm';
import { dayStart, reportingDate, type Range } from '@/lib/domain/statistics';
import {
  CRAWLER_FAMILIES,
  CRAWLER_METRICS,
  CRAWLER_ROUTE_LIMIT,
  crawlerFamily,
  estimateFamilyCost,
  foldAgents,
  OBSERVABILITY_GROUP_LIMIT,
  OBSERVABILITY_RETENTION_DAYS,
  parseCharges,
  VercelApiError,
  type ChargeScope,
  type CrawlerFamily,
  type CrawlerMetric,
} from '@/lib/domain/crawler-traffic';
import { db, schema } from '@/lib/infra/db';
import { fetchCharges, queryObservability, vercelApiConfig, type VercelApiConfig } from '@/lib/infra/vercel-api';
import { assertConsole, type Administrator } from '@/lib/services/admin';

const DAY = 24 * 60 * 60 * 1000;
/** Billing days fetched again on every run: Vercel may still revise them. */
const CHARGE_REFRESH_DAYS = 3;
/** The route label of requests Vercel gives no route (static files, redirects). */
export const NO_ROUTE = '(none)';
/** Longest stored route. */
const ROUTE_MAX = 300;

type Figures = Record<CrawlerMetric, number>;
const METRICS = Object.keys(CRAWLER_METRICS) as CrawlerMetric[];
const zero = (): Figures => ({ requests: 0, invocations: 0, originBytes: 0 });

/* -------------------------------------------------------------- fetch */

interface DayFigures {
  agents: { family: CrawlerFamily; agent: string; figures: Figures }[];
  routes: { route: string; family: CrawlerFamily | ''; figures: Figures }[];
}

const routeLabel = (route: string | undefined) => (route?.trim() ? route.trim().slice(0, ROUTE_MAX) : NO_ROUTE);

/** One finished day's figures, read from Observability: per metric, the total and the top agents, routes and route-agent pairs. */
async function readDay(config: VercelApiConfig, day: string): Promise<DayFigures> {
  const start = dayStart(day);
  const end = start + DAY;
  const agents = new Map<string, { family: CrawlerFamily; agent: string; figures: Figures }>();
  const routes = new Map<string, { route: string; family: CrawlerFamily | ''; figures: Figures }>();
  for (const key of METRICS) {
    const metric = CRAWLER_METRICS[key];
    const [total, byAgent, byRoute, byPair] = await Promise.all([
      queryObservability(config, { metric, start, end }),
      queryObservability(config, { metric, start, end, groupBy: ['client_user_agent'], limit: OBSERVABILITY_GROUP_LIMIT }),
      queryObservability(config, { metric, start, end, groupBy: ['route'], limit: CRAWLER_ROUTE_LIMIT }),
      queryObservability(config, { metric, start, end, groupBy: ['route', 'client_user_agent'], limit: OBSERVABILITY_GROUP_LIMIT }),
    ]);
    const sum = total.reduce((all, group) => all + group.value, 0);
    for (const { family, agent, value } of foldAgents(byAgent, sum)) {
      const id = `${family}\u0000${agent}`;
      const entry = agents.get(id) ?? { family, agent, figures: zero() };
      entry.figures[key] += value;
      agents.set(id, entry);
    }
    const add = (route: string, family: CrawlerFamily | '', value: number) => {
      const id = `${route}\u0000${family}`;
      const entry = routes.get(id) ?? { route, family, figures: zero() };
      entry.figures[key] += value;
      routes.set(id, entry);
    };
    for (const group of byRoute) add(routeLabel(group.dims.route), '', group.value);
    for (const group of byPair) add(routeLabel(group.dims.route), crawlerFamily(group.dims.client_user_agent), group.value);
  }
  /* Only the routes in some metric's top list are kept; a pair of a route outside them is dropped. */
  const kept = new Set([...routes.values()].filter((entry) => entry.family === '').map((entry) => entry.route));
  return { agents: [...agents.values()], routes: [...routes.values()].filter((entry) => kept.has(entry.route)) };
}

/** Replaces a day's stored figures and marks it fetched. */
async function storeDay(day: string, figures: DayFigures, now: Date): Promise<void> {
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`re0:crawler-traffic:${day}`}))`);
    await tx.delete(schema.crawlerTrafficDay).where(sql`day = ${day}::date`);
    await tx.delete(schema.crawlerRouteDay).where(sql`day = ${day}::date`);
    if (figures.agents.length) {
      await tx.insert(schema.crawlerTrafficDay).values(figures.agents.map(({ family, agent, figures: f }) => ({ day, family, agent, ...f })));
    }
    if (figures.routes.length) {
      await tx.insert(schema.crawlerRouteDay).values(figures.routes.map(({ route, family, figures: f }) => ({ day, route, family, ...f })));
    }
    await tx
      .insert(schema.crawlerTrafficFetch)
      .values({ day, fetchedAt: now })
      .onConflictDoUpdate({ target: schema.crawlerTrafficFetch.day, set: { fetchedAt: now } });
  });
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value: string | undefined) => (value && ISO_DAY.test(value) && Number.isFinite(dayStart(value)) ? value : undefined);
const addDays = (day: string, days: number) => reportingDate(dayStart(day) + days * DAY);

export interface CrawlerFetchOptions {
  /** First and last UTC+8 day to fetch (default: as far back as Observability keeps, through yesterday). */
  from?: string;
  to?: string;
  /** Fetch days again that were fetched already. */
  refetch?: boolean;
  /** Stop starting new days after this instant (epoch ms). */
  deadline?: number;
}

export interface CrawlerFetchResult {
  configured: boolean;
  days: string[];
  failed: { day: string; error: string }[];
  /** Billing days whose charges were replaced, or the error that stopped it. */
  charges: { days: string[] } | { error: string };
  /** Days left for the next run (the deadline came first). */
  remaining: number;
}

/**
 * The cron's run: every finished day Observability still keeps and this
 * has not fetched (or, with `refetch`, every day of `[from, to]`), oldest
 * first, then the billing charges. A day that fails is left for the next
 * run; a refused token stops the run.
 */
export async function collectCrawlerTraffic(now = new Date(), options: CrawlerFetchOptions = {}): Promise<CrawlerFetchResult> {
  const config = vercelApiConfig();
  if (!config) return { configured: false, days: [], failed: [], charges: { days: [] }, remaining: 0 };
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;
  const today = reportingDate(now);
  const oldest = addDays(today, -(OBSERVABILITY_RETENTION_DAYS - 1));
  const yesterday = addDays(today, -1);
  const askedFrom = validDay(options.from);
  const askedTo = validDay(options.to);
  const from = askedFrom && askedFrom > oldest ? askedFrom : oldest;
  const to = askedTo && askedTo < yesterday ? askedTo : yesterday;
  const wanted: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) wanted.push(day);
  const fetched = options.refetch
    ? new Set<string>()
    : new Set(
        (
          await db().execute<{ day: string }>(sql`
            select to_char(day, 'YYYY-MM-DD') as day from ${schema.crawlerTrafficFetch} where day >= ${from}::date and day <= ${to}::date`)
        ).rows.map((row) => row.day),
      );
  const pending = wanted.filter((day) => !fetched.has(day));

  const days: string[] = [];
  const failed: { day: string; error: string }[] = [];
  let index = 0;
  for (; index < pending.length; index++) {
    if (Date.now() > deadline) break;
    const day = pending[index]!;
    try {
      await storeDay(day, await readDay(config, day), now);
      days.push(day);
    } catch (error) {
      if (error instanceof VercelApiError && error.auth) throw error;
      failed.push({ day, error: error instanceof Error ? error.message : String(error) });
    }
  }

  let charges: CrawlerFetchResult['charges'];
  try {
    charges = Date.now() > deadline ? { days: [] } : { days: await refreshCharges(config, now, askedFrom) };
  } catch (error) {
    if (error instanceof VercelApiError && error.auth) throw error;
    charges = { error: error instanceof Error ? error.message : String(error) };
  }
  return { configured: true, days, failed, charges, remaining: pending.length - index };
}

/**
 * Re-reads the billing charges from `from` (default: a few days before the
 * latest stored one, or `OBSERVABILITY_RETENTION_DAYS` back when none is)
 * through today, and replaces every billing day the answer covers.
 */
async function refreshCharges(config: VercelApiConfig, now: Date, from?: string): Promise<string[]> {
  const latest = await db().execute<{ day: string | null }>(sql`select to_char(max(day), 'YYYY-MM-DD') as day from ${schema.infraChargeDay}`);
  /* The API takes whole UTC days; its lines are whole billing days, so the first one may begin the day before `start`. */
  const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
  const stored = latest.rows[0]?.day ?? null;
  const start = from ?? (stored ? utcDay(Date.parse(`${stored}T00:00:00Z`) - CHARGE_REFRESH_DAYS * DAY) : utcDay(now.getTime() - OBSERVABILITY_RETENTION_DAYS * DAY));
  const end = Date.parse(`${utcDay(now.getTime())}T00:00:00Z`) + DAY;
  const lines = parseCharges(await fetchCharges(config, Date.parse(`${start}T00:00:00Z`), end), config.projectId);
  const days = [...new Set(lines.map((line) => line.day))].sort();
  if (!days.length) return [];
  await db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('re0:infra-charges'))`);
    await tx.execute(sql`delete from ${schema.infraChargeDay} where day = any(${`{${days.join(',')}}`}::date[])`);
    await tx.insert(schema.infraChargeDay).values(
      lines.map((line) => ({ day: line.day, scope: line.scope, service: line.service, cost: line.cost.toFixed(8), quantity: line.quantity.toFixed(6), unit: line.unit, fetchedAt: now })),
    );
  });
  return days;
}

/* ------------------------------------------------------------- report */

export interface CrawlerFamilyRow extends Figures {
  family: CrawlerFamily;
  /** The family's agents by name, most transfer first (none for `human`). */
  agents: (Figures & { agent: string })[];
  /** Estimated USD, or null without billing data. */
  cost: number | null;
}

export interface CrawlerRouteRow extends Figures {
  route: string;
  /** What crawlers (every family but `human`) did on it, from the top route-agent pairs. */
  crawlers: Figures;
  /** The family with the most transfer on it, `human` included. */
  top: CrawlerFamily | null;
}

export interface CrawlerTrendPoint {
  day: string;
  families: Record<CrawlerFamily, Figures>;
}

export interface CrawlerReport {
  configured: boolean;
  /** The latest day fetched at all, and how many days of the range are. */
  fetchedThrough: string | null;
  fetchedDays: number;
  totals: Figures;
  /** What crawlers (every family but `human`) did. */
  crawlers: Figures;
  families: CrawlerFamilyRow[];
  trend: { unit: 'day' | 'month'; points: CrawlerTrendPoint[] };
  routes: CrawlerRouteRow[];
  cost: {
    /** The project's billed USD over the range's billing days, and the team's own (plan, seats). */
    project: number;
    team: number;
    services: { service: string; scope: ChargeScope; cost: number; quantity: number; unit: string }[];
    /** First and last billing day with charges in the range, or null when none is stored. */
    span: { first: string; last: string } | null;
  };
}

/** Routes shown. */
export const CRAWLER_ROUTE_TOP = 15;
/** Agents listed per family. */
export const CRAWLER_AGENT_TOP = 5;
const TREND_DAY_LIMIT = 92;

const crawlerFamilies = CRAWLER_FAMILIES.filter((family) => family !== 'human');

function dayWhere(range: Range | null, column = sql`day`): SQL {
  if (!range) return sql`true`;
  return sql`${column} >= ${reportingDate(range.start)}::date and ${column} < ${reportingDate(range.end)}::date`;
}

type SumRow = { requests: string | number; invocations: string | number; origin_bytes: string | number };
const figuresOf = (row: SumRow): Figures => ({ requests: Number(row.requests), invocations: Number(row.invocations), originBytes: Number(row.origin_bytes) });
const plus = (a: Figures, b: Figures): Figures => ({ requests: a.requests + b.requests, invocations: a.invocations + b.invocations, originBytes: a.originBytes + b.originBytes });
const sums = sql`sum(requests)::bigint as requests, sum(invocations)::bigint as invocations, sum(origin_bytes)::bigint as origin_bytes`;

/**
 * The console's crawler report for a range (`null`: all time): the fetched
 * days' figures by family, agent, day and route, and the billing charges of
 * the billing days in the range. Billing days are cut in US Pacific time,
 * 16 hours behind UTC+8, so a range's charges and its traffic are close
 * but not the same hours.
 */
export async function crawlerReport(administrator: Administrator, range: Range | null, now = new Date()): Promise<CrawlerReport> {
  assertConsole(administrator);
  const where = dayWhere(range);
  const [agentRows, trendRows, routeRows, chargeRows, fetchRows] = await Promise.all([
    db().execute<SumRow & { family: CrawlerFamily; agent: string }>(sql`
      select family, agent, ${sums} from ${schema.crawlerTrafficDay} where ${where} group by family, agent`),
    db().execute<SumRow & { day: string; family: CrawlerFamily }>(sql`
      select to_char(day, 'YYYY-MM-DD') as day, family, ${sums} from ${schema.crawlerTrafficDay} where ${where} group by day, family order by day`),
    db().execute<SumRow & { route: string; family: string }>(sql`
      select route, family, ${sums} from ${schema.crawlerRouteDay} where ${where} group by route, family`),
    db().execute<{ scope: ChargeScope; service: string; cost: string; quantity: string; unit: string; first: string; last: string }>(sql`
      select scope, service, sum(cost)::float8 as cost, sum(quantity)::float8 as quantity, max(unit) as unit,
        to_char(min(day), 'YYYY-MM-DD') as first, to_char(max(day), 'YYYY-MM-DD') as last
      from ${schema.infraChargeDay} where ${where} group by scope, service`),
    db().execute<{ latest: string | null; inside: number }>(sql`
      select (select to_char(max(day), 'YYYY-MM-DD') from ${schema.crawlerTrafficFetch}) as latest,
        (select count(*)::int from ${schema.crawlerTrafficFetch} where ${where}) as inside`),
  ]);

  const byFamily = new Map<CrawlerFamily, { figures: Figures; agents: (Figures & { agent: string })[] }>();
  for (const row of agentRows.rows) {
    const entry = byFamily.get(row.family) ?? { figures: zero(), agents: [] };
    const figures = figuresOf(row);
    entry.figures = plus(entry.figures, figures);
    if (row.agent) entry.agents.push({ agent: row.agent, ...figures });
    byFamily.set(row.family, entry);
  }
  const services = chargeRows.rows
    .map((row) => ({ service: row.service, scope: row.scope, cost: Number(row.cost), quantity: Number(row.quantity), unit: row.unit }))
    .filter((row) => Math.abs(row.cost) >= 0.005)
    .sort((a, b) => b.cost - a.cost || a.service.localeCompare(b.service));
  const projectServices = services.filter((row) => row.scope === 'project');
  const familyFigures = CRAWLER_FAMILIES.map((family) => ({ family, ...(byFamily.get(family)?.figures ?? zero()) }));
  const estimates = projectServices.length ? estimateFamilyCost(projectServices, familyFigures) : null;
  const families: CrawlerFamilyRow[] = familyFigures
    .filter((row) => row.requests + row.invocations + row.originBytes > 0)
    .map((row) => ({
      ...row,
      agents: (byFamily.get(row.family)?.agents ?? []).sort((a, b) => b.originBytes - a.originBytes || b.requests - a.requests).slice(0, CRAWLER_AGENT_TOP),
      cost: estimates ? (estimates.get(row.family) ?? 0) : null,
    }));
  const totals = familyFigures.reduce<Figures>((all, row) => plus(all, row), zero());
  const crawlers = familyFigures.filter((row) => row.family !== 'human').reduce<Figures>((all, row) => plus(all, row), zero());

  /* Trend: each day of the range up to yesterday, days without figures empty. */
  const empty = () => Object.fromEntries(CRAWLER_FAMILIES.map((family) => [family, zero()])) as Record<CrawlerFamily, Figures>;
  const pointOf = new Map<string, CrawlerTrendPoint>();
  for (const row of trendRows.rows) {
    const point = pointOf.get(row.day) ?? { day: row.day, families: empty() };
    point.families[row.family] = plus(point.families[row.family], figuresOf(row));
    pointOf.set(row.day, point);
  }
  const yesterday = reportingDate(now.getTime() - DAY);
  const known = [...pointOf.keys()].sort();
  const first = range ? reportingDate(range.start) : (known[0] ?? yesterday);
  const lastInRange = range ? reportingDate(range.end - 1) : yesterday;
  const last = lastInRange < yesterday ? lastInRange : yesterday;
  const daily: CrawlerTrendPoint[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) daily.push(pointOf.get(day) ?? { day, families: empty() });
  let points = daily;
  if (daily.length > TREND_DAY_LIMIT) {
    const months = new Map<string, CrawlerTrendPoint>();
    for (const point of daily) {
      const month = months.get(point.day.slice(0, 7)) ?? { day: point.day.slice(0, 7), families: empty() };
      for (const family of CRAWLER_FAMILIES) month.families[family] = plus(month.families[family], point.families[family]);
      months.set(month.day, month);
    }
    points = [...months.values()];
  }

  const routeOf = new Map<string, { total: Figures; byFamily: Map<CrawlerFamily, Figures> }>();
  for (const row of routeRows.rows) {
    const entry = routeOf.get(row.route) ?? { total: zero(), byFamily: new Map() };
    if (row.family === '') entry.total = plus(entry.total, figuresOf(row));
    else entry.byFamily.set(row.family as CrawlerFamily, plus(entry.byFamily.get(row.family as CrawlerFamily) ?? zero(), figuresOf(row)));
    routeOf.set(row.route, entry);
  }
  const routes: CrawlerRouteRow[] = [...routeOf]
    .map(([route, { total, byFamily: split }]) => {
      const crawlersOnRoute = crawlerFamilies.reduce<Figures>((all, family) => plus(all, split.get(family) ?? zero()), zero());
      const top = [...split].sort((a, b) => b[1].originBytes - a[1].originBytes || b[1].requests - a[1].requests)[0]?.[0] ?? null;
      return { route, ...total, crawlers: crawlersOnRoute, top };
    })
    .sort((a, b) => b.originBytes - a.originBytes || b.requests - a.requests || a.route.localeCompare(b.route))
    .slice(0, CRAWLER_ROUTE_TOP);

  const firsts = chargeRows.rows.map((row) => row.first).sort();
  const lasts = chargeRows.rows.map((row) => row.last).sort();
  return {
    configured: vercelApiConfig() !== null,
    fetchedThrough: fetchRows.rows[0]?.latest ?? null,
    fetchedDays: Number(fetchRows.rows[0]?.inside ?? 0),
    totals,
    crawlers,
    families,
    trend: { unit: points === daily ? 'day' : 'month', points },
    routes,
    cost: {
      project: projectServices.reduce((sum, row) => sum + row.cost, 0),
      team: services.filter((row) => row.scope === 'team').reduce((sum, row) => sum + row.cost, 0),
      services,
      span: firsts.length ? { first: firsts[0]!, last: lasts[lasts.length - 1]! } : null,
    },
  };
}

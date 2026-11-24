/**
 * Crawler and infrastructure traffic (console 「流量」 → 「爬虫 / 基础设施」):
 * the daily cron reads finished UTC+8 days from Vercel Observability (here
 * a stub of `api.vercel.com`), folds user agents into crawler families,
 * stores each day once (again only on `refetch`), leaves a failed day for
 * the next run, stops on a refused token, and refreshes the billing
 * charges; the report adds the stored days up by family, route and day and
 * shares the bill out.
 */
import { TEST_DATABASE_URL } from './setup';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { consoleAdministrator } from '../fixtures/console-administrator';

const suite = TEST_DATABASE_URL ? describe : describe.skip;

const { db, schema } = await import('@/lib/infra/db');
const crawler = await import('@/lib/services/crawler-traffic');
const { GET: cron } = await import('@/app/api/cron/crawler-traffic/route');
const { dayStart } = await import('@/lib/domain/statistics');
const { VercelApiError } = await import('@/lib/domain/crawler-traffic');

const BASE = 'http://localhost:3000';
const NOW = new Date('2026-11-24T05:00:00Z');
const PROJECT = 'prj_lRE4xUOnAwhlrkaOHhvqlKy3thMk';
const CLAUDE = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)';
const GPT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.4; +https://openai.com/gptbot)';
const AMAZON = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

type Hit = { route: string; agent: string; requests: number; invocations: number; originBytes: number };
const METRIC_FIELD: Record<string, keyof Omit<Hit, 'route' | 'agent'>> = {
  'vercel.request.count': 'requests',
  'vercel.function_invocation.count': 'invocations',
  'vercel.function_invocation.fot_total_bytes': 'originBytes',
};

/** The stub's request records, per UTC+8 day; a day missing is a quiet one. */
let records: Record<string, Hit[]> = {};
/** Days the stub refuses (as Observability refuses a day past its retention). */
let rejectDays = new Set<string>();
let refuseToken = false;
let charges: string[] = [];
const calls: { path: string; body?: Record<string, unknown> }[] = [];

const dayOf = (iso: string) => new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 10);

function observability(body: Record<string, unknown>): Response {
  const metric = String(body.metric);
  const field = METRIC_FIELD[metric]!;
  const day = dayOf(String(body.startTime));
  if (rejectDays.has(day)) return Response.json({ error: { code: 'invalid_query', message: 'Observability query was rejected.' } }, { status: 400 });
  const groupBy = (body.groupBy as string[] | undefined) ?? [];
  const sums = new Map<string, Record<string, unknown>>();
  const key = `${metric.replace(/\./g, '_')}_sum`;
  for (const hit of records[day] ?? []) {
    const dims: Record<string, string> = {};
    if (groupBy.includes('route')) dims.route = hit.route;
    if (groupBy.includes('client_user_agent')) dims.client_user_agent = hit.agent;
    const id = JSON.stringify(dims);
    const row = sums.get(id) ?? { ...dims, [key]: 0 };
    row[key] = (row[key] as number) + hit[field];
    sums.set(id, row);
  }
  const summary = [...sums.values()].filter((row) => (row[key] as number) > 0).sort((a, b) => (b[key] as number) - (a[key] as number));
  return Response.json({ data: [], summary: groupBy.length ? summary.slice(0, Number(body.limit ?? 10)) : summary });
}

const realFetch = globalThis.fetch;
const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== 'api.vercel.com') return realFetch(input, init);
  const headers = new Headers(init?.headers);
  if (refuseToken || headers.get('authorization') !== 'Bearer test-token') return Response.json({ error: { code: 'forbidden', message: 'Not authorized' } }, { status: 403 });
  if (url.searchParams.get('teamId') !== 'team_gQB9RyFYxD5ff0CnXE5JAbDc') return Response.json({ error: { code: 'bad_request' } }, { status: 400 });
  if (url.pathname === '/v2/observability/query' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ path: url.pathname, body });
    return observability(body);
  }
  if (url.pathname === '/v1/billing/charges') {
    calls.push({ path: `${url.pathname}?from=${url.searchParams.get('from')}&to=${url.searchParams.get('to')}` });
    return new Response(charges.join('\n'), { headers: { 'content-type': 'application/jsonl' } });
  }
  return Response.json({ error: { code: 'not_found' } }, { status: 404 });
});

const charge = (day: string, service: string, cost: number, quantity: number, tags: Record<string, string> = { ProjectId: PROJECT, ProjectName: 'recall0' }) =>
  JSON.stringify({ BilledCost: cost, ChargePeriodStart: `${day}T08:00:00.000Z`, ChargePeriodEnd: 'x', ServiceName: service, ConsumedQuantity: quantity, ConsumedUnit: service === 'Fast Origin Transfer' ? 'GB' : 'Invocations', Tags: tags });

/** A crawl like ClaudeBot's in November: one route, almost all the transfer. */
function crawlDay(scale = 1): Hit[] {
  return [
    { route: '/r/[slug]', agent: CLAUDE, requests: 700_000 * scale, invocations: 690_000 * scale, originBytes: 99_000_000_000 * scale },
    { route: '/r/[slug]', agent: GPT, requests: 20_000, invocations: 18_000, originBytes: 2_000_000_000 },
    { route: '/login', agent: AMAZON, requests: 5_000, invocations: 5_000, originBytes: 100_000_000 },
    { route: '/r/[slug]', agent: CHROME, requests: 300, invocations: 120, originBytes: 30_000_000 },
    { route: '/', agent: SAFARI, requests: 200, invocations: 80, originBytes: 8_000_000 },
    { route: '', agent: CHROME, requests: 900, invocations: 0, originBytes: 0 },
  ];
}

const rows = async (day: string) =>
  (await db().execute<{ family: string; agent: string; requests: string; invocations: string; origin_bytes: string }>(sql`
    select family, agent, requests, invocations, origin_bytes from ${schema.crawlerTrafficDay} where day = ${day}::date order by family, agent`)).rows.map((row) => ({
    family: row.family,
    agent: row.agent,
    requests: Number(row.requests),
    invocations: Number(row.invocations),
    originBytes: Number(row.origin_bytes),
  }));

const withSecret = (path: string) => new NextRequest(`${BASE}${path}`, { headers: { authorization: 'Bearer crawler-cron-secret' } });

suite('crawler traffic', () => {
  const previous = { token: process.env.VERCEL_OBSERVABILITY_TOKEN, secret: process.env.CRON_SECRET };

  beforeAll(() => {
    vi.stubGlobal('fetch', stub);
    process.env.CRON_SECRET = 'crawler-cron-secret';
  });
  afterEach(() => {
    rejectDays = new Set();
    refuseToken = false;
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of [['VERCEL_OBSERVABILITY_TOKEN', previous.token], ['CRON_SECRET', previous.secret]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('without a token reads nothing and the report says it is not configured', async () => {
    delete process.env.VERCEL_OBSERVABILITY_TOKEN;
    expect((await cron(new NextRequest(`${BASE}/api/cron/crawler-traffic`))).status).toBe(401);
    const response = await cron(withSecret('/api/cron/crawler-traffic'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, days: [], failed: [], charges: { days: [] }, remaining: 0 });
    expect(calls).toHaveLength(0);
    const report = await crawler.crawlerReport(await consoleAdministrator(), null, NOW);
    expect(report).toMatchObject({ configured: false, fetchedThrough: null, fetchedDays: 0, families: [], routes: [] });
  });

  it('fetches finished days by family, agent and route, storing no person’s agent', async () => {
    process.env.VERCEL_OBSERVABILITY_TOKEN = 'test-token';
    records = { '2026-11-22': crawlDay(), '2026-11-23': crawlDay(0.9) };
    charges = [
      charge('2026-11-22', 'Fast Origin Transfer', 31, 516),
      charge('2026-11-22', 'Function Invocations', 1.2, 2_000_000),
      charge('2026-11-22', 'Fast Origin Transfer', 50, 900, { ProjectId: 'prj_someone_else', ProjectName: 'apage' }),
      charge('2026-11-22', 'Pro', 0.6667, 1, {}),
      charge('2026-11-23', 'Fast Origin Transfer', 28, 470),
    ];
    const result = await crawler.collectCrawlerTraffic(NOW, { from: '2026-11-22', to: '2026-11-30' });
    /* `to` is capped at yesterday: today is not finished. */
    expect(result).toMatchObject({ configured: true, days: ['2026-11-22', '2026-11-23'], failed: [], remaining: 0 });
    expect(result.charges).toEqual({ days: ['2026-11-22', '2026-11-23'] });
    const queries = calls.filter((call) => call.body);
    expect(queries).toHaveLength(2 * 12);
    expect(queries[0]!.body).toMatchObject({ aggregation: 'sum', scope: { type: 'project', ownerId: 'team_gQB9RyFYxD5ff0CnXE5JAbDc', projectIds: [PROJECT] }, startTime: new Date(dayStart('2026-11-22')).toISOString(), endTime: new Date(dayStart('2026-11-23')).toISOString(), bucketTimezone: 'Asia/Shanghai' });

    expect(await rows('2026-11-22')).toEqual([
      { family: 'bot', agent: 'Amazonbot', requests: 5_000, invocations: 5_000, originBytes: 100_000_000 },
      { family: 'claude', agent: 'ClaudeBot', requests: 700_000, invocations: 690_000, originBytes: 99_000_000_000 },
      { family: 'human', agent: '', requests: 1_400, invocations: 200, originBytes: 38_000_000 },
      { family: 'openai', agent: 'GPTBot', requests: 20_000, invocations: 18_000, originBytes: 2_000_000_000 },
    ]);
    const routes = await db().execute<{ route: string; family: string; origin_bytes: string }>(sql`
      select route, family, origin_bytes from ${schema.crawlerRouteDay} where day = '2026-11-22' and route = '/r/[slug]' order by family`);
    expect(routes.rows.map((row) => [row.family, Number(row.origin_bytes)])).toEqual([
      ['', 101_030_000_000],
      ['claude', 99_000_000_000],
      ['human', 30_000_000],
      ['openai', 2_000_000_000],
    ]);
    const unrouted = await db().execute(sql`select 1 from ${schema.crawlerRouteDay} where day = '2026-11-22' and route = ${crawler.NO_ROUTE} and family = ''`);
    expect(unrouted.rows).toHaveLength(1);
  });

  it('fetches a day once, again only on refetch, replacing it', async () => {
    calls.length = 0;
    expect(await crawler.collectCrawlerTraffic(NOW, { from: '2026-11-22', to: '2026-11-23' })).toMatchObject({ days: [], remaining: 0 });
    expect(calls.filter((call) => call.body)).toHaveLength(0);
    records['2026-11-23'] = crawlDay(2);
    expect(await crawler.collectCrawlerTraffic(NOW, { from: '2026-11-23', to: '2026-11-23', refetch: true })).toMatchObject({ days: ['2026-11-23'] });
    const claude = (await rows('2026-11-23')).filter((row) => row.family === 'claude');
    expect(claude).toEqual([{ family: 'claude', agent: 'ClaudeBot', requests: 1_400_000, invocations: 1_380_000, originBytes: 198_000_000_000 }]);
  });

  it('leaves a day the API refuses for the next run, and keeps going', async () => {
    records['2026-11-20'] = crawlDay(0.5);
    rejectDays = new Set(['2026-11-20']);
    const result = await crawler.collectCrawlerTraffic(NOW, { from: '2026-11-19', to: '2026-11-21' });
    expect(result.days).toEqual(['2026-11-19', '2026-11-21']);
    expect(result.failed).toEqual([{ day: '2026-11-20', error: expect.stringContaining('rejected') }]);
    rejectDays = new Set();
    expect((await crawler.collectCrawlerTraffic(NOW, { from: '2026-11-19', to: '2026-11-21' })).days).toEqual(['2026-11-20']);
    expect((await rows('2026-11-20')).find((row) => row.family === 'claude')?.originBytes).toBe(49_500_000_000);
  });

  it('stops on a refused token, and the cron route says so', async () => {
    refuseToken = true;
    await expect(crawler.collectCrawlerTraffic(NOW, { from: '2026-11-18', to: '2026-11-18' })).rejects.toBeInstanceOf(VercelApiError);
    const response = await cron(withSecret('/api/cron/crawler-traffic?from=2026-11-18&to=2026-11-18'));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'vercel_token_refused', status: 403 });
    const marked = await db().execute(sql`select 1 from ${schema.crawlerTrafficFetch} where day = '2026-11-18'`);
    expect(marked.rows).toHaveLength(0);
  });

  it('refreshes the last billing days on every run, replacing them', async () => {
    calls.length = 0;
    charges = [charge('2026-11-23', 'Fast Origin Transfer', 30, 500), charge('2026-11-23', 'Fluid Active CPU', 3.4, 10)];
    await crawler.collectCrawlerTraffic(NOW, { from: '2026-11-23', to: '2026-11-23' });
    /* `from` re-reads the bill from that day, through today (UTC). */
    expect(calls.find((call) => call.path.startsWith('/v1/billing'))?.path).toBe('/v1/billing/charges?from=2026-11-23T00:00:00.000Z&to=2026-11-25T00:00:00.000Z');
    const stored = await db().execute<{ day: string; service: string; cost: string }>(sql`
      select to_char(day, 'YYYY-MM-DD') as day, service, cost from ${schema.infraChargeDay} where scope = 'project' order by day, service`);
    expect(stored.rows.map((row) => [row.day, row.service, Number(row.cost)])).toEqual([
      ['2026-11-22', 'Fast Origin Transfer', 31],
      ['2026-11-22', 'Function Invocations', 1.2],
      ['2026-11-23', 'Fast Origin Transfer', 30],
      ['2026-11-23', 'Fluid Active CPU', 3.4],
    ]);
  });

  it('reports a range by family, route and day, with the bill shared out', async () => {
    const report = await crawler.crawlerReport(await consoleAdministrator(), { start: dayStart('2026-11-22'), end: dayStart('2026-11-24') }, NOW);
    expect(report.configured).toBe(true);
    expect(report.fetchedThrough).toBe('2026-11-23');
    expect(report.fetchedDays).toBe(2);
    expect(report.families.map((row) => row.family)).toEqual(['claude', 'openai', 'bot', 'human']);
    const claude = report.families[0]!;
    expect(claude).toMatchObject({ requests: 2_100_000, originBytes: 297_000_000_000, agents: [{ agent: 'ClaudeBot' }] });
    expect(report.families.find((row) => row.family === 'human')!.agents).toEqual([]);
    expect(report.totals.originBytes).toBe(297_000_000_000 + 4_000_000_000 + 200_000_000 + 76_000_000);
    expect(report.crawlers.originBytes).toBe(report.totals.originBytes - 76_000_000);
    expect(report.trend.unit).toBe('day');
    expect(report.trend.points.map((point) => [point.day, point.families.claude.originBytes])).toEqual([
      ['2026-11-22', 99_000_000_000],
      ['2026-11-23', 198_000_000_000],
    ]);
    expect(report.routes[0]).toMatchObject({ route: '/r/[slug]', top: 'claude' });
    expect(report.routes[0]!.crawlers.originBytes / report.routes[0]!.originBytes).toBeGreaterThan(0.999);
    /* The bill: this project's lines only, the team's plan apart. */
    expect(report.cost.project).toBeCloseTo(31 + 1.2 + 30 + 3.4, 6);
    expect(report.cost.team).toBeCloseTo(0.6667, 6);
    expect(report.cost.span).toEqual({ first: '2026-11-22', last: '2026-11-23' });
    const shared = report.families.reduce((sum, row) => sum + (row.cost ?? 0), 0);
    expect(shared).toBeCloseTo(report.cost.project, 6);
    expect(claude.cost!).toBeGreaterThan(report.cost.project * 0.95);
  });

  it('by default fetches every day Observability still keeps, through yesterday, and the bill from three days before the latest stored', async () => {
    calls.length = 0;
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const response = await cron(withSecret('/api/cron/crawler-traffic')).finally(() => vi.useRealTimers());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { days: string[]; remaining: number };
    expect(body.remaining).toBe(0);
    expect(body.days[0]).toBe('2026-10-26');
    expect(body.days).not.toContain('2026-11-22');
    /* 11-18 was never stored: its run was refused. */
    expect(body.days.at(-1)).toBe('2026-11-18');
    expect(calls.find((call) => call.path.startsWith('/v1/billing'))?.path).toBe('/v1/billing/charges?from=2026-11-20T00:00:00.000Z&to=2026-11-25T00:00:00.000Z');
    const fetched = await db().execute<{ n: number }>(sql`select count(*)::int as n from ${schema.crawlerTrafficFetch} where day between '2026-10-26' and '2026-11-23'`);
    expect(Number(fetched.rows[0]!.n)).toBe(29);
  });
});

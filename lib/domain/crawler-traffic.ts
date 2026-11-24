/**
 * Crawler and infrastructure traffic (console 「流量」 → 「爬虫 / 基础设施」):
 * which crawler a user agent belongs to, and how the Vercel Observability
 * and billing payloads read. Pure, so the cron, the report and the tests
 * share one definition.
 *
 * The page-view beacon (lib/domain/traffic.ts) sees people's browsers only:
 * crawlers run no JavaScript and the beacon drops bot agents. What crawlers
 * cost is read afterwards, once a day, from Vercel's own request records
 * (lib/services/crawler-traffic.ts), so counting them adds nothing to the
 * request path.
 */
import { isBotAgent } from '@/lib/domain/traffic';

/**
 * Crawler families, in display order. `bot` is every other agent the
 * beacon's bot rule matches; `human` is everything else, plus the tail the
 * per-agent query does not list (see `OBSERVABILITY_GROUP_LIMIT`).
 */
export const CRAWLER_FAMILIES = ['claude', 'openai', 'google', 'bing', 'meta', 'bot', 'human'] as const;
export type CrawlerFamily = (typeof CRAWLER_FAMILIES)[number];

/** The named families and the agent tokens that mean them (matched case-insensitively). */
const NAMED: { family: Exclude<CrawlerFamily, 'bot' | 'human'>; pattern: RegExp }[] = [
  { family: 'claude', pattern: /claudebot|claude-user|claude-searchbot|claude-web|anthropic-ai/i },
  { family: 'openai', pattern: /gptbot|chatgpt-user|oai-searchbot|chatgpt-browser/i },
  { family: 'google', pattern: /googlebot|googleother|google-extended|google-inspectiontool|google-cloudvertexbot|adsbot-google|mediapartners-google|storebot-google|apis-google|feedfetcher-google|google-read-aloud|google-site-verification|googleproducer/i },
  { family: 'bing', pattern: /bingbot|bingpreview|msnbot|adidxbot/i },
  { family: 'meta', pattern: /meta-externalagent|meta-externalfetcher|meta-webindexer|facebookexternalhit|facebookcatalog|facebookbot/i },
];

/** A token that names an unlisted bot (`Amazonbot`, `PetalBot`, `AhrefsBot` …). */
const BOT_TOKEN = /bot|crawl|spider|slurp|scrap|preview|fetch|agent|monitor|headless|lighthouse|checker/i;
/** Tokens every browser-like agent carries, never a name. */
const FILLER = /^(mozilla|compatible|applewebkit|khtml|like|gecko|chrome|safari|mobile|version|linux|android|windows|nt|win64|x64|macintosh|intel|mac|os|x|u|en-us|build|\d[\d._]*)$/i;

/** Longest stored agent label. */
export const CRAWLER_AGENT_MAX = 60;
/** The label of an agent with no user agent at all. */
export const EMPTY_AGENT = '(empty)';

/** The family a request's user agent belongs to. A missing agent is a bot, as the beacon counts it. */
export function crawlerFamily(agent: string | null | undefined): CrawlerFamily {
  const text = agent ?? '';
  for (const named of NAMED) if (named.pattern.test(text)) return named.family;
  return isBotAgent(text) ? 'bot' : 'human';
}

/**
 * A short, stable name for a crawler's agent (`ClaudeBot`, `GoogleOther`,
 * `curl`), so the console can say which bot it was without storing the full
 * string. People's browsers have none (`''`): no user agent of a person is
 * stored.
 */
export function crawlerAgent(agent: string | null | undefined, family: CrawlerFamily = crawlerFamily(agent)): string {
  if (family === 'human') return '';
  const text = (agent ?? '').trim();
  if (!text) return EMPTY_AGENT;
  const tokens = text
    .split(/[\s;()+,]+/)
    .map((token) => token.split('/')[0]!.replace(/^[^A-Za-z]+|[^A-Za-z0-9]+$/g, ''))
    .filter((token) => token && !token.includes('@') && !token.includes('.') && !token.includes(':'));
  const named = NAMED.find((entry) => entry.family === family)?.pattern;
  const pick = (named && tokens.find((token) => named.test(token))) || tokens.find((token) => BOT_TOKEN.test(token)) || tokens.find((token) => !FILLER.test(token)) || tokens[0] || EMPTY_AGENT;
  return pick.slice(0, CRAWLER_AGENT_MAX);
}

/* ------------------------------------------------------ Observability */

/** The metrics read per day: CDN requests, function invocations, and Fast Origin Transfer bytes. */
export const CRAWLER_METRICS = {
  requests: 'vercel.request.count',
  invocations: 'vercel.function_invocation.count',
  originBytes: 'vercel.function_invocation.fot_total_bytes',
} as const;
export type CrawlerMetric = keyof typeof CRAWLER_METRICS;

/** Groups the API returns at most (it refuses more than 500). */
export const OBSERVABILITY_GROUP_LIMIT = 500;
/** Routes kept per day. */
export const CRAWLER_ROUTE_LIMIT = 100;
/** Days back the Observability API still answers for (it rejected 35 days, answered 20). */
export const OBSERVABILITY_RETENTION_DAYS = 30;

/** The rollup column the API names for a metric's `sum`: `vercel.request.count` → `vercel_request_count_sum`. */
export function observabilityKey(metric: string): string {
  return `${metric.replace(/[.\-/]/g, '_')}_sum`;
}

export interface ObservabilityGroup {
  /** The grouped dimensions, by their snake-case names (`client_user_agent`, `route`); `''` for a missing one. */
  dims: Record<string, string>;
  value: number;
}

/** Why an Observability or billing call failed; `auth` stops the whole run. */
export class VercelApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'VercelApiError';
  }

  get auth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * The summary rows of an Observability query (`POST /v2/observability/query`):
 * one per group over the whole time range. An error payload throws.
 */
export function observabilityGroups(payload: unknown, metric: string, dims: readonly string[]): ObservabilityGroup[] {
  if (!payload || typeof payload !== 'object') throw new VercelApiError('Observability: not a JSON object', 502, 'bad_payload');
  const body = payload as { error?: { code?: unknown; message?: unknown }; summary?: unknown };
  if (body.error) throw new VercelApiError(`Observability: ${String(body.error.message ?? 'error')}`, 400, String(body.error.code ?? 'error'));
  if (!Array.isArray(body.summary)) throw new VercelApiError('Observability: no summary', 502, 'bad_payload');
  const key = observabilityKey(metric);
  const groups: ObservabilityGroup[] = [];
  for (const row of body.summary) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const value = Number(record[key] ?? 0);
    if (!Number.isFinite(value) || value <= 0) continue;
    const named: Record<string, string> = {};
    for (const dim of dims) named[dim] = typeof record[dim] === 'string' ? (record[dim] as string) : '';
    groups.push({ dims: named, value: Math.round(value) });
  }
  return groups;
}

export interface FamilyFigure {
  family: CrawlerFamily;
  agent: string;
  value: number;
}

/**
 * A day's per-agent groups folded into families and agent names, with the
 * part the groups do not cover (`total` minus their sum: the long tail of
 * people's browsers) added to `human`.
 */
export function foldAgents(groups: ObservabilityGroup[], total: number): FamilyFigure[] {
  const sums = new Map<string, FamilyFigure>();
  let listed = 0;
  for (const group of groups) {
    const raw = group.dims.client_user_agent ?? '';
    const family = crawlerFamily(raw);
    const agent = crawlerAgent(raw, family);
    const key = `${family}\u0000${agent}`;
    const entry = sums.get(key) ?? { family, agent, value: 0 };
    entry.value += group.value;
    sums.set(key, entry);
    listed += group.value;
  }
  const tail = Math.max(0, Math.round(total) - listed);
  if (tail > 0) {
    const key = `human\u0000`;
    const entry = sums.get(key) ?? { family: 'human' as const, agent: '', value: 0 };
    entry.value += tail;
    sums.set(key, entry);
  }
  return [...sums.values()];
}

/* ------------------------------------------------------------ billing */

/** The Vercel billing day a charge belongs to: its period's start, in US Pacific time (where Vercel cuts them). */
const BILLING_ZONE = 'America/Los_Angeles';
const billingDayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: BILLING_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

export function billingDay(periodStart: string): string | null {
  const at = Date.parse(periodStart);
  return Number.isFinite(at) ? billingDayFormat.format(at) : null;
}

export type ChargeScope = 'project' | 'team';

export interface ChargeLine {
  day: string;
  service: string;
  scope: ChargeScope;
  /** Billed USD. */
  cost: number;
  quantity: number;
  unit: string;
}

/** Longest stored service name or unit. */
const CHARGE_LABEL_MAX = 120;

/**
 * Billing charges (`GET /v1/billing/charges`, FOCUS JSONL) for one project,
 * by billing day and service. Lines tagged with another project are
 * skipped; untagged lines are the team's own (its plan, seats) and kept as
 * `team`. Lines that cost nothing and measured nothing are dropped.
 */
export function parseCharges(jsonl: string, projectId: string): ChargeLine[] {
  const sums = new Map<string, ChargeLine>();
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tags = (record.Tags && typeof record.Tags === 'object' ? record.Tags : {}) as Record<string, unknown>;
    const tagged = typeof tags.ProjectId === 'string' ? tags.ProjectId : null;
    if (tagged && tagged !== projectId) continue;
    const day = typeof record.ChargePeriodStart === 'string' ? billingDay(record.ChargePeriodStart) : null;
    const service = typeof record.ServiceName === 'string' ? record.ServiceName.trim().slice(0, CHARGE_LABEL_MAX) : '';
    if (!day || !service) continue;
    const cost = Number(record.BilledCost ?? 0);
    const quantity = Number(record.ConsumedQuantity ?? 0);
    if ((!Number.isFinite(cost) || cost === 0) && (!Number.isFinite(quantity) || quantity === 0)) continue;
    const scope: ChargeScope = tagged ? 'project' : 'team';
    const key = `${day}\u0000${scope}\u0000${service}`;
    const entry = sums.get(key) ?? { day, service, scope, cost: 0, quantity: 0, unit: typeof record.ConsumedUnit === 'string' ? record.ConsumedUnit.slice(0, CHARGE_LABEL_MAX) : '' };
    entry.cost += Number.isFinite(cost) ? cost : 0;
    entry.quantity += Number.isFinite(quantity) ? quantity : 0;
    sums.set(key, entry);
  }
  return [...sums.values()];
}

/** The billing services whose cost follows traffic, and the figure each is shared out by. */
export const TRAFFIC_SERVICES: Record<string, CrawlerMetric> = {
  'Fast Origin Transfer': 'originBytes',
  'Function Invocations': 'invocations',
  'Fluid Active CPU': 'invocations',
  'Fluid Provisioned Memory': 'invocations',
  'CDN Requests': 'requests',
  'Edge Requests': 'requests',
  /* One event per request it logs. */
  'Observability Events': 'requests',
};

/**
 * What each family cost, estimated: every traffic-driven service's bill
 * shared out by the family's part of the figure that drives it (transfer
 * bytes for Fast Origin Transfer, invocations for compute, requests for the
 * CDN). An estimate: a crawler's invocation may cost more or less CPU than
 * a person's.
 */
export function estimateFamilyCost(
  services: { service: string; cost: number }[],
  families: { family: CrawlerFamily; requests: number; invocations: number; originBytes: number }[],
): Map<CrawlerFamily, number> {
  const totals = { requests: 0, invocations: 0, originBytes: 0 };
  for (const row of families) for (const key of Object.keys(totals) as CrawlerMetric[]) totals[key] += row[key];
  const out = new Map<CrawlerFamily, number>();
  for (const row of families) {
    let cost = 0;
    for (const { service, cost: billed } of services) {
      const metric = TRAFFIC_SERVICES[service];
      if (!metric || totals[metric] <= 0) continue;
      cost += (billed * row[metric]) / totals[metric];
    }
    out.set(row.family, cost);
  }
  return out;
}

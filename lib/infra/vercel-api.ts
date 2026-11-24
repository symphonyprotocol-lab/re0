/**
 * Vercel's REST API, read-only, for the console's crawler and cost figures
 * (lib/services/crawler-traffic.ts):
 *
 * - `POST /v2/observability/query` -- what `vercel metrics` calls: one
 *   metric, summed, grouped by dimensions, over a time range;
 * - `GET /v1/billing/charges` -- what `vercel billing usage` reads: FOCUS
 *   JSONL charges by day and service.
 *
 * Authenticated with `VERCEL_OBSERVABILITY_TOKEN`, an access token of a
 * member of the team (billing charges need Owner, Member, Developer,
 * Billing or Viewer). With no token nothing is called and the console says
 * so. The team and project default to re0's own (`recall0`); the two IDs
 * are not secrets.
 */
import { observabilityGroups, VercelApiError, type ObservabilityGroup } from '@/lib/domain/crawler-traffic';

const API = 'https://api.vercel.com';
const DEFAULT_TEAM_ID = 'team_gQB9RyFYxD5ff0CnXE5JAbDc';
const DEFAULT_PROJECT_ID = 'prj_lRE4xUOnAwhlrkaOHhvqlKy3thMk';
/** Retries of a call Vercel answers 429 or 5xx, with this pause before each (or its Retry-After, up to 10 s). */
const RETRIES = 2;
const RETRY_PAUSE_MS = 1_000;
const TIMEOUT_MS = 30_000;

export interface VercelApiConfig {
  token: string;
  teamId: string;
  projectId: string;
}

/** The configuration, or null when `VERCEL_OBSERVABILITY_TOKEN` is not set. */
export function vercelApiConfig(env: Record<string, string | undefined> = process.env): VercelApiConfig | null {
  const token = env.VERCEL_OBSERVABILITY_TOKEN?.trim();
  if (!token) return null;
  return {
    token,
    teamId: env.VERCEL_OBSERVABILITY_TEAM_ID?.trim() || DEFAULT_TEAM_ID,
    projectId: env.VERCEL_OBSERVABILITY_PROJECT_ID?.trim() || env.VERCEL_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID,
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(config: VercelApiConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${API}${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(config.teamId)}`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= RETRIES) return response;
    const after = Number(response.headers.get('retry-after'));
    await pause(Number.isFinite(after) && after > 0 ? Math.min(after * 1_000, 10_000) : RETRY_PAUSE_MS * (attempt + 1));
  }
}

async function failure(response: Response, what: string): Promise<VercelApiError> {
  let code = `http_${response.status}`;
  let message = `${what}: HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (body.error?.code) code = String(body.error.code);
    if (body.error?.message) message = `${what}: ${String(body.error.message)}`;
  } catch {
    /* not JSON */
  }
  return new VercelApiError(message, response.status, code);
}

export interface ObservabilityQuery {
  metric: string;
  groupBy?: readonly string[];
  limit?: number;
  /** `[start, end)` in epoch milliseconds. */
  start: number;
  end: number;
}

/** One metric summed over `[start, end)` for the project, by `groupBy` (no groups: one total row). */
export async function queryObservability(config: VercelApiConfig, query: ObservabilityQuery): Promise<ObservabilityGroup[]> {
  const groupBy = query.groupBy ?? [];
  const response = await call(config, '/v2/observability/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      metric: query.metric,
      aggregation: 'sum',
      scope: { type: 'project', ownerId: config.teamId, projectIds: [config.projectId] },
      ...(groupBy.length ? { groupBy, limit: query.limit ?? 10, orderDirection: 'desc' } : {}),
      startTime: new Date(query.start).toISOString(),
      endTime: new Date(query.end).toISOString(),
      granularity: { days: 1 },
      bucketTimezone: 'Asia/Shanghai',
      summaryOnly: true,
    }),
  });
  if (!response.ok) throw await failure(response, 'Observability');
  return observabilityGroups(await response.json(), query.metric, groupBy);
}

/** The team's billing charges over `[from, to)` (UTC instants, whole days), as FOCUS JSONL text. */
export async function fetchCharges(config: VercelApiConfig, from: number, to: number): Promise<string> {
  const query = `from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`;
  const response = await call(config, `/v1/billing/charges?${query}`, { headers: { accept: 'application/jsonl' } });
  if (!response.ok) throw await failure(response, 'Billing');
  return response.text();
}

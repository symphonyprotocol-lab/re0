/**
 * The arithmetic behind the public status page. requirement.md 13.3: the
 * platform's own tables are the monitor, so every figure here is derived from
 * rows the product wrote while serving -- never a fixture, never an entry
 * someone typed. Pure, so the derivation is checked without a database.
 *
 * A component is a surface with its own failure signal:
 *
 * - `retrieval`: `request_log` -- every REST, MCP and playground retrieval
 *   leaves one row with a status code and a latency;
 * - `indexing`: `workflow_operation` -- builds and refreshes finish as
 *   `succeeded`, `skipped` or `failed`;
 * - `refresh`: the refresh schedule -- a timed source whose due time has
 *   passed by more than a day is a refresh the platform owes.
 *
 * The review queue was a component until 2026-10-23, when public review
 * before publication ended; nothing waits on the platform any more.
 *
 * An incident is a run of days on which a component's failure rate crossed
 * its threshold. It is derived every time the page renders and has no prose
 * of its own: what happened is exactly what the rows say happened.
 */

export const STATUS_WINDOW_DAYS = 90;

export type ComponentId = 'retrieval' | 'indexing' | 'refresh';

export const COMPONENT_IDS: readonly ComponentId[] = ['retrieval', 'indexing', 'refresh'];

export type Health = 'ok' | 'degraded' | 'unknown';

/** One UTC day of the API log. */
export interface ApiDay {
  /** `YYYY-MM-DD`. */
  day: string;
  requests: number;
  /** 5xx responses: what the platform failed to serve. 4xx is the caller's. */
  failures: number;
  p95Ms: number | null;
}

/** One UTC day of finished build and refresh operations. */
export interface OperationDay {
  day: string;
  finished: number;
  failed: number;
}

export interface RefreshFacts {
  /** Timed sources the scheduler watches. */
  scheduled: number;
  /** Timed sources past due by more than the grace period. */
  overdue: number;
  /** Refreshes queued or running now. */
  open: number;
  nextDueAt: Date | null;
}

export interface StatusFacts {
  now: Date;
  api: ApiDay[];
  operations: OperationDay[];
  refresh: RefreshFacts;
}

/** A day on a component's 90-day strip. */
export interface StripDay {
  day: string;
  /** Null when nothing happened that day: drawn as "no data", not as healthy. */
  health: Health | null;
}

export interface ComponentStatus {
  id: ComponentId;
  health: Health;
  /** Success share over the window in basis points; null with no traffic. */
  successBps: number | null;
  /** The window's daily strip, oldest first. Empty for a component without history. */
  strip: StripDay[];
  /** Today's figures, for the line under the name. */
  today: {
    requests?: number;
    p95Ms?: number | null;
    finished?: number;
    failed?: number;
  };
}

export interface Incident {
  component: ComponentId;
  /** First and last degraded day, `YYYY-MM-DD`. */
  from: string;
  to: string;
  days: number;
  /** Worst daily failure share in the run, in basis points. */
  peakFailureBps: number;
  /** Still degraded today. */
  ongoing: boolean;
}

export interface PlatformStatus {
  checkedAt: Date;
  windowDays: number;
  components: ComponentStatus[];
  incidents: Incident[];
  refresh: RefreshFacts;
}

/**
 * Thresholds. A day counts as degraded only with enough traffic to mean it:
 * one failed request in a day of three is not an outage, it is a Tuesday.
 */
export const THRESHOLDS = {
  /** 5xx share above which a day of the API is degraded (1%, as the console's health panel). */
  apiFailureBps: 100,
  /** Requests a day needs before its failure share is read at all. */
  apiMinRequests: 20,
  /** Failed share of finished operations above which a day is degraded. */
  operationFailureBps: 2_500,
  operationMinFinished: 2,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function dayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** The window's days, oldest first, ending today (UTC). */
export function windowDays(now: Date, days = STATUS_WINDOW_DAYS): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) =>
    dayKey(new Date(today - (days - 1 - index) * DAY_MS)),
  );
}

export function shareBps(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10_000);
}

function apiDayHealth(day: ApiDay | undefined): Health | null {
  if (!day || day.requests === 0) return null;
  if (day.requests < THRESHOLDS.apiMinRequests) return 'ok';
  return shareBps(day.failures, day.requests) > THRESHOLDS.apiFailureBps ? 'degraded' : 'ok';
}

function operationDayHealth(day: OperationDay | undefined): Health | null {
  if (!day || day.finished === 0) return null;
  if (day.finished < THRESHOLDS.operationMinFinished) return day.failed > 0 ? 'degraded' : 'ok';
  return shareBps(day.failed, day.finished) > THRESHOLDS.operationFailureBps ? 'degraded' : 'ok';
}

/**
 * The window's strip for a daily series. A day with no rows stays null: the
 * page draws it as "no data" rather than claiming a hundred quiet days were
 * a hundred healthy ones.
 */
export function buildStrip<T extends { day: string }>(
  days: readonly string[],
  series: readonly T[],
  judge: (day: T | undefined) => Health | null,
): StripDay[] {
  const byDay = new Map(series.map((row) => [row.day, row]));
  return days.map((day) => ({ day, health: judge(byDay.get(day)) }));
}

/** The component's headline: today's day if it has traffic, else the last day that had any. */
function currentHealth(strip: StripDay[]): Health {
  for (let index = strip.length - 1; index >= 0; index -= 1) {
    const health = strip[index]!.health;
    if (health !== null) return health;
  }
  return 'unknown';
}

/**
 * Runs of degraded days, one incident each. A run that reaches today is
 * ongoing; a gap of a healthy or empty day closes the run.
 */
export function deriveIncidents(
  component: ComponentId,
  strip: readonly StripDay[],
  failureBpsOf: (day: string) => number,
): Incident[] {
  const incidents: Incident[] = [];
  let run: { from: string; to: string; days: number; peak: number } | null = null;
  const last = strip[strip.length - 1]?.day;
  const close = () => {
    if (!run) return;
    incidents.push({
      component,
      from: run.from,
      to: run.to,
      days: run.days,
      peakFailureBps: run.peak,
      ongoing: run.to === last,
    });
    run = null;
  };
  for (const entry of strip) {
    if (entry.health === 'degraded') {
      const bps = failureBpsOf(entry.day);
      if (run) {
        run.to = entry.day;
        run.days += 1;
        run.peak = Math.max(run.peak, bps);
      } else {
        run = { from: entry.day, to: entry.day, days: 1, peak: bps };
      }
    } else {
      close();
    }
  }
  close();
  return incidents.reverse();
}

export function summarizeStatus(facts: StatusFacts): PlatformStatus {
  const days = windowDays(facts.now);
  const today = days[days.length - 1]!;

  const apiByDay = new Map(facts.api.map((row) => [row.day, row]));
  const opsByDay = new Map(facts.operations.map((row) => [row.day, row]));

  const apiStrip = buildStrip(days, facts.api, apiDayHealth);
  const opsStrip = buildStrip(days, facts.operations, operationDayHealth);

  const apiTotals = facts.api.reduce(
    (sum, row) => ({ requests: sum.requests + row.requests, failures: sum.failures + row.failures }),
    { requests: 0, failures: 0 },
  );
  const opsTotals = facts.operations.reduce(
    (sum, row) => ({ finished: sum.finished + row.finished, failed: sum.failed + row.failed }),
    { finished: 0, failed: 0 },
  );

  const apiToday = apiByDay.get(today);
  const opsToday = opsByDay.get(today);

  const retrieval: ComponentStatus = {
    id: 'retrieval',
    health: currentHealth(apiStrip),
    successBps:
      apiTotals.requests > 0
        ? 10_000 - shareBps(apiTotals.failures, apiTotals.requests)
        : null,
    strip: apiStrip,
    today: { requests: apiToday?.requests ?? 0, p95Ms: apiToday?.p95Ms ?? null },
  };

  const indexing: ComponentStatus = {
    id: 'indexing',
    health: currentHealth(opsStrip),
    successBps:
      opsTotals.finished > 0 ? 10_000 - shareBps(opsTotals.failed, opsTotals.finished) : null,
    strip: opsStrip,
    today: { finished: opsToday?.finished ?? 0, failed: opsToday?.failed ?? 0 },
  };

  /* Refresh is a state, not a log: the tables hold what is due now, not
     what was due last month, so it has a health and no strip. */
  const refresh: ComponentStatus = {
    id: 'refresh',
    health:
      facts.refresh.scheduled === 0 ? 'unknown' : facts.refresh.overdue > 0 ? 'degraded' : 'ok',
    successBps:
      facts.refresh.scheduled > 0
        ? 10_000 - shareBps(facts.refresh.overdue, facts.refresh.scheduled)
        : null,
    strip: [],
    today: {},
  };

  const incidents = [
    ...deriveIncidents('retrieval', apiStrip, (day) => {
      const row = apiByDay.get(day);
      return row ? shareBps(row.failures, row.requests) : 0;
    }),
    ...deriveIncidents('indexing', opsStrip, (day) => {
      const row = opsByDay.get(day);
      return row ? shareBps(row.failed, row.finished) : 0;
    }),
  ].sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : 0));

  return {
    checkedAt: facts.now,
    windowDays: days.length,
    components: [retrieval, indexing, refresh],
    incidents,
    refresh: facts.refresh,
  };
}

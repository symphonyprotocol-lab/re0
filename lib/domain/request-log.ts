/**
 * Reading the request-log screen's query string. requirement.md 5.2 (调用记录):
 * time, status, entrypoint and asset filters, plus free-text search, all as
 * GET parameters so a filtered page is a URL the user can keep -- and all
 * narrowed here before anything reaches a query.
 */

export const REQUEST_ENTRYPOINTS = ['rest', 'mcp', 'web'] as const;

export type RequestEntrypoint = (typeof REQUEST_ENTRYPOINTS)[number];

export const REQUEST_STATUSES = ['ok', 'error'] as const;

export type RequestStatusFilter = (typeof REQUEST_STATUSES)[number];

/** One page of the log. Exports walk the whole filtered set instead. */
export const REQUEST_PAGE_SIZE = 50;

/** The furthest offset a typed URL may ask Postgres to walk. */
export const REQUEST_MAX_PAGE = 10_000;

export interface RequestFilter {
  /** Inclusive, UTC midnight of the given day. */
  from?: Date;
  /** Exclusive: UTC midnight of the day after the given day. */
  to?: Date;
  status?: RequestStatusFilter;
  entrypoint?: RequestEntrypoint;
  /** An asset public id, exactly as the log stores it. */
  asset?: string;
  /** Free text over request id, operation and asset id. */
  query?: string;
  page: number;
}

type Params = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` to a UTC instant, or undefined for anything else. */
export function parseDay(value: string | undefined, endExclusive = false): Date | undefined {
  if (!value) return undefined;
  const match = DAY.exec(value.trim());
  if (!match) return undefined;
  const [, year, month, day] = match;
  /*
   * The typed day is validated before anything is added to it. `Date.UTC`
   * rolls an impossible date over rather than refusing -- 2026-02-31 becomes
   * 2026-03-03 -- so the round-trip check has to run on the day the user
   * actually typed. Doing it after the +1 of an exclusive end would compare a
   * different day and accept every rollover: `to=2026-13-45` silently became
   * 2027-02-15, and the screen then disagreed with the URL it echoed back.
   */
  const typed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(typed.getTime())) return undefined;
  if (typed.toISOString().slice(0, 10) !== value.trim()) return undefined;
  if (!endExclusive) return typed;
  return new Date(typed.getTime() + 86_400_000);
}

export function isRequestEntrypoint(value: unknown): value is RequestEntrypoint {
  return typeof value === 'string' && (REQUEST_ENTRYPOINTS as readonly string[]).includes(value);
}

/**
 * Falls back rather than throwing on every field: a hand-edited URL should
 * show the unfiltered log, not a 500. An inverted range (to before from) is
 * kept as typed -- it simply matches nothing, which is the truth about it.
 */
export function parseRequestFilter(params: Params): RequestFilter {
  const status = single(params.status);
  const entrypoint = single(params.entrypoint);
  const asset = single(params.asset)?.trim().slice(0, 200);
  const query = single(params.q)?.trim().slice(0, 200);
  const rawPage = Number.parseInt(single(params.page) ?? '', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(rawPage, REQUEST_MAX_PAGE) : 1;

  return {
    from: parseDay(single(params.from)),
    to: parseDay(single(params.to), true),
    status:
      status && (REQUEST_STATUSES as readonly string[]).includes(status)
        ? (status as RequestStatusFilter)
        : undefined,
    entrypoint: isRequestEntrypoint(entrypoint) ? entrypoint : undefined,
    asset: asset ? asset : undefined,
    query: query ? query : undefined,
    page,
  };
}

/** The filter back to a query string, for pagination links and the export. */
export function requestFilterParams(filter: RequestFilter, page?: number): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.query) params.set('q', filter.query);
  if (filter.from) params.set('from', filter.from.toISOString().slice(0, 10));
  if (filter.to) {
    /* `to` is stored exclusive; the URL carries the inclusive day the user typed. */
    params.set('to', new Date(filter.to.getTime() - 86_400_000).toISOString().slice(0, 10));
  }
  if (filter.status) params.set('status', filter.status);
  if (filter.entrypoint) params.set('entrypoint', filter.entrypoint);
  if (filter.asset) params.set('asset', filter.asset);
  const target = page ?? filter.page;
  if (target > 1) params.set('page', String(target));
  return params;
}

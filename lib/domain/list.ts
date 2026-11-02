/**
 * The list contract every list endpoint and page share (rebuild-proposal.md
 * 8.1, 8.3): `q`, `status`, `sort`, `size`, `page` in, `{items, total, page,
 * size}` out; an out-of-range page is pulled back to the last one.
 */
export interface ListQuery<S extends string, O extends string> {
  q: string;
  status: S;
  sort: O;
  size: number;
  page: number;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

export function param(params: Params, name: string): string {
  if (params instanceof URLSearchParams) return params.get(name) ?? '';
  const value = params[name];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

export function parseList<S extends string, O extends string>(
  params: Params,
  options: { statuses: readonly S[]; sorts: readonly O[]; sizes: readonly number[] },
): ListQuery<S, O> {
  const status = param(params, 'status') as S;
  const sort = param(params, 'sort') as O;
  const size = Number(param(params, 'size'));
  const page = Number(param(params, 'page'));
  return {
    q: param(params, 'q').trim().slice(0, 200),
    status: options.statuses.includes(status) ? status : options.statuses[0]!,
    sort: options.sorts.includes(sort) ? sort : options.sorts[0]!,
    size: options.sizes.includes(size) ? size : options.sizes[0]!,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The page actually shown: at least 1, at most the last page that has rows. */
export function clampPage(page: number, total: number, size: number): number {
  return Math.min(Math.max(1, page), Math.max(1, Math.ceil(total / size)));
}

/** `%`, `_` and `\` typed into a search box match themselves. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

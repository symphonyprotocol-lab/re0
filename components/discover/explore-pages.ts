import { EXPLORE_BATCH_SIZES } from '@/lib/constants';
import { explorePath, exploreReturnPath, type ExploreQuery } from '@/lib/domain/explore';

/**
 * `/explore`'s numbered pages (GSC review 2026-11, A9): the list still
 * scrolls in batches from `GET /api/explore`, but a crawler follows no
 * scrolling, so each category and the whole list also have plain
 * `?page=N` links, one first batch's worth of Rees a page in the same
 * order. Shared by the page (server) and the list (browser).
 */

/** Rees on one numbered page: the batch the list starts with. */
export const EXPLORE_PAGE_SIZE = EXPLORE_BATCH_SIZES[0];

/** `?page=`: absent is page 1; a whole number from 2 up is that page; anything else -- `1` spelled out, 0, `2x` -- is null, the page's own URL being without it. */
export function parseExplorePage(raw: string | string[] | undefined | null): number | null {
  if (raw === undefined || raw === null) return 1;
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  return /^[1-9][0-9]{0,5}$/.test(value) && value !== '1' ? Number(value) : null;
}

/** How many numbered pages `total` Rees fill (at least one, the empty list's). */
export function explorePageCount(total: number): number {
  return Math.max(1, Math.ceil(total / EXPLORE_PAGE_SIZE));
}

function withPage(path: string, page: number): string {
  return page > 1 ? `${path}${path.includes('?') ? '&' : '?'}page=${page}` : path;
}

/** The explore path with its page; a search has no pages (it shows its best matches at once). */
export function explorePagePath(query: Partial<ExploreQuery>, page: number): string {
  return withPage(explorePath(query), query.q ? 1 : page);
}

/** A remembered way back to explore (components/discover/public-visit.tsx): its search, category, sort and page; anything else is `/explore`. */
export function exploreBackPath(value: string | null | undefined): string {
  const base = exploreReturnPath(value);
  if (base.includes('q=') || !value?.startsWith('/explore?')) return base;
  return withPage(base, parseExplorePage(new URLSearchParams(value.slice('/explore?'.length)).get('page')) ?? 1);
}

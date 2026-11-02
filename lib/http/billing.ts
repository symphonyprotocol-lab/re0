/** The billing tab's ledger query, shared by `/api/billing/entries` and the page: `activity`, `page`, `size`. */
import { ACTIVITIES, type Activity } from '@/lib/domain/billing';
import { param } from '@/lib/domain/list';

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

export function parseActivity(params: Params, sizes: readonly number[]): { activity: Activity; page: number; size: number } {
  const activity = param(params, 'activity') as Activity;
  const size = Number(param(params, 'size'));
  const page = Number(param(params, 'page'));
  return {
    activity: ACTIVITIES.includes(activity) ? activity : 'all',
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    size: sizes.includes(size) ? size : sizes[0]!,
  };
}

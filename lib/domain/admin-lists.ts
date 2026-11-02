/**
 * The console's list filters (8.1, prototype admin-scale.js `adminRecordView`,
 * admin-ree.js, user-role-domain.js): what each list accepts in its URL, with
 * anything unknown falling back to the default, and the canonical URL that
 * leaves defaults out. The list endpoint and its `?format=csv` read the same
 * view, so an export is exactly the filtered list.
 */
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/domain/audit';
import { param } from '@/lib/domain/list';
import { USER_ROLES, type UserRole } from '@/lib/domain/roles';

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function pick<T extends string>(params: Params, name: string, values: readonly T[], fallback: T): T {
  const value = param(params, name);
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function common(params: Params) {
  const size = Number(param(params, 'size'));
  const page = Number(param(params, 'page'));
  return {
    q: param(params, 'q').trim().slice(0, 400),
    size: (LIST_PAGE_SIZES as readonly number[]).includes(size) ? size : LIST_PAGE_SIZES[0],
    page: Number.isFinite(page) && page >= 1 ? Math.min(100_000, Math.floor(page)) : 1,
  };
}

export const RECENT_PERIODS = ['all', '7', '30', '90'] as const;
export type RecentPeriod = (typeof RECENT_PERIODS)[number];

/** The instant a "last N days" filter starts at, or null for all time. */
export function periodStart(period: RecentPeriod, now: Date = new Date()): Date | null {
  return period === 'all' ? null : new Date(now.getTime() - Number(period) * 24 * 60 * 60 * 1000);
}

export const ACCOUNT_STATUSES = ['active', 'disabled'] as const;
export const MEMBERSHIP_STATES = ['active', 'cancelled', 'expired', 'none'] as const;
export type Membership = (typeof MEMBERSHIP_STATES)[number];
/** KYC states the users list filters on; every user reads `none` until step 6 brings `kyc_record`. */
export const USER_KYC_STATES = ['none', 'pending', 'verified', 'rejected', 'reset'] as const;
export type UserKyc = (typeof USER_KYC_STATES)[number];
export const TIME_SORTS = ['newest', 'oldest'] as const;
export const AMOUNT_SORTS = ['newest', 'oldest', 'amount-high', 'amount-low'] as const;

export function usersView(params: Params) {
  return {
    ...common(params),
    status: pick(params, 'status', ['all', ...ACCOUNT_STATUSES] as const, 'all'),
    role: pick(params, 'role', ['all', ...USER_ROLES] as const, 'all') as 'all' | UserRole,
    membership: pick(params, 'membership', ['all', ...MEMBERSHIP_STATES] as const, 'all'),
    kyc: pick(params, 'kyc', ['all', ...USER_KYC_STATES] as const, 'all'),
    period: pick(params, 'period', RECENT_PERIODS, 'all'),
    sort: pick(params, 'sort', TIME_SORTS, 'newest'),
  };
}
export type UsersView = ReturnType<typeof usersView>;

export const PURCHASE_STATUSES = ['paid', 'refunded', 'chargeback'] as const;
export const SUBSCRIPTION_STATUSES = ['active', 'cancelled', 'expired'] as const;

export function purchasesView(params: Params) {
  const tab = pick(params, 'tab', ['transactions', 'subscriptions'] as const, 'transactions');
  const subscriptions = tab === 'subscriptions';
  return {
    ...common(params),
    tab,
    status: subscriptions
      ? pick(params, 'status', ['all', ...SUBSCRIPTION_STATUSES] as const, 'all')
      : pick(params, 'status', ['all', ...PURCHASE_STATUSES] as const, 'all'),
    kind: subscriptions ? 'all' : pick(params, 'kind', ['all', 'plan', 'pack'] as const, 'all'),
    period: pick(params, 'period', RECENT_PERIODS, 'all'),
    sort: subscriptions ? pick(params, 'sort', TIME_SORTS, 'newest') : pick(params, 'sort', AMOUNT_SORTS, 'newest'),
  };
}
export type PurchasesView = ReturnType<typeof purchasesView>;

export function auditView(params: Params) {
  return {
    ...common(params),
    action: pick(params, 'action', ['all', ...AUDIT_ACTIONS] as const, 'all') as 'all' | AuditAction,
    period: pick(params, 'period', RECENT_PERIODS, 'all'),
    sort: pick(params, 'sort', TIME_SORTS, 'newest'),
  };
}
export type AuditView = ReturnType<typeof auditView>;

export const VERIFICATION_FILTERS = ['pending', 'all', 'approved', 'rejected', 'closed'] as const;

/** The queue opens on pending, oldest first; any other view is newest first. */
export function verificationsView(params: Params) {
  return { ...common(params), status: pick(params, 'status', VERIFICATION_FILTERS, 'pending') };
}
export type VerificationsView = ReturnType<typeof verificationsView>;

export const REE_VISIBILITY = ['public', 'private', 'moderated'] as const;

export function reesView(params: Params) {
  return {
    ...common(params),
    status: pick(params, 'status', ['all', ...REE_VISIBILITY] as const, 'all'),
    sort: pick(params, 'sort', TIME_SORTS, 'newest'),
  };
}
export type ReesView = ReturnType<typeof reesView>;

/** Defaults each list leaves out of its URL. */
export const LIST_DEFAULTS: Record<string, string> = {
  q: '',
  status: 'all',
  role: 'all',
  membership: 'all',
  kyc: 'all',
  period: 'all',
  sort: 'newest',
  size: String(LIST_PAGE_SIZES[0]),
  page: '1',
  action: 'all',
  tab: 'transactions',
  kind: 'all',
};

/** The order parameters appear in, as in the prototype's `adminRecordPath`. */
const KEY_ORDER = ['tab', 'q', 'status', 'role', 'membership', 'kyc', 'kind', 'period', 'action', 'sort', 'size', 'page'];

/**
 * The canonical URL of a list with `changes` applied: defaults dropped, and
 * the page reset whenever a filter (anything but the page) changes.
 */
export function listHref(
  base: string,
  view: Record<string, string | number>,
  changes: Record<string, string | number | null> = {},
  defaults: Record<string, string> = LIST_DEFAULTS,
): string {
  const next: Record<string, string> = Object.fromEntries(Object.entries(view).map(([key, value]) => [key, String(value)]));
  for (const [key, value] of Object.entries(changes)) next[key] = value === null ? (defaults[key] ?? '') : String(value);
  if (Object.keys(changes).some((key) => key !== 'page')) next.page = '1';
  const query = new URLSearchParams();
  const rank = (key: string) => (KEY_ORDER.indexOf(key) + 1 || KEY_ORDER.length + 1);
  for (const [key, value] of Object.entries(next).sort(([a], [b]) => rank(a) - rank(b))) {
    if (value === '' || value === defaults[key]) continue;
    query.set(key, value);
  }
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

/** The export link for a list: the API path with the same filters (no page) and `format=csv`. */
export function csvHref(apiBase: string, view: Record<string, string | number>, defaults: Record<string, string> = LIST_DEFAULTS): string {
  const href = listHref(apiBase, { ...view, page: 1 }, {}, defaults);
  return `${href}${href.includes('?') ? '&' : '?'}format=csv`;
}

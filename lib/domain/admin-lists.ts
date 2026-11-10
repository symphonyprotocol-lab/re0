/**
 * The console's list filters (8.1, prototype admin-scale.js `adminRecordView`,
 * admin-ree.js, user-role-domain.js): what each list accepts in its URL, with
 * anything unknown falling back to the default, and the canonical URL that
 * leaves defaults out. The list endpoint and its `?format=csv` read the same
 * view, so an export is exactly the filtered list.
 */
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { financeTime, type FinanceTime } from '@/lib/domain/admin-finance';
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/domain/audit';
import { param } from '@/lib/domain/list';
import { USER_ROLES, type UserRole } from '@/lib/domain/roles';
import type { Period } from '@/lib/domain/statistics';

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
/** KYC states the users list filters on: the state of the user's newest `kyc_record`, `none` without one. */
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

/**
 * 充值交易 filters on the finance calendar (all time / day / week / month /
 * custom, with the chart's metric); Plan 订阅 keeps its last-N-days select.
 */
export function purchasesView(params: Params, now: Date = new Date()) {
  const tab = pick(params, 'tab', ['transactions', 'subscriptions'] as const, 'transactions');
  const subscriptions = tab === 'subscriptions';
  const time: Omit<FinanceTime, 'period'> & { period: Period | RecentPeriod } = subscriptions
    ? { period: pick(params, 'period', RECENT_PERIODS, 'all'), date: '', start: '', end: '', metric: 'amount' }
    : financeTime(params, now);
  return {
    ...common(params),
    tab,
    status: subscriptions
      ? pick(params, 'status', ['all', ...SUBSCRIPTION_STATUSES] as const, 'all')
      : pick(params, 'status', ['all', ...PURCHASE_STATUSES] as const, 'all'),
    kind: subscriptions ? 'all' : pick(params, 'kind', ['all', 'plan', 'pack'] as const, 'all'),
    ...time,
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

/* ------------------------------------------------------- redeem codes */

export const REDEEM_BATCH_PHASES = ['active', 'scheduled', 'expired', 'disabled'] as const;

/** 兑换码 batches: phase, kind, last N days; `q` is a batch name, a whole code or a code's last four. */
export function redeemBatchesView(params: Params) {
  return {
    ...common(params),
    status: pick(params, 'status', ['all', ...REDEEM_BATCH_PHASES] as const, 'all'),
    kind: pick(params, 'kind', ['all', 'plan', 'pack'] as const, 'all'),
    period: pick(params, 'period', RECENT_PERIODS, 'all'),
    sort: pick(params, 'sort', TIME_SORTS, 'newest'),
  };
}
export type RedeemBatchesView = ReturnType<typeof redeemBatchesView>;

export const REDEEM_CODE_FILTERS = ['all', 'available', 'used_up', 'disabled'] as const;

/** One batch's two tables: its codes (`q` = last four or a whole code) and its redemptions (`q` = user name or email). */
export function redeemBatchView(params: Params) {
  return {
    ...common(params),
    tab: pick(params, 'tab', ['codes', 'redemptions'] as const, 'codes'),
    status: pick(params, 'status', REDEEM_CODE_FILTERS, 'all'),
  };
}
export type RedeemBatchView = ReturnType<typeof redeemBatchView>;

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
  date: '',
  start: '',
  end: '',
  metric: 'amount',
};

/** A redeem batch's page opens on its codes. */
export const REDEEM_BATCH_DEFAULTS: Record<string, string> = { ...LIST_DEFAULTS, tab: 'codes' };

/** The order parameters appear in, as in the prototype's `adminRecordPath`. */
const KEY_ORDER = ['tab', 'q', 'status', 'role', 'membership', 'kyc', 'kind', 'period', 'date', 'start', 'end', 'metric', 'action', 'sort', 'size', 'page'];

/**
 * The canonical URL of a list with `changes` applied: defaults dropped, and
 * the page reset whenever a filter changes (not the page, nor the finance
 * chart's metric, which leaves the list as it is).
 */
export function listHref(
  base: string,
  view: Record<string, string | number>,
  changes: Record<string, string | number | null> = {},
  defaults: Record<string, string> = LIST_DEFAULTS,
): string {
  const next: Record<string, string> = Object.fromEntries(Object.entries(view).map(([key, value]) => [key, String(value)]));
  for (const [key, value] of Object.entries(changes)) next[key] = value === null ? (defaults[key] ?? '') : String(value);
  if (Object.keys(changes).some((key) => key !== 'page' && key !== 'metric')) next.page = '1';
  const query = new URLSearchParams();
  const rank = (key: string) => (KEY_ORDER.indexOf(key) + 1 || KEY_ORDER.length + 1);
  for (const [key, value] of Object.entries(next).sort(([a], [b]) => rank(a) - rank(b))) {
    if (value === '' || value === defaults[key]) continue;
    query.set(key, value);
  }
  const text = query.toString();
  return text ? `${base}?${text}` : base;
}

/** The export link for a list: the API path with the same filters (no page, no chart metric) and `format=csv`. */
export function csvHref(apiBase: string, view: Record<string, string | number>, defaults: Record<string, string> = LIST_DEFAULTS): string {
  const href = listHref(apiBase, { ...view, page: 1, metric: '' }, {}, defaults);
  return `${href}${href.includes('?') ? '&' : '?'}format=csv`;
}

/* ------------------------------------------------------- step 6: KYC, payouts */

export const KYC_FILTERS = ['all', 'pending', 'verified', 'rejected', 'reset'] as const;

/** KYC records: every submission, oldest first by default (8.4 step 6 "最早优先"). */
export function kycView(params: Params) {
  return {
    ...common(params),
    status: pick(params, 'status', KYC_FILTERS, 'all'),
    period: pick(params, 'period', RECENT_PERIODS, 'all'),
    sort: pick(params, 'sort', TIME_SORTS, 'oldest'),
  };
}
export type KycView = ReturnType<typeof kycView>;
export const KYC_DEFAULTS: Record<string, string> = { ...LIST_DEFAULTS, sort: 'oldest' };

export const PAYOUT_QUEUE_FILTERS = ['all', 'pending', 'approved'] as const;
export const PAYOUT_HISTORY_FILTERS = ['all', 'pending', 'approved', 'paid', 'failed', 'rejected'] as const;

/** 提现审核: only requests in progress, oldest first, on the finance calendar by request time. */
export function payoutQueueView(params: Params, now: Date = new Date()) {
  return {
    ...common(params),
    status: pick(params, 'status', PAYOUT_QUEUE_FILTERS, 'all'),
    ...financeTime(params, now),
    sort: pick(params, 'sort', AMOUNT_SORTS, 'oldest'),
  };
}
export type PayoutQueueView = ReturnType<typeof payoutQueueView>;
export const PAYOUT_QUEUE_DEFAULTS: Record<string, string> = { ...LIST_DEFAULTS, sort: 'oldest' };

/** 提现记录: every request in any of the five states, newest first, on the finance calendar by request time. */
export function payoutHistoryView(params: Params, now: Date = new Date()) {
  return {
    ...common(params),
    status: pick(params, 'status', PAYOUT_HISTORY_FILTERS, 'all'),
    ...financeTime(params, now),
    sort: pick(params, 'sort', AMOUNT_SORTS, 'newest'),
  };
}
export type PayoutHistoryView = ReturnType<typeof payoutHistoryView>;

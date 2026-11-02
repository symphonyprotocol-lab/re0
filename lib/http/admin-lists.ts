/**
 * The console's list endpoints and their exports share one shape: parse the
 * view from the query, answer `{items, total, page, size}` -- or, with
 * `?format=csv`, every row the same filters match (8.2 "后台 CSV").
 */
import { NextResponse } from 'next/server';
import { toCsv } from '@/lib/domain/csv';
import type { ListResult } from '@/lib/domain/list';
import { reportingTime } from '@/lib/domain/statistics';
import { fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import type { AdminReeRow } from '@/lib/services/admin-rees';
import type { AdminUserRow } from '@/lib/services/admin-users';
import type { AuditRow } from '@/lib/services/admin-audit';
import type { PurchaseRow, SubscriptionRow } from '@/lib/services/admin-purchases';
import type { VerificationListItem } from '@/lib/services/roles';

export function csvResponse(name: string, headers: readonly string[], rows: readonly (readonly unknown[])[]): NextResponse {
  return new NextResponse(toCsv(headers, rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="re0-${name}-${new Date().toISOString().slice(0, 10)}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

export function wantsCsv(request: Request): boolean {
  return new URL(request.url).searchParams.get('format') === 'csv';
}

/** A list endpoint: JSON page, or the full filtered export. */
export async function listOrCsv<T>(
  request: Request,
  load: (all: boolean) => Promise<ListResult<T>>,
  csv: { name: string; headers: readonly string[]; row: (item: T) => readonly unknown[] },
): Promise<NextResponse> {
  if (wantsCsv(request)) {
    const { items } = await load(true);
    return csvResponse(csv.name, csv.headers, items.map(csv.row));
  }
  return json(await load(false));
}

const STATUS: Record<string, number> = { not_found: 404, stale: 409, job_running: 409, payout_pending: 409, email_taken: 409, self: 409, owner: 409 };

/** An `AdminInputError` as the response the console expects; anything else is rethrown. */
export function adminFailure(error: unknown): NextResponse {
  if (error instanceof AdminInputError) return fail(error.code, STATUS[error.code] ?? 422);
  throw error;
}

const time = (value: Date | null | undefined) => reportingTime(value);

export const USERS_CSV = {
  name: 'users',
  headers: ['ID', 'Name', 'Email', 'Role', 'Status', 'Membership', 'Plan', 'Pack', 'Earned', 'Welcome', 'KYC', 'Created (UTC+8)', 'Last sign-in (UTC+8)'],
  row: (u: AdminUserRow) => [u.id, u.name, u.email, u.role, u.status, u.membership, u.plan, u.pack, u.earned, u.welcome, u.kyc, time(u.createdAt), time(u.lastLoginAt)],
};

export const PURCHASES_CSV = {
  name: 'purchases',
  headers: ['ID', 'Name', 'Email', 'Type', 'Quantity', 'Amount', 'Currency', 'Credits', 'Reversed credits', 'Status', 'Paddle transaction', 'Created (UTC+8)'],
  row: (p: PurchaseRow) => [p.id, p.name, p.email, p.kind, p.quantity, (p.amountMinor / 100).toFixed(2), p.currency, p.credits, p.reversedCredits, p.status, p.paddleTransactionId, time(p.createdAt)],
};

export const SUBSCRIPTIONS_CSV = {
  name: 'subscriptions',
  headers: ['ID', 'Name', 'Email', 'Status', 'Renewal', 'Period start (UTC+8)', 'Period end (UTC+8)', 'Paddle subscription', 'Created (UTC+8)'],
  row: (s: SubscriptionRow) => [
    s.id,
    s.name,
    s.email,
    s.status,
    s.status === 'active' && !s.cancelAtPeriodEnd ? 'on' : 'off',
    time(s.currentPeriodStart),
    time(s.currentPeriodEnd),
    s.paddleSubscriptionId,
    time(s.createdAt),
  ],
};

export const AUDIT_CSV = {
  name: 'audit',
  headers: ['ID', 'Time (UTC+8)', 'Administrator', 'Action', 'Target', 'Before', 'After'],
  row: (a: AuditRow) => [a.id, time(a.createdAt), a.administrator ?? '', a.action, a.target ?? '', a.before ?? null, a.after ?? null],
};

export const VERIFICATIONS_CSV = {
  name: 'verifications',
  headers: ['ID', 'Name', 'Email', 'Status', 'Requirements met', 'Statement', 'Links', 'Reviewer', 'Reason', 'Submitted (UTC+8)', 'Decided (UTC+8)'],
  row: (v: VerificationListItem) => [v.id, v.name, v.email, v.status, `${v.passed}/5`, v.statement, v.links.join(' '), v.reviewer ?? '', v.rejectedReason ?? '', time(v.createdAt), time(v.decidedAt)],
};

export const REES_CSV = {
  name: 'rees',
  headers: ['ID', 'Name', 'Slug', 'Visibility', 'Owner', 'Owner email', 'Owner role', 'Query fee', 'Sources', 'Ready sources', 'Moderation reason', 'Created (UTC+8)'],
  row: (r: AdminReeRow) => [r.id, r.name, r.slug, r.visibility, r.ownerName, r.ownerEmail, r.ownerRole, r.queryFee, r.sources, r.readySources, r.moderatedReason ?? '', time(r.createdAt)],
};

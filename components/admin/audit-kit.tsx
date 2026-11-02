/**
 * Audit rows as the console shows them in three places (the audit log, the
 * overview's recent actions, a Ree's management log): time in UTC+8, who,
 * the action's label over its code, the target, and a link to the change.
 */
import Link from 'next/link';
import type { Messages, Locale } from '@/i18n';
import { formatDateTime } from '@/i18n/format';
import { RecordsTable } from '@/components/admin/list-kit';

export interface AuditLine {
  id: string;
  action: string;
  target: string | null;
  administrator: string | null;
  createdAt: Date | string;
}

export function actionLabel(t: Messages, action: string): string {
  return (t.console.actions as Record<string, string>)[action] ?? action;
}

/** Where an audit target lives in the console, by the action's family. */
export function auditTargetHref(action: string, target: string | null): string | null {
  if (!target || !/^[0-9a-f-]{36}$/i.test(target)) return null;
  if (action.startsWith('user.') || action.startsWith('verification.')) return `/admin/users/${target}`;
  if (action.startsWith('ree.')) return `/admin/rees/${target}`;
  if (action.startsWith('kyc.')) return `/admin/kyc/${target}`;
  if (action.startsWith('payout.')) return `/admin/payouts/${target}`;
  return null;
}

export function AuditTable({ t, locale, rows, from }: { t: Messages; locale: Locale; rows: AuditLine[]; from?: string }) {
  const a = t.consoleRees.audit;
  const back = from ? `?from=${encodeURIComponent(from)}` : '';
  return (
    <RecordsTable
      actions
      label={t.console.list.tableRegion}
      empty={t.console.list.empty}
      head={[a.columns.time, a.columns.administrator, a.columns.action, a.columns.target, a.columns.details]}
      rows={rows.map((row) => {
        const target = auditTargetHref(row.action, row.target);
        return [
          <span key="time" className="whitespace-nowrap">
            {formatDateTime(row.createdAt, locale)}
          </span>,
          <span key="admin" className="block max-w-[200px] truncate" title={row.administrator ?? undefined}>
            {row.administrator ?? a.system}
          </span>,
          <div key="action" className="min-w-0">
            <span className="block font-semibold">{actionLabel(t, row.action)}</span>
            <small className="block font-mono text-[11px] text-muted">{row.action}</small>
          </div>,
          row.target ? (
            target ? (
              <Link key="target" href={target} className="block max-w-[200px] font-mono text-[11px] break-all hover:text-blue">
                {row.target}
              </Link>
            ) : (
              <span key="target" className="block max-w-[200px] font-mono text-[11px] break-all">
                {row.target}
              </span>
            )
          ) : (
            <span key="target" className="text-muted">
              —
            </span>
          ),
          <Link key="view" href={`/admin/audit/${row.id}${back}`} className="btn-secondary btn-sm whitespace-nowrap">
            {a.view}
          </Link>,
        ];
      })}
    />
  );
}

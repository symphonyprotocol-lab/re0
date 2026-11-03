/**
 * Audit rows as the console shows them in three places (the audit log, the
 * overview's recent actions, a Ree's management log): time in UTC+8, who,
 * the action's label over its code, the target, and a link to the change.
 */
import Link from 'next/link';
import { Fragment } from 'react';
import type { Messages, Locale } from '@/i18n';
import { formatDateTime } from '@/i18n/format';
import { Clip, OpenLink, RecordsTable, Subline } from '@/components/admin/list-kit';

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

/**
 * The audit rows as a table. `compact` (the default) is suite.js `auditTable`,
 * used by the overview's recent actions and a Ree's management log: plain
 * cells, the action's label and the target as code, a ghost "view changes".
 * `records` is the audit log's own (admin-records.js kind `audit`): clipped
 * cells, the code under the label, and the row's open button.
 */
export function AuditTable({ t, locale, rows, from, variant = 'compact' }: { t: Messages; locale: Locale; rows: AuditLine[]; from?: string; variant?: 'compact' | 'records' }) {
  const a = t.consoleRees.audit;
  const back = from ? `?from=${encodeURIComponent(from)}` : '';
  return (
    <RecordsTable
      actions
      label={t.console.list.tableRegion}
      empty={t.console.list.empty}
      head={[a.columns.time, a.columns.administrator, a.columns.action, a.columns.target, a.columns.details]}
      rows={rows.map((row) =>
        variant === 'records'
          ? [
              formatDateTime(row.createdAt, locale),
              <Clip key="admin" value={row.administrator ?? a.system} />,
              <Fragment key="action">
                {actionLabel(t, row.action)}
                <Subline>
                  <Clip value={row.action} className="mono" />
                </Subline>
              </Fragment>,
              <Clip key="target" value={row.target} className="mono" />,
              <OpenLink key="view" href={`/admin/audit/${row.id}${back}`}>
                {a.view}
              </OpenLink>,
            ]
          : [
              formatDateTime(row.createdAt, locale),
              row.administrator ?? a.system,
              <code key="action">{actionLabel(t, row.action)}</code>,
              <code key="target">{row.target ?? '—'}</code>,
              <Link key="view" href={`/admin/audit/${row.id}${back}`} className="btn ghost sm">
                {a.view}
              </Link>,
            ],
      )}
    />
  );
}

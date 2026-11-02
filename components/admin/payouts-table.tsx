import Link from 'next/link';
import type { PayoutListItem } from '@/lib/services/payouts';
import type { Messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { RecordsTable, RoleBadge } from '@/components/admin/list-kit';
import { centsUsd, creditsUsd, KycStatusTag, PayoutStatusTag } from '@/components/admin/payout-kit';

/** Where a payout opens: an approved one on its payment page (prototype `detailPath`). */
export function payoutHref(row: Pick<PayoutListItem, 'id' | 'status'>, back: string): string {
  return `/admin/payouts/${row.id}${row.status === 'approved' ? '/payment' : ''}?from=${back}`;
}

/**
 * The rows of 提现审核 and 提现记录 (prototype admin-records.js `cells`):
 * applicant, requested and net amount, identity and tax, the PayPal address,
 * status and time, who reviewed and paid, and the way in.
 */
export function PayoutsTable({ t, locale, items, back, empty }: { t: Messages; locale: Locale; items: PayoutListItem[]; back: string; empty?: string }) {
  const p = t.consolePayouts.payouts;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <RecordsTable
      actions
      label={t.console.list.tableRegion}
      empty={empty ?? t.console.list.empty}
      head={[p.columns.applicant, p.columns.amount, p.columns.identity, p.columns.email, p.columns.status, p.columns.review, p.columns.action]}
      rows={items.map((row) => [
        <div key="applicant" className="max-w-[220px] min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <Link href={`/admin/users/${row.userId}?tab=payouts&from=${back}`} className="truncate font-semibold hover:text-blue" title={row.name}>
              {row.name}
            </Link>
            <RoleBadge t={t} role={row.role} />
          </span>
          <small className="block truncate text-muted" title={row.email}>
            {row.email}
          </small>
        </div>,
        <div key="amount" className="whitespace-nowrap">
          <strong className="font-mono">{creditsUsd(row.credits)}</strong>
          <small className="block text-muted">
            {row.status === 'paid' && row.paidCents !== null ? `${fill(p.net, { paid: centsUsd(row.paidCents) })} · ${fill(p.fee, { fee: creditsUsd(row.feeCredits ?? 0) })}` : `${n(row.credits)} credits`}
          </small>
        </div>,
        <div key="identity" className="flex flex-col items-start gap-1">
          <KycStatusTag t={t} status={row.kyc} />
          <small className="whitespace-nowrap text-muted">{row.taxForm ?? '—'}</small>
        </div>,
        <span key="email" className="block max-w-[220px] truncate" title={row.paypalEmail}>
          {row.paypalEmail}
        </span>,
        <div key="status" className="flex flex-col items-start gap-1">
          <PayoutStatusTag t={t} status={row.status} />
          <small className="whitespace-nowrap text-muted">{formatDateTime(row.createdAt, locale)}</small>
        </div>,
        <div key="review" className="max-w-[220px] min-w-0 text-[12px]">
          <span className="block truncate" title={row.reviewer ?? ''}>
            {fill(p.reviewed, { who: row.reviewer ?? '—' })}
          </span>
          {row.resolver && (
            <small className="block truncate text-muted" title={row.resolver}>
              {fill(p.resolved, { who: row.resolver })}
            </small>
          )}
          {(row.transferId || row.failureReason) && (
            <small className="block truncate font-mono text-muted" title={row.transferId ?? row.failureReason ?? ''}>
              {row.transferId ?? row.failureReason}
            </small>
          )}
        </div>,
        <Link key="action" href={payoutHref(row, back)} className={`${row.status === 'pending' || row.status === 'approved' ? 'btn' : 'btn-secondary'} btn-sm whitespace-nowrap`}>
          {row.status === 'pending' ? p.reviewAction : row.status === 'approved' ? p.payAction : p.details}
        </Link>,
      ])}
    />
  );
}

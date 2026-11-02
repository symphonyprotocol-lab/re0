import { Fragment } from 'react';
import type { PayoutListItem } from '@/lib/services/payouts';
import type { Messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { Clip, OpenLink, Person, RecordsTable, Subline } from '@/components/admin/list-kit';
import { centsUsd, creditsUsd, KycStatusTag, PayoutStatusTag } from '@/components/admin/payout-kit';

/** Where a payout opens: an approved one on its payment page (prototype `detailPath`). */
export function payoutHref(row: Pick<PayoutListItem, 'id' | 'status'>, back: string): string {
  return `/admin/payouts/${row.id}${row.status === 'approved' ? '/payment' : ''}?from=${back}`;
}

/**
 * The rows of 提现审核 and 提现记录 (prototype admin-records.js `cells`):
 * applicant, requested and net amount, identity and tax, the PayPal address,
 * status and time, who reviewed and the transfer or note, and the way in.
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
        <Person key="applicant" name={row.name} email={row.email} href={`/admin/users/${row.userId}?tab=payouts&from=${back}`} />,
        <Fragment key="amount">
          <strong className="mono">{creditsUsd(row.credits)}</strong>
          <Subline>
            {row.status === 'paid' && row.paidCents !== null
              ? `${fill(p.net, { paid: centsUsd(row.paidCents) })} · ${fill(p.fee, { fee: creditsUsd(row.feeCredits ?? 0) })}`
              : `${n(row.credits)} credits`}
          </Subline>
        </Fragment>,
        <Fragment key="identity">
          <KycStatusTag t={t} status={row.kyc} />
          <Subline>{row.taxForm ?? '—'}</Subline>
        </Fragment>,
        <Clip key="email" value={row.paypalEmail} />,
        <Fragment key="status">
          <PayoutStatusTag t={t} status={row.status} />
          <Subline>{formatDateTime(row.createdAt, locale)}</Subline>
        </Fragment>,
        <Fragment key="review">
          <Clip value={row.reviewer} />
          <Subline>
            <Clip value={row.transferId ?? row.failureReason ?? row.reviewNote} />
          </Subline>
        </Fragment>,
        <OpenLink key="action" href={payoutHref(row, back)}>
          {row.status === 'pending' ? p.reviewAction : row.status === 'approved' ? p.payAction : p.details}
        </OpenLink>,
      ])}
    />
  );
}

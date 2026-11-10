import type { Metadata } from 'next';
import { requireAdministrator } from '@/lib/http/admin';
import { notFound } from 'next/navigation';
import { Fragment, type ReactNode } from 'react';
import { param } from '@/lib/domain/list';
import { purchaseDetail } from '@/lib/services/admin-purchases';
import { formatCentsUsd } from '@/lib/domain/payouts';
import { serverMessages } from '@/i18n/server';
import { formatDateTime, formatNumber } from '@/i18n/format';
import { Clip, DetailSection, Fields, PageHead, Person, RecordsTable, Tag } from '@/components/admin/list-kit';
import { CI } from '@/components/admin/console-icon';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleUsers.purchases.detail.title };
}

function backTo(raw: string): string {
  return /^\/admin\/(purchases|users)(?:[/?]|$)/.test(raw) ? raw : '/admin/purchases';
}

/** What a webhook did, in the colour of its effect: credits in green, credits taken back in orange or red. */
function outcomeTone(outcome: string): 'green' | 'orange' | 'red' | 'grey' {
  if (/chargeback/i.test(outcome)) return 'red';
  if (/refund|revers/i.test(outcome)) return 'orange';
  if (/credit|grant|paid/i.test(outcome)) return 'green';
  return 'grey';
}

/**
 * `/admin/purchases/[id]` (prototype admin-records.js `detail()`), read-only:
 * the payment, its grant, the ledger rows and debts it caused, and every
 * Paddle notification about it ("Webhook 冲回结果").
 */
export default async function PurchaseDetailPage({ params, searchParams }: Props) {
  await requireAdministrator();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const query = await searchParams;
  const { t, locale } = await serverMessages();
  const data = await purchaseDetail(id);
  if (!data) notFound();
  const p = t.consoleUsers.purchases;
  const d = p.detail;
  const { purchase, grant, entries, events, debts } = data;
  const from = backTo(param(query, 'from'));
  const self = `/admin/purchases/${id}${from !== '/admin/purchases' ? `?from=${encodeURIComponent(from)}` : ''}`;
  const n = (value: number) => formatNumber(value, locale);
  const time = (value: Date | null | undefined) => (value ? formatDateTime(value, locale) : '—');
  const amount = purchase.currency === 'USD' ? formatCentsUsd(purchase.amountMinor) : `${(purchase.amountMinor / 100).toFixed(2)} ${purchase.currency}`;
  const mono = (value: string) => <span className="mono">{value}</span>;

  return (
    <ConsolePage>
      <ConsoleTopbar
        crumbs={[
          { label: t.console.nav.home, href: '/admin/overview' },
          { label: from.startsWith('/admin/users') ? t.console.nav.users : p.title, href: from },
          { label: data.name },
        ]}
      />
      <div className="admin-record-detail">
        <PageHead title={d.title} lede={data.name} />
        <div className="info-strip mb16">
          <CI name="info" />
          <span>{d.refundNote}</span>
        </div>
        <DetailSection title={d.record}>
          <Fields
            items={[
              [d.transaction, mono(purchase.paddleTransactionId)],
              [d.status, <Tag key="status" tone={purchase.status === 'paid' ? 'green' : purchase.status === 'refunded' ? 'grey' : 'red'}>{p.status[purchase.status]}</Tag>],
              [d.created, time(purchase.createdAt)],
              [d.user, <Person key="user" name={data.name} email={data.email} href={`/admin/users/${purchase.userId}?tab=purchases&from=${encodeURIComponent(self)}`} />],
              [d.type, p.kinds[purchase.kind]],
              [d.quantity, n(purchase.quantity)],
              [d.amount, amount],
              [d.credits, n(purchase.credits)],
              [d.reversed, n(purchase.reversedCredits)],
              ...(purchase.paddleSubscriptionId ? [[d.subscription, mono(purchase.paddleSubscriptionId)] as [ReactNode, ReactNode]] : []),
              ...(purchase.kind === 'plan' ? [[d.period, purchase.periodStart && purchase.periodEnd ? `${time(purchase.periodStart)} — ${time(purchase.periodEnd)}` : '—'] as [ReactNode, ReactNode]] : []),
            ]}
          />
        </DetailSection>

        <DetailSection title={d.grant}>
          {grant ? (
            <Fields
              items={[
                [d.grantAmount, n(grant.amount)],
                [d.remaining, n(grant.remaining)],
                [d.expires, grant.expiresAt ? time(grant.expiresAt) : d.never],
                [t.consoleUsers.detail.credits.columns.time, time(grant.createdAt)],
              ]}
            />
          ) : (
            <p className="muted small">{d.noGrant}</p>
          )}
        </DetailSection>

        <DetailSection title={d.ledger}>
          <RecordsTable
            label={t.console.list.tableRegion}
            empty={d.noLedger}
            head={[d.ledgerColumns.item, d.ledgerColumns.delta, d.ledgerColumns.note, d.ledgerColumns.time]}
            rows={entries.map((entry) => [
              t.billing.reasons[entry.reason] ?? entry.reason,
              <span key="delta" className="mono">
                {entry.delta > 0 ? '+' : ''}
                {n(entry.delta)}
              </span>,
              <Clip key="note" value={entry.note || null} />,
              time(entry.createdAt),
            ])}
          />
        </DetailSection>

        <DetailSection title={d.debts}>
          <RecordsTable
            label={t.console.list.tableRegion}
            empty={d.noDebts}
            head={[d.debtColumns.amount, d.debtColumns.remaining, d.debtColumns.created, d.debtColumns.cleared]}
            rows={debts.map((debt) => [
              <span key="amount" className="mono">
                {n(debt.amount)}
              </span>,
              <span key="remaining" className="mono">
                {n(debt.remaining)}
              </span>,
              time(debt.createdAt),
              debt.clearedAt ? time(debt.clearedAt) : d.notCleared,
            ])}
          />
        </DetailSection>

        <DetailSection title={d.webhook}>
          <p className="form-hint mb16">{d.webhookHint}</p>
          {events.length === 0 ? (
            <p className="muted small">{d.noEvents}</p>
          ) : (
            events.map((event) => (
              <Fragment key={event.id}>
                <Fields
                  items={[
                    [<span key="type" className="mono">{event.eventType}</span>, <Tag key="outcome" tone={outcomeTone(event.outcome)}>{event.outcome}</Tag>],
                    [d.eventColumns.occurred, time(event.occurredAt)],
                    [d.eventColumns.received, time(event.receivedAt)],
                  ]}
                />
                <details className="mb16">
                  <summary className="text-link">
                    {d.payload} · <span className="mono">{event.id}</span>
                  </summary>
                  <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                </details>
              </Fragment>
            ))
          )}
        </DetailSection>
      </div>
    </ConsolePage>
  );
}

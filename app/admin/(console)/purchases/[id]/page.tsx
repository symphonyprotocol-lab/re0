import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { param } from '@/lib/domain/list';
import { purchaseDetail } from '@/lib/services/admin-purchases';
import { serverMessages } from '@/i18n/server';
import { formatDateTime, formatNumber, formatUsd } from '@/i18n/format';
import { Fields, PageHead, RecordsTable, Tag } from '@/components/admin/list-kit';
import { Icon } from '@/components/ui/icons';

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

function Card({ title, hint, children, flush = false }: { title: string; hint?: string; children: ReactNode; flush?: boolean }) {
  return (
    <section className={`card min-w-0 ${flush ? 'overflow-hidden' : 'p-5'}`}>
      <div className={flush ? 'border-b border-line px-4 py-3' : 'mb-4'}>
        <h2 className="text-[15px] font-bold">{title}</h2>
        {hint && <p className="mt-1 text-[12px] text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * `/admin/purchases/[id]` (prototype admin-records.js `detail()`), read-only:
 * the payment, its grant, the ledger rows and debts it caused, and every
 * Paddle notification about it ("Webhook 冲回结果").
 */
export default async function PurchaseDetailPage({ params, searchParams }: Props) {
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
  const amount = purchase.currency === 'USD' ? formatUsd(purchase.amountMinor, locale) : `${(purchase.amountMinor / 100).toFixed(2)} ${purchase.currency}`;
  const mono = (value: string) => <span className="font-mono text-[12px] break-all">{value}</span>;

  return (
    <>
      <PageHead
        crumbs={[
          { label: t.console.nav.home, href: '/admin/overview' },
          { label: from.startsWith('/admin/users') ? t.console.nav.users : t.console.nav.purchases, href: from },
          { label: purchase.paddleTransactionId },
        ]}
        title={d.title}
        lede={
          <span className="break-all">
            {data.name} · {amount} · {purchase.paddleTransactionId}
          </span>
        }
      />
      <div className="mb-4 flex items-start gap-2 rounded-lg border border-[#cfe1fb] bg-soft px-4 py-3 text-[12px] leading-relaxed text-blue">
        <Icon name="info" className="mt-0.5 size-4 flex-none" />
        <span>{d.refundNote}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Card title={d.record}>
          <Fields
            items={[
              [
                d.user,
                <span key="user" className="block min-w-0">
                  <Link href={`/admin/users/${purchase.userId}?tab=purchases&from=${encodeURIComponent(self)}`} className="font-semibold text-blue hover:underline">
                    {data.name}
                  </Link>
                  <small className="block break-all text-muted">{data.email}</small>
                </span>,
              ],
              [d.type, p.kinds[purchase.kind]],
              [d.quantity, n(purchase.quantity)],
              [d.amount, <span key="amount" className="font-mono">{amount}</span>],
              [d.credits, <span key="credits" className="font-mono">{n(purchase.credits)}</span>],
              [d.reversed, <span key="reversed" className={`font-mono ${purchase.reversedCredits > 0 ? 'text-red' : ''}`}>{n(purchase.reversedCredits)}</span>],
              [d.status, <Tag key="status" tone={purchase.status === 'paid' ? 'green' : purchase.status === 'refunded' ? 'orange' : 'red'}>{p.status[purchase.status]}</Tag>],
              [d.transaction, mono(purchase.paddleTransactionId)],
              ...(purchase.paddleSubscriptionId ? [[d.subscription, mono(purchase.paddleSubscriptionId)] as [ReactNode, ReactNode]] : []),
              [d.created, time(purchase.createdAt)],
              ...(purchase.kind === 'plan' ? [[d.period, purchase.periodStart && purchase.periodEnd ? `${time(purchase.periodStart)} — ${time(purchase.periodEnd)}` : '—'] as [ReactNode, ReactNode]] : []),
            ]}
          />
        </Card>

        <Card title={d.grant}>
          {grant ? (
            <Fields
              items={[
                [d.grantAmount, <span key="amount" className="font-mono">{n(grant.amount)}</span>],
                [d.remaining, <span key="remaining" className="font-mono">{n(grant.remaining)}</span>],
                [d.expires, grant.expiresAt ? time(grant.expiresAt) : d.never],
                [t.consoleUsers.detail.credits.columns.time, time(grant.createdAt)],
              ]}
            />
          ) : (
            <p className="text-[13px] text-muted">{d.noGrant}</p>
          )}
        </Card>

        <Card title={d.ledger} flush>
          <RecordsTable
            label={t.console.list.tableRegion}
            empty={d.noLedger}
            head={[d.ledgerColumns.item, d.ledgerColumns.delta, d.ledgerColumns.note, d.ledgerColumns.time]}
            rows={entries.map((entry) => [
              <span key="item" className="font-semibold whitespace-nowrap">
                {t.billing.reasons[entry.reason] ?? entry.reason}
              </span>,
              <span key="delta" className={`font-mono whitespace-nowrap ${entry.delta > 0 ? 'text-green' : ''}`}>
                {entry.delta > 0 ? '+' : ''}
                {n(entry.delta)}
              </span>,
              <span key="note" className="block max-w-[320px] break-words text-muted">
                {entry.note || '—'}
              </span>,
              <span key="time" className="whitespace-nowrap">
                {time(entry.createdAt)}
              </span>,
            ])}
          />
        </Card>

        <Card title={d.debts} flush>
          <RecordsTable
            label={t.console.list.tableRegion}
            empty={d.noDebts}
            head={[d.debtColumns.amount, d.debtColumns.remaining, d.debtColumns.created, d.debtColumns.cleared]}
            rows={debts.map((debt) => [
              <span key="amount" className="font-mono">
                {n(debt.amount)}
              </span>,
              <span key="remaining" className={`font-mono ${debt.remaining > 0 ? 'text-red' : ''}`}>
                {n(debt.remaining)}
              </span>,
              <span key="created" className="whitespace-nowrap">
                {time(debt.createdAt)}
              </span>,
              <span key="cleared" className="whitespace-nowrap">
                {debt.clearedAt ? time(debt.clearedAt) : d.notCleared}
              </span>,
            ])}
          />
        </Card>

        <Card title={d.webhook} hint={d.webhookHint}>
          {events.length === 0 ? (
            <p className="text-[13px] text-muted">{d.noEvents}</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {events.map((event) => (
                <li key={event.id} className="min-w-0 rounded-lg border border-line p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="font-mono text-[12px] break-all">{event.eventType}</strong>
                    <Tag tone={outcomeTone(event.outcome)}>{event.outcome}</Tag>
                  </div>
                  <div className="mt-3">
                    <Fields
                      items={[
                        [d.eventColumns.occurred, time(event.occurredAt)],
                        [d.eventColumns.received, time(event.receivedAt)],
                      ]}
                    />
                  </div>
                  <small className="mt-1 block font-mono text-[10px] break-all text-muted">{event.id}</small>
                  <details className="group mt-2 min-w-0">
                    <summary className="text-link cursor-pointer list-none text-[12px]">
                      <Icon name="chevronRight" className="size-3.5 transition group-open:rotate-90" />
                      {d.payload}
                    </summary>
                    <pre className="mt-2 max-h-[420px] max-w-full overflow-auto rounded-lg bg-wash p-3 font-mono text-[11px] leading-relaxed">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}

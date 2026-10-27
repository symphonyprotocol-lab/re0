import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { BackfillDocument } from '@/components/admin/backfill-document';
import { BillingStatusPill } from '@/components/admin/billing-status';
import { ConsoleTrend } from '@/components/admin/console-trend';
import { dayTick, minorOnNarrow } from '@/components/dashboard/mini-trend';
import { FilterSelect } from '@/components/admin/list-controls';
import {
  CONSOLE_PANEL,
  ConsoleButton,
  ConsoleNotice,
  ConsolePageHeader,
  EmptyRow,
  ExportLink,
  IconLink,
  ListToolbar,
  Pagination,
  Panel,
  TableScroller,
  TD,
  TH,
  TitleCell,
} from '@/components/admin/ui';
import { EyeIcon, ReceiptIcon } from '@/components/ui/icons';
import {
  BILLING_DOCUMENT_KINDS,
  BILLING_STATUS_FILTERS,
  percentFromBps,
  type BillingDocumentKind,
  type BillingStatusFilter,
} from '@/lib/domain/billing';
import {
  billingRevenueTrend,
  billingSummary,
  dayParam,
  listBillingDocuments,
} from '@/lib/application/billing';
import { paddleConfig } from '@/lib/infrastructure/payment/paddle';
import { changeBps } from '@/lib/domain/overview';
import { requireAdminCapability } from '@/lib/http/admin';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { money, oneOf, PAGE_SIZE, pageNumber, pageWindow, searchTerm, utcDate } from '../list-params';
import { backfillDocumentAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.billing.title };
}

/**
 * Subscription billing -- design source frame `n7LZMz`.
 *
 * A read-only mirror, and that is a product rule rather than an unfinished
 * screen: re0 never moves money, so refunds, retries and payment links all
 * happen at the Payment Provider (requirement.md 4.3, 5.3). No row control
 * changes anything -- the two controls open the document and export the list.
 * The one server action is the backfill in the header, and it changes nothing
 * the provider did not report: it re-reads a document whose webhook was lost.
 *
 * Every figure is read from `billing_document`, which only the provider's own
 * events -- delivered, or re-read by that backfill -- write. A platform with no provider connected shows zeroes and an empty
 * table, because a billing screen that guesses is worse than one that says it
 * knows nothing. The subscription count is the exception, and deliberately so:
 * it comes from `subscription`, so it stays true before the mirror has a row.
 */
export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, params, t] = await Promise.all([
    requireAdminCapability('billing'),
    searchParams,
    getMessages(),
  ]);
  const b = t.admin.billing;
  const query = searchTerm(params.q);
  const status = oneOf(params.status, BILLING_STATUS_FILTERS, 'all');
  const kind = oneOf(params.kind, ['all', ...BILLING_DOCUMENT_KINDS] as const, 'all');
  const from = dayParam(params.from);
  const to = dayParam(params.to);
  const page = pageNumber(params.page);
  const filtered = Boolean(query) || status !== 'all' || kind !== 'all' || Boolean(from) || Boolean(to);

  const [{ rows, total }, summary, trend] = await Promise.all([
    listBillingDocuments({
      query,
      status,
      kind,
      from,
      to,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    billingSummary(),
    billingRevenueTrend({ days: TREND_DAYS, months: TREND_MONTHS, kind }),
  ]);

  const view = pageWindow({ page, total, rows: rows.length });

  const link = (target: number) => {
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (status !== 'all') next.set('status', status);
    if (kind !== 'all') next.set('kind', kind);
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    if (target > 1) next.set('page', String(target));
    return next.size > 0 ? `/admin/billing?${next.toString()}` : '/admin/billing';
  };

  if (total > 0 && page > view.pageCount) redirect(link(view.pageCount));

  const cash = (minor: number) => money(minor, summary.currency);

  /* Every bar labelled; on a phone only every other month and every fifth day. */
  const monthlyBars = trend.monthly.map((point, index) => ({
    label: point.bucket,
    minor: minorOnNarrow(index, TREND_MONTHS, 2),
    hint: fill(b.trend.hint, { bucket: point.bucket, count: point.documents }),
    value: point.netMinor / 100,
  }));
  const dailyBars = trend.daily.map((point, index) => ({
    label: dayTick(point.bucket, index === 0),
    minor: minorOnNarrow(index, TREND_DAYS, 5),
    hint: fill(b.trend.hint, { bucket: point.bucket, count: point.documents }),
    value: point.netMinor / 100,
  }));

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader
        eyebrow={t.admin.eyebrow}
        title={b.title}
        description={b.description}
        action={paddleConfig() ? <BackfillDocument action={backfillDocumentAction} /> : undefined}
      />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: b.stats.revenue,
            value: cash(summary.monthNetMinor),
            caption: comparison(summary.monthNetMinor, summary.previousMonthNetMinor, b),
          },
          {
            label: b.stats.active,
            value: summary.paidSubscriptions.toLocaleString('en-US'),
            caption:
              summary.trialingSubscriptions > 0
                ? fill(b.stats.activeTrialing, { count: summary.trialingSubscriptions })
                : b.stats.activeNoTrial,
          },
          {
            label: b.stats.due,
            value: cash(summary.outstandingMinor),
            caption:
              summary.outstandingCount > 0
                ? fill(b.stats.dueCount, { count: summary.outstandingCount })
                : b.stats.dueNone,
          },
          {
            label: b.stats.refund,
            value: `${percentFromBps(summary.monthRefundRateBps)}%`,
            caption: fill(b.stats.refundCaption, { amount: cash(summary.monthRefundedMinor) }),
          },
        ].map((stat) => (
          <article
            key={stat.label}
            className={`${CONSOLE_PANEL} flex flex-col gap-1.5 rounded-[9px] p-4`}
          >
            <span className="text-[11px] tracking-[-0.023em] text-muted">{stat.label}</span>
            <span className="text-[20px] leading-[1.3] font-semibold tracking-[-0.03em] text-ink">
              {stat.value}
            </span>
            <span className="text-[11px] leading-[1.5] tracking-[-0.023em] text-muted">
              {stat.caption}
            </span>
          </article>
        ))}
      </section>

      <ConsoleTrend daily={dailyBars} monthly={monthlyBars} copy={b.trend} />

      {/*
        * Said once, in the place where the absence of a refund button would
        * otherwise read as a missing feature.
        */}
      <ConsoleNotice
        icon={<ReceiptIcon size={18} />}
        title={b.readOnlyTitle}
        body={
          /*
           * The figures above add up only within one currency. When something
           * settled in another one, the banner says how many rather than
           * letting a total quietly stand for the whole ledger.
           */
          summary.foreignCurrencyDocuments > 0
            ? `${b.readOnlyNote} ${fill(b.foreignCurrency, {
                count: summary.foreignCurrencyDocuments,
                currency: summary.currency,
              })}`
            : b.readOnlyNote
        }
      />

      <Panel>
        {/* GET, so a filtered list is a URL an operator can keep or share. */}
        <form method="get">
          <ListToolbar placeholder={b.searchPlaceholder} name="q" defaultValue={query}>
            <FilterSelect
              name="status"
              label={b.statusFilter}
              value={status}
              options={statusOptions(b, t.admin.filters.all)}
            />
            <FilterSelect
              name="kind"
              label={b.kindFilter}
              value={kind}
              options={[
                { id: 'all', label: b.kindAll },
                ...BILLING_DOCUMENT_KINDS.map((id) => ({ id, label: b.kinds[id] })),
              ]}
            />
            <label className={DATE_FIELD}>
              <span className="text-muted">{b.dateFrom}</span>
              <input type="date" name="from" defaultValue={from ?? ''} max={to} className={DATE_INPUT} />
            </label>
            <label className={DATE_FIELD}>
              <span className="text-muted">{b.dateTo}</span>
              <input type="date" name="to" defaultValue={to ?? ''} min={from} className={DATE_INPUT} />
            </label>
            <ConsoleButton type="submit">{t.admin.administrators.searchSubmit}</ConsoleButton>
            <ExportLink
              resource="billing"
              query={query}
              status={status}
              filters={{ kind, from, to }}
              label={t.admin.actions.export}
            />
          </ListToolbar>
        </form>

        <TableScroller>
          <table className="w-full min-w-[840px] border-collapse text-left">
            <thead>
              <tr>
                {b.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
                <th scope="col" className={`${TH} w-[52px]`}>
                  <span className="sr-only">{t.admin.actions.view}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow
                  columns={b.columns.length + 1}
                  message={b.empty}
                  /*
                   * The distinction the operator actually needs: an empty
                   * ledger because nothing was billed, or an empty ledger
                   * because no provider is connected yet. Only shown on the
                   * unfiltered list, where it is the likely explanation.
                   */
                  note={
                    filtered
                      ? undefined
                      : paddleConfig()
                        ? b.noneYet
                        : t.admin.notReady.billing
                  }
                />
              ) : null}
              {rows.map((row) => (
                <tr key={row.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <code className="font-mono text-[11px] tracking-[-0.01em] text-ink">
                      {row.number}
                    </code>
                  </td>
                  <td className={TD}>
                    <TitleCell
                      title={row.workspaceName}
                      meta={row.customerEmail ?? t.admin.billingDetail.customer.noOwner}
                    />
                  </td>
                  {/*
                    * The tier when the order is linked to one, and what was
                    * sold when it is not -- a mirrored document can arrive
                    * before anything on this side knows which version priced
                    * it, and an empty cell would read as "no plan".
                    */}
                  <td className={TD}>
                    {planLabel(row.planId, row.kind, t.admin.plans.names, b)}
                  </td>
                  <td className={`${TD} font-semibold text-ink`}>
                    {money(row.amountMinor, row.currency)}
                    {row.refundedMinor > 0 ? (
                      <span className="ml-1.5 text-[11px] font-normal text-muted">
                        {fill(b.partialRefund, {
                          amount: money(row.refundedMinor, row.currency),
                        })}
                      </span>
                    ) : null}
                  </td>
                  <td className={`${TD} whitespace-nowrap`}>{utcDate(row.issuedAt)}</td>
                  <td className={TD}>{methodLabel(row.method, b)}</td>
                  <td className={TD}>
                    <BillingStatusPill status={row.status} label={b.statuses[row.status]} />
                  </td>
                  <td className={TD}>
                    <IconLink label={t.admin.actions.view} href={`/admin/billing/${row.id}`}>
                      <EyeIcon size={14} />
                    </IconLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>

        <Pagination
          summary={fill(b.showing, {
            from: view.from,
            to: view.to,
            total: total.toLocaleString('en-US'),
          })}
          pages={view.pages}
          activePage={page}
          pageCount={view.pageCount}
          href={link}
          labels={t.admin.actions}
        />
      </Panel>
    </div>
  );
}

type BillingCopy = Dictionary['admin']['billing'];

/** The trend's two ranges: a month of days, a year of months. */
const TREND_DAYS = 30;
const TREND_MONTHS = 12;

/** A date filter framed like the toolbar's selects. */
const DATE_FIELD =
  'inline-flex h-[37px] shrink-0 items-center gap-1.5 rounded-[7px] border-2 border-line bg-card px-2.5 text-[12px] tracking-[-0.023em] text-steel';
const DATE_INPUT = 'h-full bg-transparent text-[12px] text-steel focus:outline-none';

function planLabel(
  planId: string | null,
  kind: BillingDocumentKind,
  names: Dictionary['admin']['plans']['names'],
  b: BillingCopy,
): string {
  const known: Record<string, string> = names;
  return (planId ? known[planId] : undefined) ?? b.kinds[kind];
}

function statusOptions(b: BillingCopy, allLabel: string): { id: string; label: string }[] {
  return BILLING_STATUS_FILTERS.map((id: BillingStatusFilter) => ({
    id,
    label: id === 'all' ? allLabel : b.statuses[id],
  }));
}

/**
 * A method type the dictionary knows, or the provider's own code.
 *
 * Printing the raw code beats hiding the column: a provider can add a method
 * next week, and "not recorded" would be a lie about a document that recorded
 * one.
 */
function methodLabel(method: string | null, b: BillingCopy): string {
  if (!method) return b.methodUnknown;
  const known: Record<string, string> = b.methods;
  return known[method] ?? method;
}

/**
 * This month against last month, as a percentage.
 *
 * With no baseline there is no percentage to state -- a first month is not an
 * infinite increase -- so it says there was nothing to compare against instead
 * of dividing by zero.
 */
function comparison(current: number, previous: number, b: BillingCopy): string {
  const deltaBps = changeBps(current, previous);
  if (deltaBps === null) return b.stats.revenueNoBaseline;
  if (deltaBps === 0) return b.stats.revenueFlat;
  const percent = percentFromBps(Math.abs(deltaBps));
  return deltaBps > 0
    ? fill(b.stats.revenueUp, { percent })
    : fill(b.stats.revenueDown, { percent });
}

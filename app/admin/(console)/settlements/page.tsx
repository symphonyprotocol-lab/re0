import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { GenerateSettlements } from '@/components/admin/generate-settlements';
import { FilterSelect } from '@/components/admin/list-controls';
import {
  CONSOLE_PANEL,
  ConsoleButton,
  ConsoleNotice,
  ConsolePageHeader,
  EmptyRow,
  ExportLink,
  ListToolbar,
  Pagination,
  Panel,
  Pill,
  TableScroller,
  TD,
  TH,
} from '@/components/admin/ui';
import { CircleDollarSignIcon } from '@/components/ui/icons';
import {
  listSettlements,
  periodParam,
  SETTLEMENT_STATUS_FILTERS,
  settlementPeriods,
  settlementSummary,
  type SettlementStatus,
} from '@/lib/application/administration';
import { percentFromBps } from '@/lib/domain/billing';
import { requireAdminCapability } from '@/lib/http/admin';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { money, oneOf, PAGE_SIZE, pageNumber, pageWindow, searchTerm, utcDate } from '../list-params';
import { generateSettlementsAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.settlements.title };
}

const STATUS_TONE: Record<SettlementStatus, 'neutral' | 'warn' | 'ok' | 'danger'> = {
  accrued: 'warn',
  held: 'warn',
  paid: 'ok',
  redeemed: 'ok',
  clawed_back: 'danger',
  voided: 'neutral',
};

function statusLabel(f: Dictionary['admin']['filters'], status: SettlementStatus): string {
  switch (status) {
    case 'accrued':
      return f.settlementAccrued;
    case 'held':
      return f.settlementHeld;
    case 'paid':
      return f.settlementPaid;
    case 'redeemed':
      return f.settlementRedeemed;
    case 'clawed_back':
      return f.settlementClawedBack;
    case 'voided':
      return f.settlementVoided;
  }
}

/**
 * Publisher settlements -- design source frame `buNhV`.
 *
 * Reads the real ledger: `revenue_period`, `earning_event`, `settlement` and
 * `publisher_account`. Allocation is linear in attributable calls and never
 * weighted by Trust Score (publisher-revenue-share.md 6.2), so the table shows
 * the call count the money is derived from rather than any score.
 *
 * There is no payout control, and that is a product fact rather than a gap:
 * stage 3 of the share doc connects an external payment service, and until it
 * does the console cannot move money. Statements still leave the books one
 * way -- the publisher redeems them as Additional Calls from their dashboard
 * (share doc 3.4) -- which the console shows as `redeemed` and totals beside
 * cash paid out, but never triggers. The notice says both.
 */
export default async function AdminSettlementsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [, params, t] = await Promise.all([
    requireAdminCapability('billing'),
    searchParams,
    getMessages(),
  ]);
  const s = t.admin.settlements;
  const l = s.ledger;
  const f = t.admin.filters;

  const query = searchTerm(params.q);
  const status = oneOf(params.status, SETTLEMENT_STATUS_FILTERS, 'all');
  const period = periodParam(params.period);
  const page = pageNumber(params.page);

  const periods = await settlementPeriods();
  const [{ rows, total }, summary] = await Promise.all([
    listSettlements({ query, status, period, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    settlementSummary(periods),
  ]);
  const view = pageWindow({ page, total, rows: rows.length });

  const link = (target: number) => {
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    if (status !== 'all') next.set('status', status);
    if (period) next.set('period', period);
    if (target > 1) next.set('page', String(target));
    return next.size > 0 ? `/admin/settlements?${next.toString()}` : '/admin/settlements';
  };

  if (total > 0 && page > view.pageCount) redirect(link(view.pageCount));

  const cash = (minor: number) => money(minor, summary.currency);
  const latest = summary.latest;

  const stats = [
    {
      label: l.stats.pool,
      value: cash(latest?.poolMinor ?? 0),
      caption: latest
        ? fill(l.stats.poolCaption, {
            period: latest.id,
            net: cash(latest.netRevenueMinor),
            rate: percentFromBps(latest.shareRateBps),
          })
        : l.stats.poolNone,
    },
    {
      label: l.stats.accrued,
      value: cash(summary.accruedMinor),
      caption: fill(l.stats.accruedCaption, {
        count: summary.accruedCount,
        publishers: summary.publishers,
      }),
    },
    {
      label: l.stats.paid,
      value: cash(summary.paidMinor + summary.redeemedMinor),
      caption: fill(l.stats.paidCaption, {
        paid: cash(summary.paidMinor),
        redeemed: cash(summary.redeemedMinor),
      }),
    },
    {
      label: l.stats.reversed,
      value: cash(summary.reversedMinor),
      caption: l.stats.reversedCaption,
    },
  ];

  /*
   * What the dialog offers: finished periods that hold events or a period row,
   * newest first. The current month is not settleable and is not listed.
   */
  const settleable = periods
    .filter((entry) => entry.settleable && (entry.events > 0 || entry.locked))
    .map((entry) => ({
      id: entry.id,
      locked: entry.locked,
      events: entry.events,
      statements: entry.statements,
    }));

  return (
    <div className="flex flex-col gap-[18px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={s.title} description={s.description} />

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
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

      <ConsoleNotice
        icon={<CircleDollarSignIcon size={18} />}
        title={l.payoutTitle}
        body={fill(l.payoutBody, {
          days: summary.holdDays,
          threshold: cash(summary.payoutThresholdMinor),
        })}
        action={
          <GenerateSettlements
            action={generateSettlementsAction}
            periods={settleable}
            currency={summary.currency}
          />
        }
      />

      <Panel>
        {/* GET, so a filtered page is a URL an operator can keep or share. */}
        <form method="get">
          <ListToolbar placeholder={s.searchPlaceholder} name="q" defaultValue={query}>
            <FilterSelect
              name="period"
              label={l.periodFilter}
              value={period ?? ''}
              options={[
                { id: '', label: l.allPeriods },
                ...periods.map((entry) => ({
                  id: entry.id,
                  label: `${entry.id} · ${entry.locked ? l.periodLocked : l.periodOpen}`,
                })),
              ]}
            />
            <FilterSelect
              name="status"
              label={l.statusFilter}
              value={status}
              options={[
                { id: 'all', label: f.all },
                { id: 'accrued', label: f.settlementAccrued },
                { id: 'held', label: f.settlementHeld },
                { id: 'paid', label: f.settlementPaid },
                { id: 'redeemed', label: f.settlementRedeemed },
                { id: 'clawed_back', label: f.settlementClawedBack },
                { id: 'voided', label: f.settlementVoided },
              ]}
            />
            <ConsoleButton type="submit">{l.searchSubmit}</ConsoleButton>
            <ExportLink
              resource="settlements"
              query={query}
              status={status}
              period={period}
              label={t.admin.actions.export}
            />
          </ListToolbar>
        </form>

        <TableScroller>
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr>
                {s.columns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow
                  columns={s.columns.length}
                  message={s.empty}
                  note={periods.length === 0 ? t.admin.notReady.settlements : undefined}
                />
              ) : null}
              {rows.map((row) => (
                <tr key={row.id} className="border-t-2 border-line">
                  <td className={TD}>
                    <span className="flex min-w-0 flex-col gap-[3px]">
                      <code className="font-mono text-[11px] tracking-[-0.01em] text-ink">
                        {row.id.slice(0, 8)}…{row.id.slice(-4)}
                      </code>
                      {row.statementDigest ? (
                        <span
                          title={row.statementDigest}
                          className="font-mono text-[10px] text-muted"
                        >
                          {l.digest} {row.statementDigest.slice(0, 10)}…
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="flex min-w-0 flex-col gap-[3px]">
                      <span className="truncate text-[12px] font-medium text-ink">{row.publisherName}</span>
                      <span className="truncate font-mono text-[11px] text-muted">
                        {row.publisherWorkspaceId}
                      </span>
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="flex min-w-0 flex-col gap-[3px]">
                      <span className="truncate text-[12px] text-ink">{row.libraryTitle}</span>
                      <code className="truncate font-mono text-[11px] tracking-[-0.01em] text-steel">
                        {row.libraryPublicId}
                      </code>
                    </span>
                  </td>
                  <td className={TD}>{row.attributableCalls.toLocaleString('en-US')}</td>
                  <td className={TD}>
                    <span className="flex flex-col gap-[3px]">
                      <span>{row.periodId}</span>
                      {row.holdEndsAt ? (
                        <span className="text-[11px] text-muted">
                          {fill(l.holdUntil, { date: utcDate(row.holdEndsAt) })}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td
                    className={`${TD} font-semibold ${
                      row.status === 'clawed_back' ? 'text-err' : 'text-ink'
                    }`}
                  >
                    {money(row.status === 'clawed_back' ? -row.amountMinor : row.amountMinor, row.currency)}
                  </td>
                  <td className={TD}>
                    <Pill tone={STATUS_TONE[row.status]}>{statusLabel(f, row.status)}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>

        <Pagination
          summary={fill(s.showing, {
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

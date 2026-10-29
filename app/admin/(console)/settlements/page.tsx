import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CopyValue } from '@/components/admin/copy-value';
import { GenerateSettlements } from '@/components/admin/generate-settlements';
import { FilterSelect } from '@/components/admin/list-controls';
import { PayoutControls } from '@/components/admin/payout-controls';
import { ConsoleTrend } from '@/components/admin/console-trend';
import { dayTick, minorOnNarrow } from '@/components/dashboard/mini-trend';
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
  PanelHead,
  Pill,
  TableScroller,
  TD,
  TH,
} from '@/components/admin/ui';
import { CircleDollarSignIcon } from '@/components/ui/icons';
import {
  consolePayouts,
  listSettlements,
  periodParam,
  SETTLEMENT_STATUS_FILTERS,
  settlementPeriods,
  settlementSummary,
  type SettlementStatus,
} from '@/lib/application/administration';
import { publisherDailyEarnings } from '@/lib/application/revenue';
import { recentPeriodIds, revenuePeriodId, type PayoutStatus } from '@/lib/domain';
import { requireAdminCapability } from '@/lib/http/admin';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import {
  money,
  oneOf,
  PAGE_SIZE,
  pageNumber,
  pageWindow,
  searchTerm,
  utcDate,
  utcStamp,
} from '../list-params';
import {
  generateSettlementsAction,
  markPayoutFailedAction,
  markPayoutPaidAction,
} from './actions';

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

/** The trend's two ranges: a month of days, a year of periods. */
const TREND_DAYS = 30;
const TREND_PERIODS = 12;

const PAYOUT_TONE: Record<PayoutStatus, 'neutral' | 'warn' | 'ok' | 'danger'> = {
  requested: 'warn',
  paid: 'ok',
  failed: 'danger',
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
 * Creator settlements -- design source frame `buNhV`.
 *
 * Reads the real ledger: `revenue_period`, `earning_event`, `settlement` and
 * `publisher_account`. Every event carries its own amount
 * (agent-first-proposal.md 6.9), so a period's figure is a sum and the table
 * shows the amount a statement carries, nothing it was derived from.
 *
 * Statements leave the books two ways. The creator redeems them as
 * Additional Calls from their dashboard, which the console shows as
 * `redeemed` but never triggers. Or the creator requests a cash payout to a
 * PayPal address, which lands in the payout queue here: no payment service
 * is connected, so an operator sends the money from the platform's PayPal
 * account and then marks the request paid with the transaction id -- or
 * failed, which hands the statements back.
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

  const now = new Date();
  const currentPeriod = revenuePeriodId(now);
  const periods = await settlementPeriods(now);
  const [{ rows, total }, summary, payouts, daily] = await Promise.all([
    listSettlements({ query, status, period, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    settlementSummary(periods),
    consolePayouts(),
    publisherDailyEarnings(null, TREND_DAYS, now),
  ]);
  const p = s.payouts;
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

  /*
   * The trend: a year of periods (a locked one at its frozen total, the open
   * one at its running sum) and a month of days, oldest first and
   * zero-filled. Every bar is labelled; on a phone only every other month and
   * every fifth day keep theirs.
   */
  const tr = s.trend;
  const periodById = new Map(periods.map((entry) => [entry.id, entry]));
  const monthly = recentPeriodIds(now, TREND_PERIODS).map((id, index) => {
    const entry = periodById.get(id);
    const open = id === currentPeriod && !entry?.locked;
    const amountMinor = entry?.locked ? entry.totalAmountMinor : (entry?.eventsMinor ?? 0);
    return {
      label: id,
      minor: minorOnNarrow(index, TREND_PERIODS, 2),
      hint: fill(open ? tr.monthHintOpen : tr.monthHint, {
        period: id,
        settled: cash(entry?.settledMinor ?? 0),
      }),
      value: amountMinor / 100,
    };
  });
  const dailyBars = daily.map((day, index) => ({
    label: dayTick(day.date, index === 0),
    minor: minorOnNarrow(index, TREND_DAYS, 5),
    hint: fill(tr.dayHint, { day: day.date, events: day.events }),
    value: day.amountMinor / 100,
  }));

  const stats = [
    {
      label: l.stats.total,
      value: cash(latest?.totalAmountMinor ?? 0),
      caption: latest ? fill(l.stats.totalCaption, { period: latest.id }) : l.stats.totalNone,
    },
    {
      label: l.stats.accrued,
      value: cash(summary.accruedMinor),
      caption: fill(l.stats.accruedCaption, {
        count: summary.accruedCount,
        publishers: summary.publishers,
        inPayout: cash(summary.inPayoutMinor),
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

      <ConsoleTrend daily={dailyBars} monthly={monthly} copy={tr} />

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
        <PanelHead
          title={fill(p.title, { count: payouts.open.length })}
          description={fill(p.description, { threshold: cash(summary.payoutThresholdMinor) })}
        />
        <TableScroller>
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr>
                {p.openColumns.map((column) => (
                  <th key={column} scope="col" className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payouts.open.length === 0 ? (
                <EmptyRow columns={p.openColumns.length} message={p.openEmpty} />
              ) : null}
              {payouts.open.map((payout) => (
                <tr key={payout.id} className="border-t-2 border-line">
                  <td className={TD}>{utcStamp(payout.createdAt)}</td>
                  <td className={TD}>
                    <span className="flex min-w-0 flex-col gap-[3px]">
                      <span className="truncate text-[12px] font-medium text-ink">{payout.publisherName}</span>
                      <span className="truncate font-mono text-[11px] text-muted">
                        {payout.publisherWorkspaceId}
                      </span>
                    </span>
                  </td>
                  <td className={TD}>
                    <span className="flex items-center gap-2">
                      <span className="truncate font-mono text-[12px] text-ink">{payout.payeeEmail}</span>
                      {payout.payeeEmail ? (
                        <CopyValue value={payout.payeeEmail} label={p.copy} copiedLabel={p.copied} />
                      ) : null}
                    </span>
                  </td>
                  <td className={`${TD} font-semibold text-ink`}>
                    {money(payout.amountMinor, payout.currency)}
                  </td>
                  <td className={TD}>
                    <span className="flex flex-col gap-[3px]">
                      <span>{fill(p.statements, { count: payout.statements })}</span>
                      <span className="text-[11px] text-muted">{payout.periods.join(', ')}</span>
                    </span>
                  </td>
                  <td className={`${TD} text-right`}>
                    <PayoutControls
                      payout={{
                        id: payout.id,
                        amountMinor: payout.amountMinor,
                        currency: payout.currency,
                        payeeEmail: payout.payeeEmail,
                      }}
                      paidAction={markPayoutPaidAction}
                      failedAction={markPayoutFailedAction}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroller>

        {payouts.resolved.length > 0 ? (
          <>
            <h3 className="border-t-2 border-line px-[19px] pt-4 pb-2 text-[13px] tracking-[-0.023em] text-ink">
              {p.resolvedTitle}
            </h3>
            <TableScroller>
              <table className="w-full min-w-[900px] border-collapse text-left">
                <thead>
                  <tr>
                    {p.resolvedColumns.map((column) => (
                      <th key={column} scope="col" className={TH}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {payouts.resolved.map((payout) => (
                    <tr key={payout.id} className="border-t-2 border-line">
                      <td className={TD}>
                        {payout.resolvedAt ? utcStamp(payout.resolvedAt) : '—'}
                      </td>
                      <td className={TD}>
                        <span className="truncate text-[12px] text-ink">{payout.publisherName}</span>
                      </td>
                      <td className={TD}>
                        <span className="truncate font-mono text-[12px]">{payout.payeeEmail}</span>
                      </td>
                      <td className={`${TD} font-semibold text-ink`}>
                        {money(payout.amountMinor, payout.currency)}
                      </td>
                      <td className={TD}>
                        <Pill tone={PAYOUT_TONE[payout.status]}>{p.status[payout.status]}</Pill>
                      </td>
                      <td className={TD}>
                        {payout.status === 'failed' ? (
                          <span className="text-err">{payout.failureReason}</span>
                        ) : (
                          <code className="font-mono text-[11px] text-ink">{payout.providerReference}</code>
                        )}
                      </td>
                      <td className={TD}>{payout.resolvedByEmail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroller>
          </>
        ) : null}
      </Panel>

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
          <table className="w-full min-w-[720px] border-collapse text-left">
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
                      row.status === 'clawed_back' || row.amountMinor < 0 ? 'text-err' : 'text-ink'
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

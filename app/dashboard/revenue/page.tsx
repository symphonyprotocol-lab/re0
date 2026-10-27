import type { Metadata } from 'next';
import Link from 'next/link';
import { unstable_cache } from 'next/cache';
import { RedeemEarningsButton } from '@/components/dashboard/earning-credit';
import { PayoutRequestForm } from '@/components/dashboard/earning-payout';
import { dayTick, minorOnNarrow } from '@/components/dashboard/mini-trend';
import { RevenueTrend } from '@/components/dashboard/revenue-trend';
import {
  ActionButton,
  Badge,
  PANEL,
  PageHeader,
  StatTile,
  StatusLabel,
  type StatusTone,
} from '@/components/dashboard/ui';
import {
  BracesIcon,
  ChevronDownIcon,
  CircleDollarSignIcon,
  ClockIcon,
  DatabaseIcon,
} from '@/components/ui/icons';
import {
  canRedeemEarnings,
  livePeriodPool,
  publisherDailyEarnings,
  publisherEarnings,
} from '@/lib/application/revenue';
import { recentPeriodIds, revenuePeriodId } from '@/lib/domain';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import type { PayoutStatus } from '@/lib/domain';
import { redeemEarningsAction, requestPayoutAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.revenue.metaTitle };
}

const GRID = 'grid grid-cols-[110px_minmax(0,1fr)_100px_90px] items-center gap-3';
/** The trend's two ranges: a month of days, a year of periods. */
const TREND_DAYS = 30;
const TREND_PERIODS = 12;
const HISTORY_GRID = 'grid grid-cols-[minmax(0,1fr)_100px_100px_100px] items-center gap-3';
const PAYOUT_GRID =
  'grid grid-cols-[110px_80px_minmax(0,1fr)_80px_minmax(0,1fr)] items-center gap-3';
const PAYOUT_TONE: Record<PayoutStatus, StatusTone> = {
  requested: 'pending',
  paid: 'live',
  failed: 'blocked',
};
const LIBRARY_GRID =
  'grid grid-cols-[minmax(0,1fr)_100px_110px_110px_16px] items-center gap-3';

/*
 * The open period's pool is one platform-wide scan, the same for every
 * publisher: computed at most every few minutes and shared, not per view.
 */
const LIVE_POOL_SECONDS = 300;
const cachedLivePool = unstable_cache(
  (periodId: string) => livePeriodPool(periodId),
  ['revenue-live-pool'],
  { revalidate: LIVE_POOL_SECONDS },
);

function usd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

/**
 * The publisher's revenue screen, on the ledger. publisher-revenue-share.md
 * stage 2: every amount is recomputed from earning events and locked period
 * rows -- a settled period shows what closePeriod allocated, an accruing one
 * shows its calls and settles at close. Statements past their hold leave the
 * books one of two ways (share doc 3.4): the credit panel turns them into
 * Additional Calls on this workspace, or the payout panel asks for them in
 * cash to a PayPal address once they reach the threshold -- paid by hand by
 * an operator, so the request waits here until it is marked paid or failed.
 */
export default async function DashboardRevenuePage() {
  const [session, { locale, t }] = await Promise.all([
    requireSession('/dashboard/revenue'),
    translations(),
  ]);
  const r = t.dashboard.revenue;

  const now = new Date();
  const currentPeriod = revenuePeriodId(now);
  const live = { periodId: currentPeriod, pool: await cachedLivePool(currentPeriod) };
  const [earnings, daily] = await Promise.all([
    publisherEarnings(session.workspace.id, live),
    publisherDailyEarnings(session.workspace.id, TREND_DAYS, live, now),
  ]);
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const c = r.credit;
  const l = r.libraries;
  const credit = earnings.credit;
  const canRedeem =
    earnings.account !== null &&
    canRedeemEarnings(session.workspace.role) &&
    credit.pack !== null &&
    credit.redeemableCalls >= 1;
  const payouts = earnings.payouts;
  const p = r.payout;
  /* Cash takes the same statements the credit would; it also needs the threshold. */
  const payableMinor = credit.redeemableMinor;
  const canRequestPayout =
    earnings.account !== null &&
    canRedeemEarnings(session.workspace.role) &&
    payouts.open === null &&
    payableMinor >= earnings.payoutThresholdMinor;

  const current = earnings.periods.find((period) => period.periodId === currentPeriod);
  const lockedCount = earnings.periods.filter((period) => period.locked).length;

  const stats = [
    { key: 'accrued', value: usd(earnings.accruedMinor), label: r.stats.accrued, Icon: CircleDollarSignIcon },
    {
      key: 'live',
      value: `≈ ${usd(current?.estimateMinor ?? 0)}`,
      label: fill(r.stats.liveEstimate, {
        calls: number.format(current?.attributableCalls ?? 0),
      }),
      Icon: BracesIcon,
    },
    { key: 'locked', value: number.format(lockedCount), label: r.stats.lockedPeriods, Icon: ClockIcon },
    {
      key: 'threshold',
      value: usd(earnings.payoutThresholdMinor),
      label: r.stats.threshold,
      Icon: DatabaseIcon,
    },
  ];

  /*
   * Oldest to newest, zero-filled, so the trend reads left to right and an
   * idle stretch shows as one. The open period plots its live estimate. Every
   * bar is labelled; on a phone only every other month and every fifth day
   * keep theirs, counted back from the newest bar so the current one is named.
   */
  const byPeriod = new Map(earnings.periods.map((period) => [period.periodId, period]));
  const monthly = recentPeriodIds(now, TREND_PERIODS).map((periodId, index) => {
    const period = byPeriod.get(periodId);
    return {
      label: periodId,
      minor: minorOnNarrow(index, TREND_PERIODS, 2),
      hint: periodId,
      value: (period?.amountMinor ?? period?.estimateMinor ?? 0) / 100,
    };
  });
  const dayLabel = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const dailyBars = daily.map((day, index) => ({
    label: dayTick(day.date, index === 0),
    minor: minorOnNarrow(index, TREND_DAYS, 5),
    hint: dayLabel.format(new Date(`${day.date}T00:00:00Z`)),
    value: day.amountMinor / 100,
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow={r.eyebrow}
        title={r.title}
        description={r.description}
        action={
          <ActionButton href="/dashboard/revenue/rules" variant="outline">
            {r.rulesLink}
          </ActionButton>
        }
      />

      <section className="grid grid-cols-2 gap-[9px] sm:grid-cols-4">
        {stats.map(({ key, value, label, Icon }) => (
          <StatTile key={key} icon={<Icon size={17} />} value={value} label={label} />
        ))}
      </section>

      {earnings.periods.length > 0 ? (
        <RevenueTrend
          daily={dailyBars}
          monthly={monthly}
          legend={fill(r.holdNote, {
            days: earnings.holdDays,
            threshold: usd(earnings.payoutThresholdMinor),
          })}
        />
      ) : null}

      {earnings.account === null ? (
        <p className={`${PANEL} px-[18px] py-3.5 text-[12px] leading-[1.7] text-muted`}>
          {r.noAccountNotice}
        </p>
      ) : null}

      {/* Per expert library: this period live, every locked period settled. */}
      <section className={`${PANEL} overflow-hidden p-0.5`}>
        <div className="flex flex-col gap-1 px-[18px] pt-3.5 pb-3">
          <h2 className="text-[13px] leading-[1.4] font-medium text-ink">{l.title}</h2>
          <p className="text-[11px] leading-[1.6] text-muted">
            {fill(l.description, { minutes: LIVE_POOL_SECONDS / 60 })}
          </p>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[560px]">
            <div className={`${LIBRARY_GRID} bg-subtle px-[18px] py-3 text-[11px] text-muted`}>
              {l.columns.map((column) => (
                <span key={column}>{column}</span>
              ))}
              <span />
            </div>

            {earnings.libraries.map((library) => {
              const live = library.periods.find((period) => period.periodId === currentPeriod);
              return (
                <details key={library.libraryId} className="group border-t border-line">
                  <summary
                    className={`${LIBRARY_GRID} cursor-pointer list-none px-[18px] py-3.5 transition-colors hover:bg-subtle [&::-webkit-details-marker]:hidden`}
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {library.deleted ? (
                          <span className="truncate text-[13px] text-ink">{library.title}</span>
                        ) : (
                          <Link
                            href={`/dashboard/libraries/${library.libraryId}`}
                            className="truncate text-[13px] text-ink hover:text-brand"
                          >
                            {library.title}
                          </Link>
                        )}
                        {library.deleted ? (
                          <Badge>{l.deleted}</Badge>
                        ) : library.expertTagged ? null : (
                          <Badge>{l.untagged}</Badge>
                        )}
                      </span>
                      <span className="truncate font-mono text-[11px] text-muted">
                        {library.publicId}
                      </span>
                    </span>
                    <span className="text-[12px] text-steel">
                      {number.format(live?.attributableCalls ?? 0)}
                    </span>
                    <span className="text-[12px] font-medium text-ink">
                      {live?.estimateMinor != null
                        ? `≈ ${usd(live.estimateMinor)}`
                        : usd(0)}
                    </span>
                    <span className="flex flex-col">
                      <span className="text-[12px] font-medium text-ink">
                        {usd(library.settledMinor)}
                      </span>
                      <span className="text-[11px] text-muted">
                        {fill(l.settledCalls, { calls: number.format(library.settledCalls) })}
                      </span>
                    </span>
                    <ChevronDownIcon
                      size={14}
                      className="text-muted transition-transform group-open:rotate-180"
                    />
                  </summary>

                  <div className="bg-subtle px-[18px] py-3">
                    {library.periods.length === 0 ? (
                      <p className="text-[12px] text-muted">{l.historyEmpty}</p>
                    ) : (
                      <div className="flex flex-col">
                        <div className={`${GRID} pb-1.5 text-[11px] text-muted`}>
                          {r.periodColumns.map((column) => (
                            <span key={column}>{column}</span>
                          ))}
                        </div>
                        {library.periods.map((period) => (
                          <div
                            key={period.periodId}
                            className={`${GRID} border-t border-line py-2 text-[12px] text-steel`}
                          >
                            <span className="font-mono">{period.periodId}</span>
                            <span>{number.format(period.attributableCalls)}</span>
                            <span>{period.locked ? r.statusLocked : r.statusAccruing}</span>
                            <span className="font-medium text-ink">
                              <PeriodAmount
                                period={period}
                                pending={r.pendingAmount}
                                estimate={r.estimate}
                              />
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              );
            })}

            {earnings.libraries.length === 0 ? (
              <p className="border-t border-line px-[18px] py-10 text-center text-[13px] text-muted">
                {l.empty}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {/* Credit: statements past their hold become Additional Calls (share doc 3.4). */}
      <section className={`${PANEL} flex flex-col gap-4 px-[18px] py-4`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-[240px] flex-1 flex-col gap-1">
            <h2 className="text-[13px] leading-[1.4] font-medium text-ink">{c.title}</h2>
            <p className="text-[11px] leading-[1.6] text-muted">
              {fill(c.description, { days: earnings.holdDays })}
            </p>
          </div>
          <RedeemEarningsButton action={redeemEarningsAction} disabled={!canRedeem} />
        </div>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <dt className="text-[11px] text-muted">{c.redeemable}</dt>
            <dd className="text-[17px] leading-[1.4] font-medium text-ink">
              {usd(credit.redeemableMinor)}
            </dd>
            <dd className="text-[11px] text-steel">
              {fill(c.redeemableCalls, { calls: number.format(credit.redeemableCalls) })}
              {' · '}
              {fill(c.statements, { count: number.format(credit.redeemableStatements) })}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-[11px] text-muted">{c.held}</dt>
            <dd className="text-[17px] leading-[1.4] font-medium text-ink">
              {usd(credit.heldMinor)}
            </dd>
            {credit.nextReleaseAt ? (
              <dd className="text-[11px] text-steel">
                {fill(c.nextRelease, { date: date.format(credit.nextReleaseAt) })}
              </dd>
            ) : null}
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-[11px] text-muted">{c.historyTitle}</dt>
            <dd className="text-[17px] leading-[1.4] font-medium text-ink">
              {usd(credit.redeemedMinor)}
            </dd>
            <dd className="text-[11px] text-steel">
              {fill(c.redeemed, { calls: number.format(credit.redeemedCalls) })}
            </dd>
          </div>
        </dl>

        {credit.withheldMinor > 0 ? (
          <p className="text-[11px] leading-[1.6] text-rose">
            {fill(c.withheld, { amount: usd(credit.withheldMinor) })}
          </p>
        ) : null}

        <p className="text-[11px] leading-[1.6] text-muted">
          {credit.pack
            ? fill(c.rate, {
                price: usd(credit.pack.priceMinor),
                calls: number.format(credit.pack.calls),
              })
            : c.noRate}
        </p>

        {credit.redemptions.length > 0 ? (
          <div className="overflow-x-auto rounded-md border border-line">
            <div className="min-w-[480px]">
              <div className={`${HISTORY_GRID} bg-subtle px-3.5 py-2.5 text-[11px] text-muted`}>
                {c.historyColumns.map((column) => (
                  <span key={column}>{column}</span>
                ))}
              </div>
              {credit.redemptions.map((redemption) => (
                <div
                  key={redemption.id}
                  className={`${HISTORY_GRID} border-t border-line px-3.5 py-2.5 text-[12px] text-steel`}
                >
                  <span>{date.format(redemption.createdAt)}</span>
                  <span className="font-medium text-ink">{usd(redemption.amountMinor)}</span>
                  <span>{number.format(redemption.callsGranted)}</span>
                  <span>{number.format(redemption.callsConsumed)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* Cash: the same statements, paid by hand to a PayPal address (share doc 3.4). */}
      <section className={`${PANEL} flex flex-col gap-4 px-[18px] py-4`}>
        <div className="flex flex-col gap-1">
          <h2 className="text-[13px] leading-[1.4] font-medium text-ink">{p.title}</h2>
          <p className="text-[11px] leading-[1.6] text-muted">
            {fill(p.description, {
              days: earnings.holdDays,
              threshold: usd(earnings.payoutThresholdMinor),
            })}
          </p>
        </div>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <dt className="text-[11px] text-muted">{p.payable}</dt>
            <dd className="text-[17px] leading-[1.4] font-medium text-ink">
              {usd(payableMinor)}
            </dd>
            <dd className="text-[11px] text-steel">
              {payableMinor >= earnings.payoutThresholdMinor
                ? fill(c.statements, { count: number.format(credit.redeemableStatements) })
                : fill(p.shortBy, {
                    amount: usd(earnings.payoutThresholdMinor - payableMinor),
                    threshold: usd(earnings.payoutThresholdMinor),
                  })}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-[11px] text-muted">{p.inProgress}</dt>
            <dd className="text-[17px] leading-[1.4] font-medium text-ink">
              {usd(payouts.open?.amountMinor ?? 0)}
            </dd>
            {payouts.open ? (
              <dd className="truncate text-[11px] text-steel">{payouts.open.payeeEmail}</dd>
            ) : null}
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-[11px] text-muted">{p.paid}</dt>
            <dd className="text-[17px] leading-[1.4] font-medium text-ink">
              {usd(payouts.paidMinor)}
            </dd>
          </div>
        </dl>

        {payouts.open ? (
          <p className="rounded-md bg-subtle px-3 py-2.5 text-[12px] leading-[1.6] text-steel">
            {fill(p.openNotice, {
              amount: usd(payouts.open.amountMinor),
              email: payouts.open.payeeEmail ?? '',
              date: date.format(payouts.open.createdAt),
            })}
          </p>
        ) : (
          <PayoutRequestForm
            action={requestPayoutAction}
            defaultEmail={payouts.lastPayeeEmail}
            disabled={!canRequestPayout}
          />
        )}

        {payouts.history.length > 0 ? (
          <div className="overflow-x-auto rounded-md border border-line">
            <div className="min-w-[560px]">
              <div className={`${PAYOUT_GRID} bg-subtle px-3.5 py-2.5 text-[11px] text-muted`}>
                {p.historyColumns.map((column) => (
                  <span key={column}>{column}</span>
                ))}
              </div>
              {payouts.history.map((payout) => (
                <div
                  key={payout.id}
                  className={`${PAYOUT_GRID} border-t border-line px-3.5 py-2.5 text-[12px] text-steel`}
                >
                  <span>{date.format(payout.createdAt)}</span>
                  <span className="font-medium text-ink">{usd(payout.amountMinor)}</span>
                  <span className="truncate">{payout.payeeEmail}</span>
                  <StatusLabel tone={PAYOUT_TONE[payout.status]}>
                    {p.status[payout.status]}
                  </StatusLabel>
                  <span
                    className={`truncate ${payout.status === 'failed' ? 'text-rose' : 'font-mono text-[11px]'}`}
                    title={payout.failureReason ?? payout.providerReference ?? undefined}
                  >
                    {payout.status === 'failed'
                      ? payout.failureReason
                      : (payout.providerReference ?? '—')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {/* Period table: one row per period the workspace earned in. */}
      <section className={`${PANEL} overflow-hidden p-0.5`}>
        <div className="overflow-x-auto">
          <div className="min-w-[520px]">
            <div className={`${GRID} bg-subtle px-[18px] py-3 text-[11px] text-muted`}>
              {r.periodColumns.map((column) => (
                <span key={column}>{column}</span>
              ))}
            </div>

            {earnings.periods.map((period) => (
              <div
                key={period.periodId}
                className={`${GRID} border-t border-line px-[18px] py-3.5 transition-colors hover:bg-subtle`}
              >
                <span className="font-mono text-[12px] text-steel">
                  {period.periodId}
                </span>
                <span className="text-[12px] text-steel">
                  {number.format(period.attributableCalls)}
                </span>
                <span
                  className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap ${
                    period.locked ? 'bg-mutedbg text-steel' : 'bg-pubsoft text-pubink'
                  }`}
                >
                  {period.locked ? r.statusLocked : r.statusAccruing}
                </span>
                <span className="text-[12px] font-medium text-ink">
                  <PeriodAmount period={period} pending={r.pendingAmount} estimate={r.estimate} />
                </span>
              </div>
            ))}

            {earnings.periods.length === 0 ? (
              <p className="border-t border-line px-[18px] py-10 text-center text-[13px] text-muted">
                {r.periodsEmpty}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

/** A locked period's amount; an open one's live estimate, or when it settles. */
function PeriodAmount({
  period,
  pending,
  estimate,
}: {
  period: { amountMinor: number | null; estimateMinor: number | null };
  pending: string;
  estimate: string;
}) {
  if (period.amountMinor !== null) return <>{usd(period.amountMinor)}</>;
  if (period.estimateMinor === null) return <>{pending}</>;
  return (
    <span title={estimate}>
      ≈ {usd(period.estimateMinor)}
      <span className="ml-1 text-[11px] font-normal text-muted">{estimate}</span>
    </span>
  );
}

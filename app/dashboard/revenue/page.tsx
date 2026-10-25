import type { Metadata } from 'next';
import { RedeemEarningsButton } from '@/components/dashboard/earning-credit';
import { MiniTrend } from '@/components/dashboard/mini-trend';
import { ActionButton, PANEL, PageHeader, StatTile } from '@/components/dashboard/ui';
import {
  BracesIcon,
  CircleDollarSignIcon,
  ClockIcon,
  DatabaseIcon,
} from '@/components/ui/icons';
import { canRedeemEarnings, publisherEarnings } from '@/lib/application/revenue';
import { revenuePeriodId } from '@/lib/domain';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';
import { redeemEarningsAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.revenue.metaTitle };
}

const GRID = 'grid grid-cols-[110px_minmax(0,1fr)_100px_90px] items-center gap-3';
const HISTORY_GRID = 'grid grid-cols-[minmax(0,1fr)_100px_100px_100px] items-center gap-3';

function usd(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

/**
 * The publisher's revenue screen, on the ledger. publisher-revenue-share.md
 * stage 2: every amount is recomputed from earning events and locked period
 * rows -- a settled period shows what closePeriod allocated, an accruing one
 * shows its calls and settles at close. The one thing a publisher can do with
 * the figures is the credit panel (share doc 3.4): statements past their hold
 * become Additional Calls on this workspace. No money moves, so there is still
 * no balance here that anyone can withdraw.
 */
export default async function DashboardRevenuePage() {
  const [session, { locale, t }] = await Promise.all([
    requireSession('/dashboard/revenue'),
    translations(),
  ]);
  const r = t.dashboard.revenue;

  const earnings = await publisherEarnings(session.workspace.id);
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const c = r.credit;
  const credit = earnings.credit;
  const canRedeem =
    earnings.account !== null &&
    canRedeemEarnings(session.workspace.role) &&
    credit.pack !== null &&
    credit.redeemableCalls >= 1;

  const currentPeriod = revenuePeriodId(new Date());
  const current = earnings.periods.find((period) => period.periodId === currentPeriod);
  const lockedCount = earnings.periods.filter((period) => period.locked).length;

  const stats = [
    { key: 'accrued', value: usd(earnings.accruedMinor), label: r.stats.accrued, Icon: CircleDollarSignIcon },
    {
      key: 'calls',
      value: number.format(current?.attributableCalls ?? 0),
      label: r.stats.currentCalls,
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

  /* Oldest to newest, so the trend reads left to right. */
  const chronological = [...earnings.periods].reverse();
  const bars = chronological.map((period) => ({
    label: period.periodId,
    value: (period.amountMinor ?? 0) / 100,
  }));
  const max = Math.max(1, ...bars.map((bar) => bar.value));

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

      {bars.length > 0 ? (
        <MiniTrend
          title={r.trendTitle}
          subtitle={r.trendSubtitle}
          legend={fill(r.holdNote, {
            days: earnings.holdDays,
            threshold: usd(earnings.payoutThresholdMinor),
          })}
          bars={bars}
          max={max}
          format={(value) => `$${value.toFixed(2)}`}
        />
      ) : null}

      {earnings.account === null ? (
        <p className={`${PANEL} px-[18px] py-3.5 text-[12px] leading-[1.7] text-muted`}>
          {r.noAccountNotice}
        </p>
      ) : null}

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
                  {period.amountMinor === null ? r.pendingAmount : usd(period.amountMinor)}
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

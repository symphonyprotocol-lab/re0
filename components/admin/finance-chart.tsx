'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  FINANCE_METRICS,
  financeAxisLabel,
  financeAxisMax,
  financeBarLabel,
  type FinanceKind,
  type FinanceMetric,
  type FinanceTrend,
} from '@/lib/domain/admin-finance';
import type { PeriodFilter } from '@/lib/domain/statistics';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber, formatUsd } from '@/i18n/format';
import { PeriodControls } from '@/components/statistics/period-controls';

/* The prototype's three series colours (admin-finance.css): settled blue, waiting amber, refused pink. */
const BLUE = '#3194ee';
const AMBER = '#e5ad52';
const PINK = '#d87992';
const COLORS: Record<FinanceKind, Record<string, string>> = {
  purchases: { paid: BLUE, refunded: AMBER, chargeback: PINK },
  payouts: { pending: AMBER, approved: BLUE },
  'payout-history': { paid: BLUE, failed: AMBER, rejected: PINK },
};
const PLOT_HEIGHT = 140;

/**
 * A finance list's chart (prototype admin-finance.js `render`): the shared
 * reporting calendar, the amount / count switch (links that keep the page),
 * a legend with each status's total, and grouped bars that show their exact
 * values on hover or keyboard focus. The trend is computed on the server
 * from the whole matching set.
 */
export function FinanceChart({
  kind,
  trend,
  metric,
  metricHrefs,
  filter,
}: {
  kind: FinanceKind;
  trend: FinanceTrend;
  metric: FinanceMetric;
  metricHrefs: Record<FinanceMetric, string>;
  filter: PeriodFilter;
}) {
  const { t, locale } = useI18n();
  const f = t.consolePayouts.finance;
  const [inspected, setInspected] = useState<number | null>(null);
  const count = metric === 'count';
  const field = count ? 'count' : 'cents';
  const n = (value: number) => formatNumber(value, locale);
  const records = (value: number) => fill(f.records, { n: n(value) });
  const usd = (cents: number) => formatUsd(cents, locale);
  const value = (amount: number) => (count ? records(amount) : usd(amount));
  const label = (key: string) =>
    kind === 'purchases'
      ? t.consoleUsers.purchases.status[key as keyof typeof t.consoleUsers.purchases.status]
      : t.consolePayouts.payoutStatus[key as keyof typeof t.consolePayouts.payoutStatus];
  const max = financeAxisMax(trend, metric);
  const total = trend.keys.reduce((sum, key) => sum + trend.totals[key]![field], 0);
  const grouping =
    trend.grouping === 'days' || trend.grouping === 'months' ? fill(f.grouping[trend.grouping], { n: trend.step }) : f.grouping[trend.grouping];
  const title = f.titles[kind];
  const describe = (index: number) => {
    const bar = trend.bars[index]!;
    const parts = trend.keys.map((key) => {
      const values = bar.values[key]!;
      return `${label(key)} ${value(values[field])}${count ? '' : ` (${records(values.count)})`}`;
    });
    return `${financeBarLabel(trend, bar)} · ${parts.join(' · ')}`;
  };
  const inspection = inspected !== null && trend.bars[inspected] ? describe(inspected) : total ? f.inspect : f.empty[kind];

  return (
    <section aria-label={title} className="card mb-4 px-4 pt-5 pb-4 sm:px-[22px]">
      <div className="mb-4 flex items-start justify-between gap-4 sm:items-center">
        <div className="min-w-0">
          <h2 className="text-[14px] font-bold">{title}</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            {grouping} · {f.shared}
          </p>
        </div>
        <nav aria-label={f.metricLabel} className="flex flex-none gap-[3px] rounded-lg border border-line bg-wash p-[3px]">
          {FINANCE_METRICS.map((option) => (
            <Link
              key={option}
              href={metricHrefs[option]}
              scroll={false}
              aria-current={metric === option ? 'true' : undefined}
              className={`rounded-md px-3 py-1.5 text-[11px] font-semibold whitespace-nowrap ${metric === option ? 'bg-white text-blue shadow-sm' : 'text-muted hover:text-ink'}`}
            >
              {f.metrics[option]}
            </Link>
          ))}
        </nav>
      </div>
      <div className="mb-4">
        <PeriodControls filter={filter} />
      </div>
      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2.5">
        {trend.keys.map((key) => (
          <div key={key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
            <span aria-hidden className="size-2 flex-none rounded-[2px]" style={{ background: COLORS[kind][key] }} />
            <span>{label(key)}</span>
            <strong className="font-mono text-[13px] font-medium text-ink">{usd(trend.totals[key]!.cents)}</strong>
            <small className="text-[10px]">{records(trend.totals[key]!.count)}</small>
          </div>
        ))}
      </div>
      <div className="flex min-w-0 gap-2 pt-1">
        <div
          aria-hidden
          className="flex w-[57px] flex-none flex-col justify-between text-right font-mono text-[9px] text-muted sm:w-[75px]"
          style={{ height: PLOT_HEIGHT }}
        >
          <span>{value(max)}</span>
          <span>{value(Math.round(max / 2))}</span>
          <span>{value(0)}</span>
        </div>
        <div
          role="list"
          aria-label={`${title} · ${f.metrics[metric]}`}
          className="flex w-full min-w-0 gap-0.5 sm:gap-1"
          style={{
            background: `repeating-linear-gradient(to top, transparent 0, transparent ${PLOT_HEIGHT / 2 - 1}px, #eaf0f7 ${PLOT_HEIGHT / 2 - 1}px, #eaf0f7 ${PLOT_HEIGHT / 2}px) 0 0 / 100% ${PLOT_HEIGHT}px no-repeat`,
          }}
        >
          {trend.bars.map((bar, index) => {
            const description = describe(index);
            return (
              <div
                key={bar.start}
                role="listitem"
                tabIndex={0}
                aria-label={description}
                title={description}
                onPointerEnter={() => setInspected(index)}
                onFocus={() => setInspected(index)}
                className={`relative min-w-0 flex-1 rounded-[3px] outline-offset-2 hover:bg-[#edf5ff80] focus-visible:outline-2 focus-visible:outline-[#8dbded] ${inspected === index ? 'bg-[#edf5ff80]' : ''}`}
              >
                <div className="flex items-end justify-center gap-px border-b border-[#e4ebf5] sm:gap-[3px]" style={{ height: PLOT_HEIGHT }}>
                  {trend.keys.map((key) => (
                    <i
                      key={key}
                      className="block w-[min(24%,24px)] rounded-t-[3px] transition-[height] duration-200 motion-reduce:transition-none"
                      style={{ height: `${(bar.values[key]![field] / max) * 100}%`, background: COLORS[kind][key] }}
                    />
                  ))}
                </div>
                <span className="block min-h-[23px] pt-[7px] text-center font-mono text-[9px] whitespace-nowrap text-muted">{financeAxisLabel(trend, index)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <p aria-live="polite" className="mt-2.5 mb-1 min-h-4 text-[11px] leading-relaxed [overflow-wrap:anywhere] text-[#637fa4]">
        {inspection}
      </p>
      <p className="text-[10px] leading-relaxed text-muted">
        {f.notes[kind]}
        {trend.missingTime > 0 && ` ${fill(f.missing, { n: n(trend.missingTime) })}`}
      </p>
    </section>
  );
}

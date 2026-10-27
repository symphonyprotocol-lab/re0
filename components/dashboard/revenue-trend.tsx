'use client';

import { useState } from 'react';
import { MiniTrend, type TrendBar } from '@/components/dashboard/mini-trend';
import { useI18n } from '@/lib/i18n/client';

type Grain = 'day' | 'month';

/**
 * The revenue trend with a day / month switch. Both series are small and
 * computed on the server with the page, so switching is local state rather
 * than a round trip. Values are dollars; the open period's are estimates.
 */
export function RevenueTrend({
  daily,
  monthly,
  legend,
}: {
  daily: TrendBar[];
  monthly: TrendBar[];
  legend: string;
}) {
  const { t } = useI18n();
  const r = t.dashboard.revenue.trend;
  const [grain, setGrain] = useState<Grain>('month');
  const bars = grain === 'day' ? daily : monthly;

  return (
    <MiniTrend
      title={r.title}
      subtitle={grain === 'day' ? r.daySubtitle : r.monthSubtitle}
      legend={legend}
      bars={bars}
      max={Math.max(0.01, ...bars.map((bar) => bar.value))}
      format={(value) => `$${value.toFixed(2)}`}
      action={
        <div className="flex gap-0 rounded-md bg-mutedbg p-[3px]" role="group" aria-label={r.grainLabel}>
          {(['day', 'month'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setGrain(option)}
              aria-pressed={grain === option}
              className={`h-[25px] rounded-md px-[9px] text-[11px] transition-colors ${
                grain === option ? 'bg-card text-ink shadow-md' : 'text-muted hover:text-ink'
              }`}
            >
              {r.grains[option]}
            </button>
          ))}
        </div>
      }
    />
  );
}

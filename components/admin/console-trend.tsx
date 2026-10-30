'use client';

import { useState } from 'react';
import { PanelHead, Panel } from '@/components/admin/ui';
import { TrendBars, type TrendBar } from '@/components/dashboard/mini-trend';

type Grain = 'day' | 'month';

/** The words around the chart; each screen passes its own. */
export interface ConsoleTrendCopy {
  title: string;
  daySubtitle: string;
  monthSubtitle: string;
  total: string;
  grainLabel: string;
  grains: Record<Grain, string>;
}

/**
 * A money trend with a day / month switch, for console screens: the
 * settlements screen plots the creators' earnings, the billing screen the
 * collected revenue. Both series come with the page and the switch is local
 * state. Values are dollars.
 */
export function ConsoleTrend({
  daily,
  monthly,
  copy: s,
}: {
  daily: TrendBar[];
  monthly: TrendBar[];
  copy: ConsoleTrendCopy;
}) {
  const [grain, setGrain] = useState<Grain>('month');
  const bars = grain === 'day' ? daily : monthly;
  const total = bars.reduce((sum, bar) => sum + bar.value, 0);

  return (
    <Panel>
      <PanelHead
        title={s.title}
        description={grain === 'day' ? s.daySubtitle : s.monthSubtitle}
        action={
          <div className="flex items-center gap-3">
            <span className="text-[12px] tracking-[-0.023em] text-steel">
              {s.total} <span className="font-semibold text-ink">${total.toFixed(2)}</span>
            </span>
            <div className="flex gap-0 rounded-[7px] bg-subtle p-[3px]" role="group" aria-label={s.grainLabel}>
              {(['day', 'month'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setGrain(option)}
                  aria-pressed={grain === option}
                  className={`h-[27px] rounded-[5px] px-2.5 text-[12px] tracking-[-0.023em] transition-colors ${
                    grain === option ? 'bg-card text-ink shadow-sm' : 'text-muted hover:text-ink'
                  }`}
                >
                  {s.grains[option]}
                </button>
              ))}
            </div>
          </div>
        }
      />
      <div className="px-[19px] pt-4 pb-3">
        <TrendBars
          bars={bars}
          max={Math.max(0.01, ...bars.map((bar) => bar.value))}
          format={(value) => `$${value.toFixed(2)}`}
        />
      </div>
    </Panel>
  );
}

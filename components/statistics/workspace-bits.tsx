import type { Messages } from '@/i18n';
import { formatNumber } from '@/i18n/format';
import type { Locale } from '@/i18n/locale';

/* Small pieces of `/workspace/sources` and `/workspace/answers` (prototype workspace-details.js). */

/** The strip of totals under the heading. */
export function SummaryStrip({ locale, items }: { locale: Locale; items: [string, number][] }) {
  return (
    <div className="flex flex-wrap gap-3">
      {items.map(([label, value]) => (
        <span key={label} className="card flex min-w-[160px] flex-1 items-baseline justify-between gap-3 px-4 py-3 text-[12px] text-muted sm:flex-none">
          {label}
          <strong className="font-mono text-[20px] text-ink">{formatNumber(value, locale)}</strong>
        </span>
      ))}
    </div>
  );
}

export function TakenDownTag({ t }: { t: Messages }) {
  return <span className="tag flex-none border-[#f1d4d4] bg-[#fff3f3] text-red">{t.statistics.workspace.takenDown}</span>;
}

export const STATE_TONES: Record<'ready' | 'processing' | 'failed' | 'paused', string> = {
  ready: 'border-[#cfe9df] bg-[#eef8f4] text-green',
  processing: 'border-[#d8e6fb] bg-soft text-blue',
  failed: 'border-[#f1d4d4] bg-[#fff3f3] text-red',
  paused: '',
};

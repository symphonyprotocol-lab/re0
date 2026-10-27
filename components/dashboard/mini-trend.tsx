import type { ReactNode } from 'react';
import { PANEL } from '@/components/dashboard/ui';

/** Plot height in px; every bar is scaled against `max` over this span. */
const PLOT_HEIGHT = 84;
const LABEL_HEIGHT = 17;

export interface TrendBar {
  label?: string;
  /** What the hover title calls the bar; defaults to `label`. */
  hint?: string;
  /**
   * Hide the label below the `sm` breakpoint. Every bar is labelled on a wide
   * card; on a phone thirty dates do not fit, so callers thin them out.
   */
  minor?: boolean;
  value: number;
}

/**
 * A UTC day, `YYYY-MM-DD`, as the tick under its bar: the day of the month,
 * with the month in front (`M/D`) on the first of a month and on the first bar
 * -- thirty full dates do not fit under thirty bars, thirty day numbers do.
 */
export function dayTick(date: string, first = false): string {
  const day = Number(date.slice(8, 10));
  return first || day === 1 ? `${Number(date.slice(5, 7))}/${day}` : String(day);
}

/** Whether bar `index` of `count` loses its label on a narrow screen: all but every `every`th, counted back from the newest. */
export function minorOnNarrow(index: number, count: number, every: number): boolean {
  return (count - 1 - index) % every !== 0;
}

/**
 * Twelve-bar trend card -- design source frames `i027cz` and `L4Z2w`.
 *
 * No axis: the design labels the total in the header instead, so the bars only
 * need to be proportional to each other.
 */
export function MiniTrend({
  title,
  subtitle,
  legend,
  bars,
  max,
  format,
  action,
}: {
  title: string;
  subtitle: string;
  legend: ReactNode;
  bars: TrendBar[];
  max: number;
  format: (value: number) => string;
  /** A control beside the legend, e.g. a range switch. */
  action?: ReactNode;
}) {
  return (
    <section className={`${PANEL} flex flex-col gap-[15px] px-[23px] py-[21px]`}>
      <div className="flex flex-wrap items-start justify-between gap-3.5">
        <div className="flex flex-col gap-1">
          <h2 className="text-[14px] leading-[1.5] text-ink">{title}</h2>
          <p className="text-[11px] text-muted">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-steel">
            <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-brand" />
            {legend}
          </span>
          {action}
        </div>
      </div>

      <TrendBars bars={bars} max={max} format={format} />
    </section>
  );
}

/**
 * The bars alone, for a card with its own frame -- the console's trends draw
 * them inside a console panel. One solid colour, the surface's `brand`
 * token, so the same plot reads blue on the dashboard and teal in the console.
 */
export function TrendBars({
  bars,
  max,
  format,
}: {
  bars: TrendBar[];
  max: number;
  format: (value: number) => string;
}) {
  return (
    <ul
      className={`flex items-end border-b border-line px-[5px] pb-0.5 ${
        /* A month of days needs the room for its ticks more than it needs the air between bars. */
        bars.length > 16 ? 'gap-[3px] sm:gap-1' : 'gap-1 sm:gap-[11px]'
      }`}
    >
      {bars.map((bar, index) => (
        <li
          key={bar.hint ?? bar.label ?? index}
          className="flex min-w-0 flex-1 flex-col items-center justify-end"
          style={{ height: PLOT_HEIGHT + LABEL_HEIGHT }}
          title={`${bar.hint ?? bar.label ?? ''} ${format(bar.value)}`}
        >
          <span
            className="w-full max-w-6 rounded-t bg-brand"
            style={{ height: (bar.value / max) * PLOT_HEIGHT }}
          />
          <span
            className={`flex h-[17px] items-start pt-[5px] text-[10px] whitespace-nowrap text-muted ${
              bar.minor ? 'max-sm:invisible' : ''
            }`}
            aria-hidden={bar.label ? undefined : true}
          >
            {bar.label ?? ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

import type { TrafficDay } from '@/lib/services/traffic';

/** The three series, in legend order, with their colours (traffic.css repeats them for the legend dots). */
export const TRAFFIC_SERIES = [
  { key: 'views', color: '#127ee3' },
  { key: 'visitors', color: '#7c5cff' },
  { key: 'inbound', color: '#12a37a' },
] as const;
export type TrafficSeries = (typeof TRAFFIC_SERIES)[number]['key'];

/** A ceiling for the axis: 4, 8, 20, 40, 100, 200, … so the four labels stay round (as on the overview). */
function axisMax(peak: number): number {
  for (let scale = 1; ; scale *= 10) for (const step of [4, 8, 20]) if (peak <= step * scale) return step * scale;
}

/**
 * The traffic trend: the overview's 700 × 150 line chart with a line per
 * series, page views, visitors and inbound visits on one axis, and five
 * labels below. One point is drawn as a dot.
 */
export function TrafficChart({ points, label, names, unit }: { points: TrafficDay[]; label: string; names: Record<TrafficSeries, string>; unit: 'day' | 'month' }) {
  const max = axisMax(Math.max(1, ...points.flatMap((point) => [point.views, point.visitors, point.inbound])));
  const last = Math.max(1, points.length - 1);
  const x = (index: number) => (points.length === 1 ? 350 : (index * 700) / last);
  const y = (value: number) => 145 - (value / max) * 130;
  const ticks = points.length === 1 ? [points[0]!.day] : [0, 1, 2, 3, 4].map((step) => points[Math.round((step * last) / 4)]?.day ?? '');
  const tick = (day: string) => (unit === 'month' ? day : day.slice(5).replace('-', '.'));
  return (
    <>
      <div className="trend-chart traffic-chart">
        <div className="chart-y">
          {[1, 0.75, 0.5, 0.25].map((share) => (
            <span key={share}>{Math.round(max * share)}</span>
          ))}
        </div>
        <svg viewBox="0 0 700 150" preserveAspectRatio="none" aria-label={label} role="img">
          {[15, 50, 85, 120].map((line) => (
            <path key={line} d={`M0 ${line}H700`} stroke="#e9edf5" strokeDasharray="3 5" fill="none" />
          ))}
          {TRAFFIC_SERIES.map(({ key, color }) =>
            points.length === 1 ? (
              <circle key={key} cx={x(0)} cy={y(points[0]![key])} r="4" fill={color} />
            ) : (
              <path key={key} d={points.map((point, index) => `${index ? 'L' : 'M'}${x(index)} ${y(point[key])}`).join(' ')} stroke={color} strokeWidth="2.2" fill="none" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            ),
          )}
        </svg>
        <div className="chart-x">
          {ticks.map((day, index) => (
            <span key={index}>{tick(day)}</span>
          ))}
        </div>
      </div>
      <div className="chart-legend traffic-legend">
        {TRAFFIC_SERIES.map(({ key }) => (
          <span key={key} className={`traffic-key traffic-${key}`}>
            <i />
            {names[key]}
          </span>
        ))}
      </div>
    </>
  );
}

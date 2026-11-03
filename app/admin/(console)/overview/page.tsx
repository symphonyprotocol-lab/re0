import type { Metadata } from 'next';
import Link from 'next/link';
import { adminOverview } from '@/lib/services/admin-overview';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { CI, type ConsoleIconName } from '@/components/admin/console-icon';
import { PageHead, RecordsTable, Stats } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { AuditTable } from '@/components/admin/audit-kit';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.consoleRees.overview.title };
}

/** Small amounts keep their cents' fractions: an embedding month can cost $0.0042. */
function usd(value: number, locale: 'zh' | 'en'): string {
  return new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value);
}

/** A ceiling for the chart's axis: 4, 8, 20, 40, 100, 200, … so the four labels stay round. */
function axisMax(peak: number): number {
  for (let scale = 1; ; scale *= 10) for (const step of [4, 8, 20]) if (peak <= step * scale) return step * scale;
}

/**
 * The prototype's trend line (suite.js `trendChart`): a 700 × 150 area chart
 * with four dashed guides, the axis on the left and five dates below.
 */
function TrendChart({ days, label }: { days: { day: string; answers: number }[]; label: string }) {
  const max = axisMax(Math.max(1, ...days.map((day) => day.answers)));
  const last = Math.max(1, days.length - 1);
  const points = days.map((day, index) => `${(index * 700) / last} ${145 - (day.answers / max) * 130}`);
  const ticks = [0, 1, 2, 3, 4].map((step) => days[Math.round((step * last) / 4)]?.day ?? '');
  return (
    <div className="trend-chart">
      <div className="chart-y">
        {[1, 0.75, 0.5, 0.25].map((share) => (
          <span key={share}>{Math.round(max * share)}</span>
        ))}
      </div>
      <svg viewBox="0 0 700 150" preserveAspectRatio="none" aria-label={label} role="img">
        <defs>
          <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#127ee3" stopOpacity=".15" />
            <stop offset="100%" stopColor="#127ee3" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[15, 50, 85, 120].map((y) => (
          <path key={y} d={`M0 ${y}H700`} stroke="#e9edf5" strokeDasharray="3 5" fill="none" />
        ))}
        <path d={`M0 150 ${points.map((point) => `L${point}`).join(' ')} L700 150Z`} fill="url(#trend-fill)" />
        <path d={points.map((point, index) => `${index ? 'L' : 'M'}${point}`).join(' ')} stroke="#127ee3" strokeWidth="2.5" fill="none" strokeLinejoin="round" />
      </svg>
      <div className="chart-x">
        {ticks.map((day, index) => (
          <span key={index}>{day.slice(5).replace('-', '.')}</span>
        ))}
      </div>
    </div>
  );
}

/** `/admin/overview` (2.5 "概览", prototype `adminOverview()`), on live figures. */
export default async function OverviewPage() {
  const { t, locale } = await serverMessages();
  const o = t.consoleRees.overview;
  const data = await adminOverview();
  const n = (value: number) => formatNumber(value, locale);
  const answers = data.trend.reduce((sum, day) => sum + day.answers, 0);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('-', '.');
  // The prototype's order: money first, then identity, verification, models.
  const attention: { href: string; count: number; label: string; icon: ConsoleIconName }[] = [
    { href: '/admin/payouts', count: data.pending.payouts, label: o.attention.payouts, icon: 'wallet' },
    { href: '/admin/kyc?status=pending', count: data.pending.kyc, label: o.attention.kyc, icon: 'shield' },
    { href: '/admin/verifications', count: data.pending.verifications, label: o.attention.verifications, icon: 'shield' },
    { href: '/admin/models', count: data.pending.reembed, label: o.attention.reembed, icon: 'refresh' },
  ];
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: t.console.nav.overview }]} />
      <PageHead
        title={o.title}
        lede={o.lede}
        actions={
          <span className="console-date">
            <CI name="clock" /> {fill(t.console.overview.date, { date: today })}
          </span>
        }
      />
      <Stats
        items={[
          { label: o.cards.users, value: n(data.users.total), note: fill(o.cards.usersNote, { n: n(data.users.disabled) }), icon: 'users' },
          { label: o.cards.rees, value: n(data.rees.total), note: fill(o.cards.reesNote, { public: n(data.rees.public), moderated: n(data.rees.moderated) }), icon: 'dot' },
          { label: o.cards.sources, value: n(data.sources.total), note: fill(o.cards.sourcesNote, { ready: n(data.sources.ready) }), icon: 'file' },
          { label: o.cards.questions, value: n(data.questions30), note: o.cards.questionsNote, icon: 'chat' },
        ]}
      />
      <div className="console-overview-grid">
        <section className="card console-chart">
          <div className="between">
            <div>
              <h2>{o.trend.title}</h2>
              <p>{o.trend.lede}</p>
            </div>
            <span className="tag blue">{o.trend.daily}</span>
          </div>
          <TrendChart days={data.trend} label={t.console.overview.chartLabel} />
          <div className="chart-legend">
            <i className="dot" />
            {o.trend.legend}
            <span>{answers ? fill(o.trend.total, { n: n(answers) }) : o.trend.empty}</span>
          </div>
        </section>
        <aside className="card console-actions">
          <p className="eyebrow">{o.attention.eyebrow}</p>
          <h2>{o.attention.title}</h2>
          {attention.map((item) => (
            <Link key={item.label} href={item.href} className="attention-row">
              <CI name={item.icon} />
              <strong>{n(item.count)}</strong>
              <span>{item.label}</span>
              <CI name="chevron" />
            </Link>
          ))}
          <div className="console-income">
            <span>{o.income.earned}</span>
            <strong className="mono">{n(data.earned30)}</strong>
          </div>
        </aside>
      </div>
      <section className="card console-model-cost">
        <div className="between">
          <div>
            <h2>{o.models.title}</h2>
            <p>{fill(o.models.lede, { start: data.month.start, end: data.month.end })}</p>
          </div>
          <Link href="/admin/models" className="text-link">
            {o.models.manage}
            <CI name="arrow" />
          </Link>
        </div>
        <RecordsTable
          label={t.console.list.tableRegion}
          empty={t.console.list.empty}
          head={[t.console.overview.kind, o.models.active, o.models.calls, t.console.overview.cost]}
          rows={data.models.map((row) => [
            t.admin.models.kinds[row.kind],
            <>
              <code>{row.active}</code>
              {row.rows.length > 1 &&
                row.rows.map((entry) => (
                  <small key={entry.model} className="cell-subline">
                    {fill(o.models.byModel, { model: entry.model, n: n(entry.calls) })}
                  </small>
                ))}
            </>,
            n(row.calls),
            row.calls > 0 && row.cost === null ? (
              <span title={o.models.noPrice}>—</span>
            ) : (
              <>
                {usd(row.cost ?? 0, locale)}
                {row.unpriced && <small className="cell-subline">* {o.models.unpriced}</small>}
              </>
            ),
          ])}
        />
      </section>
      <section className="card mt24">
        <div className="console-table-head">
          <h2>{o.recent.title}</h2>
          <Link href="/admin/audit" className="text-link">
            {o.recent.all}
          </Link>
        </div>
        <AuditTable t={t} locale={locale} rows={data.recent} from="/admin/overview" />
      </section>
    </ConsolePage>
  );
}

import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { requireAdministrator } from '@/lib/http/admin';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import { periodFilter, periodRange, reportingDate } from '@/lib/domain/statistics';
import { DIRECT_SOURCE, INTERNAL_SOURCE } from '@/lib/domain/traffic';
import { TRAFFIC_LANDING_TOP, trafficReport } from '@/lib/services/traffic';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { ConsolePeriodControls } from '@/components/admin/finance-chart';
import { PageHead, RecordsTable, Stats, Tag } from '@/components/admin/list-kit';
import { TrafficChart } from '@/components/admin/traffic';
import '@/components/admin/traffic.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await serverMessages()).t.traffic.title };
}

type Params = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';

/**
 * `/admin/traffic` (「流量」): first-party page views, visitors and inbound
 * visits for a period (all time / day / week / month / custom, UTC+8), the
 * daily trend, the breakdown by source and page type, and the top landing
 * pages of each source (lib/services/traffic.ts).
 */
export default async function TrafficPage({ searchParams }: { searchParams: Promise<Params> }) {
  const administrator = await requireAdministrator();
  const { t, locale } = await serverMessages();
  const c = t.traffic;
  const params = await searchParams;
  const filter = periodFilter(params);
  const report = await trafficReport(administrator, periodRange(filter));
  const n = (value: number) => formatNumber(value, locale);
  const totals = report.totals;
  const visits = totals.inbound + totals.internal;
  const sourceName = (source: string) => (source === DIRECT_SOURCE ? c.names.direct : source === INTERNAL_SOURCE ? c.names.internal : source);
  const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '—');
  const picked = first(params.source);
  const selected = report.landing.bySource.find((entry) => entry.source === picked) ?? null;
  const landingPages = selected ? selected.pages : report.landing.all;
  const sourceHref = (source: string | null) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (key !== 'source' && first(value)) next.set(key, first(value));
    if (source) next.set('source', source);
    const query = next.toString();
    return query ? `/admin/traffic?${query}` : '/admin/traffic';
  };
  const points = report.trend.points;
  const empty = points.every((point) => point.views === 0);
  const span = points.length ? { start: points[0]!.day, end: points[points.length - 1]!.day } : { start: reportingDate(), end: reportingDate() };
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: c.title }]} />
      <div className="console-body traffic-page">
        <PageHead title={c.title} lede={c.lede} />
        <div className="traffic-period">
          <ConsolePeriodControls filter={filter} id="traffic-period" />
        </div>
        <Stats
          items={[
            { label: c.cards.views, value: n(totals.views), note: c.cards.viewsNote, icon: 'file' },
            { label: c.cards.visitors, value: n(totals.visitors), note: totals.exactVisitors ? c.cards.visitorsExact : c.cards.visitorsSummed, icon: 'users' },
            { label: c.cards.inbound, value: n(totals.inbound), note: c.cards.inboundNote, icon: 'link' },
            { label: c.cards.perVisit, value: visits > 0 ? (totals.views / visits).toFixed(1) : '—', note: c.cards.perVisitNote, icon: 'chart' },
          ]}
        />
        <section className="card console-chart">
          <div className="between">
            <div>
              <h2>{report.trend.unit === 'month' ? c.trend.titleMonth : c.trend.title}</h2>
              <p>{fill(c.trend.lede, span)}</p>
            </div>
          </div>
          <TrafficChart points={points} unit={report.trend.unit} label={c.trend.label} names={c.series} />
          {empty && <p className="traffic-empty">{c.trend.empty}</p>}
        </section>
        <div className="traffic-grid">
          <section className="card traffic-section">
            <h2>{c.sources.title}</h2>
            <p>{c.sources.lede}</p>
            <RecordsTable
              label={t.console.list.tableRegion}
              empty={c.trend.empty}
              head={[c.sources.source, c.sources.channel, c.sources.inbound, c.sources.share, c.sources.views, c.sources.visitors, c.sources.landing]}
              rows={report.sources.map((row) => [
                <strong key="s">{sourceName(row.source)}</strong>,
                <Tag key="c" tone={row.channel === 'social' ? 'blue' : row.channel === 'search' ? 'green' : row.channel === 'campaign' ? 'orange' : 'grey'}>
                  {c.channels[row.channel]}
                </Tag>,
                n(row.inbound),
                row.source === INTERNAL_SOURCE ? '—' : percent(row.inbound, totals.inbound),
                n(row.views),
                n(row.visitors),
                <Link key="l" className="text-link" href={sourceHref(row.source)} scroll={false}>
                  {c.sources.landing}
                </Link>,
              ])}
            />
          </section>
          <section className="card traffic-section">
            <h2>{c.kinds.title}</h2>
            <p>{c.kinds.lede}</p>
            <RecordsTable
              label={t.console.list.tableRegion}
              empty={c.trend.empty}
              head={[c.kinds.kind, c.sources.views, c.sources.inbound]}
              rows={report.kinds.map((row) => [c.kinds.names[row.kind], n(row.views), n(row.inbound)])}
            />
          </section>
        </div>
        <section className="card traffic-section" id="landing">
          <h2>{c.landing.title}</h2>
          <p>{fill(c.landing.lede, { n: n(TRAFFIC_LANDING_TOP) })}</p>
          <nav className="traffic-tabs" aria-label={c.sources.title}>
            <Link href={sourceHref(null)} scroll={false} aria-current={selected ? undefined : 'true'}>
              {c.landing.all}
            </Link>
            {report.landing.bySource.map((entry) => (
              <Link key={entry.source} href={sourceHref(entry.source)} scroll={false} aria-current={selected?.source === entry.source ? 'true' : undefined}>
                {sourceName(entry.source)}
              </Link>
            ))}
          </nav>
          <RecordsTable
            label={t.console.list.tableRegion}
            empty={c.landing.empty}
            head={[c.landing.path, c.kinds.kind, c.landing.visits]}
            rows={landingPages.map((row) => [
              <a key="p" className="text-link" href={row.path} target="_blank" rel="noreferrer">
                <code>{row.path}</code>
              </a>,
              c.kinds.names[row.kind],
              n(row.visits),
            ])}
          />
        </section>
        <section className="card traffic-notes">
          <h2>{c.notes.title}</h2>
          <p>{c.notes.counted}</p>
          <p>{c.notes.notCounted}</p>
          <p>{c.notes.twitter}</p>
          <p>{c.notes.privacy}</p>
        </section>
      </div>
    </ConsolePage>
  );
}

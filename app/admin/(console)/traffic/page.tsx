import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { requireAdministrator } from '@/lib/http/admin';
import { serverMessages } from '@/i18n/server';
import { fill, formatNumber } from '@/i18n/format';
import type { CrawlerMetric } from '@/lib/domain/crawler-traffic';
import { periodFilter, periodRange, reportingDate } from '@/lib/domain/statistics';
import { DIRECT_SOURCE, INTERNAL_SOURCE } from '@/lib/domain/traffic';
import { TRAFFIC_LANDING_TOP, trafficReport } from '@/lib/services/traffic';
import { crawlerReport } from '@/lib/services/crawler-traffic';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { ConsolePeriodControls } from '@/components/admin/finance-chart';
import { PageHead, RecordsTable, Stats, Tag } from '@/components/admin/list-kit';
import { CrawlerChart, TrafficChart } from '@/components/admin/traffic';
import '@/components/admin/traffic.css';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await serverMessages()).t.traffic.title };
}

type Params = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? '';
const CRAWL_METRICS: CrawlerMetric[] = ['originBytes', 'invocations', 'requests'];
const gigabytes = (bytes: number) => `${(bytes / 1e9).toLocaleString('en-US', { maximumFractionDigits: bytes >= 1e11 ? 0 : bytes >= 1e9 ? 1 : 2 })} GB`;
const usd = (amount: number) => `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * `/admin/traffic` (「流量」): first-party page views, visitors and inbound
 * visits for a period (all time / day / week / month / custom, UTC+8), the
 * daily trend, the breakdown by source and page type, and the top landing
 * pages of each source (lib/services/traffic.ts); then 「爬虫 / 基础设施」:
 * every request by crawler family and route, and the Vercel bill, as the
 * daily cron read them from Vercel (lib/services/crawler-traffic.ts).
 */
export default async function TrafficPage({ searchParams }: { searchParams: Promise<Params> }) {
  const administrator = await requireAdministrator();
  const { t, locale } = await serverMessages();
  const c = t.traffic;
  const params = await searchParams;
  const filter = periodFilter(params);
  const range = periodRange(filter);
  const [report, crawl] = await Promise.all([trafficReport(administrator, range), crawlerReport(administrator, range)]);
  const n = (value: number) => formatNumber(value, locale);
  const totals = report.totals;
  const visits = totals.inbound + totals.internal;
  const sourceName = (source: string) => (source === DIRECT_SOURCE ? c.names.direct : source === INTERNAL_SOURCE ? c.names.internal : source);
  const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 1000) / 10}%` : '—');
  const picked = first(params.source);
  const selected = report.landing.bySource.find((entry) => entry.source === picked) ?? null;
  const landingPages = selected ? selected.pages : report.landing.all;
  const hrefWith = (name: string, value: string | null, hash = '') => {
    const next = new URLSearchParams();
    for (const [key, entry] of Object.entries(params)) if (key !== name && first(entry)) next.set(key, first(entry));
    if (value) next.set(name, value);
    const query = next.toString();
    return `${query ? `/admin/traffic?${query}` : '/admin/traffic'}${hash}`;
  };
  const sourceHref = (source: string | null) => hrefWith('source', source);
  const k = c.crawlers;
  const crawlMetric = CRAWL_METRICS.find((metric) => metric === first(params.crawl)) ?? 'originBytes';
  const crawlShare = (part: number, whole: number) => fill(k.cards.crawlerShare, { share: percent(part, whole) });
  const crawlEmpty = crawl.fetchedDays === 0;
  const projectServices = crawl.cost.services.filter((row) => row.scope === 'project');
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
        <div className="crawler-head" id="crawlers">
          <p className="eyebrow section-kicker">{k.kicker}</p>
          <h2>{k.title}</h2>
          <p>{k.lede}</p>
          {crawl.fetchedThrough && <p>{fill(k.fetched, { n: n(crawl.fetchedDays), day: crawl.fetchedThrough })}</p>}
        </div>
        {!crawl.configured && <section className="card crawler-notice">{k.notConfigured}</section>}
        {crawl.configured && crawlEmpty && <section className="card crawler-notice">{k.noData}</section>}
        <Stats
          items={[
            { label: k.cards.requests, value: crawlEmpty ? '—' : n(crawl.totals.requests), note: crawlShare(crawl.crawlers.requests, crawl.totals.requests), icon: 'globe' },
            { label: k.cards.invocations, value: crawlEmpty ? '—' : n(crawl.totals.invocations), note: crawlShare(crawl.crawlers.invocations, crawl.totals.invocations), icon: 'layers' },
            { label: k.cards.origin, value: crawlEmpty ? '—' : gigabytes(crawl.totals.originBytes), note: crawlShare(crawl.crawlers.originBytes, crawl.totals.originBytes), icon: 'upload' },
            {
              label: k.cards.cost,
              value: crawl.cost.span ? usd(crawl.cost.project) : '—',
              note: crawl.cost.span ? fill(k.cards.costSpan, crawl.cost.span) : k.cards.costNone,
              icon: 'wallet',
            },
          ]}
        />
        <section className="card console-chart crawler-chart">
          <div className="between">
            <div>
              <h2>{crawl.trend.unit === 'month' ? k.chart.titleMonth : k.chart.title}</h2>
              <p>{crawl.trend.points.length ? fill(c.trend.lede, { start: crawl.trend.points[0]!.day, end: crawl.trend.points[crawl.trend.points.length - 1]!.day }) : k.noData}</p>
            </div>
            <nav className="traffic-tabs" aria-label={k.chart.label}>
              {CRAWL_METRICS.map((metric) => (
                <Link key={metric} href={hrefWith('crawl', metric === 'originBytes' ? null : metric, '#crawlers')} scroll={false} aria-current={crawlMetric === metric ? 'true' : undefined}>
                  {k.chart.metric[metric]}
                </Link>
              ))}
            </nav>
          </div>
          <CrawlerChart points={crawl.trend.points} metric={crawlMetric} unit={crawl.trend.unit} label={k.chart.label} names={k.names} />
        </section>
        <section className="card traffic-section">
          <h2>{k.families.title}</h2>
          <p>{k.families.lede}</p>
          <RecordsTable
            label={t.console.list.tableRegion}
            empty={k.noData}
            head={[k.families.family, k.cards.requests, k.cards.invocations, k.cards.origin, k.families.share, k.families.cost, k.families.agents]}
            rows={crawl.families.map((row) => [
              <strong key="f">{k.names[row.family]}</strong>,
              n(row.requests),
              n(row.invocations),
              gigabytes(row.originBytes),
              percent(row.originBytes, crawl.totals.originBytes),
              row.cost === null ? '—' : usd(row.cost),
              <span key="a" className="crawler-agents">
                {row.agents.map((agent) => agent.agent).join(', ') || '—'}
              </span>,
            ])}
          />
        </section>
        <section className="card traffic-section">
          <h2>{k.routes.title}</h2>
          <p>{k.routes.lede}</p>
          <RecordsTable
            label={t.console.list.tableRegion}
            empty={k.noData}
            head={[k.routes.route, k.cards.requests, k.cards.invocations, k.cards.origin, k.routes.crawlers, k.routes.top]}
            rows={crawl.routes.map((row) => [
              <code key="r">{row.route}</code>,
              n(row.requests),
              n(row.invocations),
              gigabytes(row.originBytes),
              percent(row.crawlers.originBytes, row.originBytes),
              row.top ? k.names[row.top] : '—',
            ])}
          />
        </section>
        <section className="card traffic-section">
          <h2>{k.cost.title}</h2>
          <p>{k.cost.lede}</p>
          <RecordsTable
            label={t.console.list.tableRegion}
            empty={k.cost.empty}
            head={[k.cost.service, k.cost.quantity, k.cost.amount]}
            rows={[
              ...projectServices.map((row) => [row.service, row.unit ? `${n(Math.round(row.quantity * 100) / 100)} ${row.unit}` : '—', usd(row.cost)]),
              ...(crawl.cost.span
                ? [
                    [<strong key="p">{k.cost.project}</strong>, '', <strong key="v">{usd(crawl.cost.project)}</strong>],
                    [k.cost.team, '', usd(crawl.cost.team)],
                  ]
                : []),
            ]}
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

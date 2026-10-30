import type { Metadata } from 'next';
import { MiniTrend } from '@/components/dashboard/mini-trend';
import {
  RequestLog,
  type RequestLogFilterView,
  type RequestLogView,
} from '@/components/dashboard/request-log';
import { PageHeader, StatTile } from '@/components/dashboard/ui';
import {
  BracesIcon,
  CircleCheckIcon,
  ClockIcon,
  DatabaseIcon,
} from '@/components/ui/icons';
import { listWorkspaceAssets } from '@/lib/application/assets';
import { queryRequests, requestStats } from '@/lib/application/plans';
import {
  parseRequestFilter,
  requestFilterParams,
  REQUEST_PAGE_SIZE,
  type RequestEntrypoint,
} from '@/lib/domain/request-log';
import { workspaceUsage } from '@/lib/http/dashboard';
import { requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.requests.metaTitle };
}

const TREND_DAYS = 12;

/**
 * The requests screen, on the ledger. architecture.md 6.3 and 11.1: the
 * trend is the rebuilt usage summary for the current period, and the log
 * lists real requests -- outcome, asset, latency, returned tokens, the
 * key's mask, never the query text. Filters
 * arrive as GET parameters (requirement.md 5.2) and are applied by the
 * database, so the footer's count is the truth about the whole filtered set.
 *
 * The stat strip describes that same filtered set, not the fifty rows this
 * page happens to hold: success rate and average latency used to be derived
 * from `log.rows`, which made `?page=2` report a different success rate for
 * an unchanged filter, and sat them beside two figures that covered the whole
 * period instead. All four now come from one aggregate over the filter, so
 * the four tiles, the footer's count and the CSV export all answer the same
 * question. The trend below is the period, and says so.
 */
export default async function DashboardRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, { locale, t }, params] = await Promise.all([
    requireSession('/dashboard/requests'),
    translations(),
    searchParams,
  ]);
  const r = t.dashboard.requests;
  const filter = parseRequestFilter(params);

  const [overview, log, matched, assets] = await Promise.all([
    workspaceUsage(session.workspace.id),
    queryRequests(session.workspace.id, filter, REQUEST_PAGE_SIZE),
    requestStats(session.workspace.id, filter),
    listWorkspaceAssets(session.workspace.id),
  ]);
  const requests = log.rows;

  const number = new Intl.NumberFormat(locale);
  const stats = [
    { key: 'calls', value: number.format(matched.total), label: r.stats.calls },
    {
      key: 'success',
      value:
        matched.total === 0 ? '—' : `${((matched.served / matched.total) * 100).toFixed(1)}%`,
      label: r.stats.success,
    },
    {
      key: 'latency',
      value:
        matched.averageLatencyMs === null
          ? '—'
          : `${number.format(matched.averageLatencyMs)} ms`,
      label: r.stats.latency,
    },
    {
      key: 'tokens',
      value: number.format(matched.returnedTokens),
      label: r.stats.tokens,
    },
  ];

  /* The last N days, zero-filled: an empty day is a bar of height zero. */
  const byDate = new Map(overview.buckets.map((bucket) => [bucket.date, bucket.calls]));
  const day = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const bars = Array.from({ length: TREND_DAYS }, (_, index) => {
    const at = new Date(Date.now() - (TREND_DAYS - 1 - index) * 86_400_000);
    const date = at.toISOString().slice(0, 10);
    return { label: day.format(at), value: byDate.get(date) ?? 0 };
  });
  const max = Math.max(1, ...bars.map((bar) => bar.value));

  const time = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const surfaces = r.filters.entrypoints;
  const entries: RequestLogView[] = requests.map((row) => ({
    id: row.id,
    requestId: row.requestId,
    time: time.format(new Date(row.createdAt)),
    operation: row.operation,
    surface:
      row.entrypoint && row.entrypoint in surfaces
        ? surfaces[row.entrypoint as RequestEntrypoint]
        : '—',
    asset: row.assetPublicId ?? '—',
    key: row.apiKeyMasked ?? '—',
    status: row.statusCode,
    latency: row.latencyMs === null ? '—' : `${row.latencyMs} ms`,
    tokens: row.returnedTokens === null ? '—' : number.format(row.returnedTokens),
  }));

  const query = requestFilterParams(filter, 1);
  query.delete('page');
  const filterView: RequestLogFilterView = {
    q: query.get('q') ?? '',
    from: query.get('from') ?? '',
    to: query.get('to') ?? '',
    status: query.get('status') ?? '',
    entrypoint: query.get('entrypoint') ?? '',
    asset: query.get('asset') ?? '',
  };
  const pageHref = (page: number) => {
    const params = requestFilterParams(filter, page);
    const text = params.toString();
    return text ? `/dashboard/requests?${text}` : '/dashboard/requests';
  };
  const exportHref = query.toString()
    ? `/dashboard/export/requests?${query.toString()}`
    : '/dashboard/export/requests';
  const pageCount = Math.max(1, Math.ceil(log.total / log.pageSize));

  const STAT_ICONS = [BracesIcon, CircleCheckIcon, ClockIcon, DatabaseIcon];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow={r.eyebrow} title={r.title} description={r.description} />

      <section className="grid grid-cols-2 gap-[9px] sm:grid-cols-4">
        {stats.map((stat, index) => {
          const Icon = STAT_ICONS[index] ?? BracesIcon;
          return (
            <StatTile key={stat.key} icon={<Icon size={17} />} value={stat.value} label={stat.label} />
          );
        })}
      </section>

      <MiniTrend
        title={r.trendTitle}
        subtitle={r.trendSubtitle}
        legend={fill(r.trendLegend, {
          used: number.format(overview.planCallsThisPeriod),
          limit: number.format(overview.planAllowance),
        })}
        bars={bars}
        max={max}
        format={(value) => fill(r.trendFormat, { value })}
      />

      <RequestLog
        entries={entries}
        filter={filterView}
        assets={assets.map((asset) => ({
          publicId: asset.publicId,
          title: asset.title,
        }))}
        total={log.total}
        page={log.page}
        pageCount={pageCount}
        previousHref={pageHref(Math.max(1, log.page - 1))}
        nextHref={pageHref(log.page + 1)}
        exportHref={exportHref}
      />
    </div>
  );
}

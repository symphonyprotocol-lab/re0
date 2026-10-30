import type { Metadata } from 'next';
import Link from 'next/link';
import { GrowthChart } from '@/components/admin/growth-chart';
import {
  CONSOLE_PANEL,
  ConsoleButton,
  ConsolePageHeader,
  Meter,
  Panel,
  PanelHead,
  Pill,
} from '@/components/admin/ui';
import {
  ArrowUpRightIcon,
  CalendarIcon,
  CircleDollarSignIcon,
  DatabaseIcon,
  ReceiptIcon,
  TrendingUpIcon,
  UsersIcon,
} from '@/components/ui/icons';
import {
  consoleOverview,
  healthNeedsAttention,
  type ConsoleAuditRow,
  type WindowedCount,
} from '@/lib/application/administration';
import type { AdminCapability } from '@/lib/domain/admin';
import { percentFromBps } from '@/lib/domain/billing';
import {
  changeBps,
  DEFAULT_OVERVIEW_RANGE,
  OVERVIEW_RANGES,
  shareBps,
  type OverviewRange,
} from '@/lib/domain/overview';
import { requireAdmin } from '@/lib/http/admin';
import type { Dictionary } from '@/lib/i18n/dictionary';
import { fill } from '@/lib/i18n/format';
import { getMessages } from '@/lib/i18n/server';
import { money, oneOf } from '../list-params';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).admin.overview.title };
}

type Overview = Dictionary['admin']['overview'];

interface StatTile {
  need: AdminCapability;
  label: string;
  value: string;
  Icon: typeof UsersIcon;
  /** Period-over-period move in basis points; null when there is nothing to compare. */
  changeBps: number | null;
  /** Which earlier period the move is against; the tiles do not all share one. */
  deltaLabel: string;
  /** What to say under the value when there is no move to show. */
  caption: string;
}

type ActivityTone = 'brand' | 'neutral' | 'amber' | 'rose';

const ACTIVITY_TONE: Record<ActivityTone, string> = {
  brand: 'bg-brandsoft text-brandink',
  neutral: 'bg-mutedbg text-steel',
  amber: 'bg-ambersoft text-amberink',
  rose: 'bg-rosesoft text-err',
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** `2 分钟前`, `3 小时前`, `5 天前` -- the grain the activity list reads at. */
function ago(ms: number, o: Overview): string {
  if (ms < MINUTE_MS) return o.ago.now;
  if (ms < HOUR_MS) return fill(o.ago.minutes, { n: Math.floor(ms / MINUTE_MS) });
  if (ms < DAY_MS) return fill(o.ago.hours, { n: Math.floor(ms / HOUR_MS) });
  return fill(o.ago.days, { n: Math.floor(ms / DAY_MS) });
}

/** `40 分钟`, `1.5 小时`, `3 天` -- how long an asset has waited. */
function duration(ms: number, o: Overview): string {
  if (ms < HOUR_MS) return fill(o.duration.minutes, { n: Math.max(1, Math.round(ms / MINUTE_MS)) });
  if (ms < DAY_MS) return fill(o.duration.hours, { n: (ms / HOUR_MS).toFixed(1).replace(/\.0$/, '') });
  return fill(o.duration.days, { n: (ms / DAY_MS).toFixed(1).replace(/\.0$/, '') });
}

/** `+12.8%`; the sign is part of the figure, so a fall reads as one. */
function signedPercent(bps: number): string {
  return `${bps > 0 ? '+' : bps < 0 ? '−' : ''}${percentFromBps(Math.abs(bps))}%`;
}

/**
 * A failed action is always red. Beyond that, the tone follows what was
 * touched: an account is amber because suspending one is the console's
 * heaviest lever, a platform asset is brand, and the rest is neutral.
 */
function activityTone(entry: ConsoleAuditRow): ActivityTone {
  if (entry.result !== 'success') return 'rose';
  if (entry.action.startsWith('user.')) return 'amber';
  if (entry.action.startsWith('platform_library.')) return 'brand';
  return 'neutral';
}

function rangeOf(value: string | string[] | undefined): OverviewRange {
  const allowed = OVERVIEW_RANGES.map(String);
  return Number(oneOf(value, allowed, String(DEFAULT_OVERVIEW_RANGE))) as OverviewRange;
}

/**
 * Operations overview -- design source frame `oxEhj`.
 *
 * Every figure comes from `consoleOverview`, which reads the table that owns
 * it and leaves out whatever this session's capabilities do not cover. This
 * is the one console screen open to every administrator -- it is where
 * `requireAdminCapability` sends anyone who lands somewhere they are not
 * entitled to -- so a tile or panel a role may not act on is not rendered,
 * and its query is not run either.
 *
 * The range control is real: `?range=7|30|90` moves the window the tiles
 * compare against and the days the chart draws.
 */
export default async function AdminOverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [session, params, t] = await Promise.all([requireAdmin(), searchParams, getMessages()]);
  const o = t.admin.overview;
  const range = rangeOf(params.range);
  const now = new Date();

  const view = await consoleOverview({ range, capabilities: session.capabilities, now });
  const can = (capability: AdminCapability) => session.capabilities.includes(capability);

  const windowed = (counts: WindowedCount | null) => ({
    value: (counts?.total ?? 0).toLocaleString('en-US'),
    changeBps: counts ? changeBps(counts.inWindow, counts.inPreviousWindow) : null,
    deltaLabel: o.previousWindow,
    caption: fill(o.newInWindow, { count: counts?.inWindow ?? 0 }),
  });

  const revenue = view.revenue;

  const tiles: StatTile[] = (
    [
      { need: 'users', label: o.stats.users, Icon: UsersIcon, ...windowed(view.users) },
      { need: 'assets', label: o.stats.assets, Icon: DatabaseIcon, ...windowed(view.assets) },
      /*
       * Money is compared month to month whatever the range control says --
       * that is how the billing screen and the provider's statements cut it
       * -- so this tile names its period where the others name theirs.
       */
      {
        need: 'billing',
        label: o.stats.revenue,
        Icon: CircleDollarSignIcon,
        value: money(revenue?.monthNetMinor ?? 0, revenue?.currency),
        changeBps: revenue ? changeBps(revenue.monthNetMinor, revenue.previousMonthNetMinor) : null,
        deltaLabel: o.previousMonth,
        caption: o.previousMonthNone,
      },
      /*
       * Paying workspaces and the share of accounts they are. Both need
       * `billing`; the rate also needs `users`, and reads as unavailable
       * rather than zero without it.
       */
      {
        need: 'billing',
        label: o.paid.label,
        Icon: ReceiptIcon,
        value: (view.paidWorkspaces ?? 0).toLocaleString('en-US'),
        changeBps: null,
        deltaLabel: '',
        caption:
          view.conversionBps === null
            ? o.paid.conversionNone
            : fill(o.paid.conversion, { rate: percentFromBps(view.conversionBps) }),
      },
    ] satisfies StatTile[]
  ).filter((tile) => can(tile.need));

  const attention = healthNeedsAttention(view.health);
  const api = view.health.api;
  const index = view.health.index;
  const builds = view.health.builds;
  const finished = builds.succeeded + builds.failed;

  /*
   * Each meter is a share of "fine": successful requests, indexed assets,
   * builds that finished well, assets that have not waited a day. An empty
   * denominator is a full bar -- nothing has gone wrong when nothing happened.
   */
  const health = [
    {
      label: o.health.api,
      value:
        api.requests === 0
          ? o.health.apiNone
          : fill(o.health.apiValue, {
              requests: api.requests.toLocaleString('en-US'),
              rate: percentFromBps(shareBps(api.requests - api.failures, api.requests)),
            }),
      percent: api.requests === 0 ? 100 : ((api.requests - api.failures) / api.requests) * 100,
    },
    {
      label: o.health.index,
      value: index.total === 0 ? o.health.indexNone : fill(o.health.indexValue, index),
      percent: index.total === 0 ? 100 : (index.ready / index.total) * 100,
    },
    {
      label: o.health.builds,
      value: fill(o.health.buildsValue, builds),
      percent: finished === 0 ? 100 : (builds.succeeded / finished) * 100,
    },
  ];

  /*
   * Configuration facts, not probes: each says whether a service is wired
   * up, never whether it answered just now. The payment row is the honest
   * "no": nothing executes a payout until an adapter exists.
   */
  const services = view.services;
  const onOff = (configured: boolean) => (configured ? o.services.on : o.services.off);
  const serviceRows: { label: string; value: string; tone: 'ok' | 'warn' | 'neutral' }[] = [
    {
      label: o.services.llm,
      value: services.llm.model
        ? fill(services.llm.keyPresent ? o.services.llmReady : o.services.llmKeyMissing, {
            model: services.llm.model,
          })
        : o.services.llmNone,
      tone: services.llm.model && services.llm.keyPresent ? 'ok' : 'warn',
    },
    {
      label: o.services.retrieval,
      value: fill(o.services.retrievalValue, {
        embeddings: onOff(services.retrieval.embeddings),
        rerank: onOff(services.retrieval.rerank),
      }),
      tone: services.retrieval.embeddings ? 'ok' : 'warn',
    },
    {
      label: o.services.objectStore,
      value: onOff(services.objectStore),
      tone: services.objectStore ? 'ok' : 'warn',
    },
    {
      label: o.services.ingestion,
      value: onOff(services.ingestion),
      tone: services.ingestion ? 'ok' : 'warn',
    },
    { label: o.services.payments, value: o.services.paymentsNone, tone: 'neutral' },
  ];

  const rangeHref = (days: OverviewRange) =>
    days === DEFAULT_OVERVIEW_RANGE ? '/admin/overview' : `/admin/overview?range=${days}`;

  const actionLabels: Record<string, string> = t.admin.audit.actions;

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Page header -- design source `oxEhj`. */}
      <ConsolePageHeader
        eyebrow={t.admin.eyebrow}
        title={o.title}
        description={o.description}
        action={
          <span className="flex items-center gap-1.5">
            {OVERVIEW_RANGES.map((days) => (
              <ConsoleButton
                key={days}
                href={rangeHref(days)}
                variant={days === range ? 'primary' : 'outline'}
              >
                {days === range ? <CalendarIcon size={14} /> : null}
                {fill(o.range, { days })}
              </ConsoleButton>
            ))}
          </span>
        }
      />

      {/* Metric strip. */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <article key={tile.label} className={`${CONSOLE_PANEL} flex items-center gap-3 p-[18px]`}>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-[9px] bg-brandsoft text-brand">
              <tile.Icon size={18} />
            </span>
            <span className="flex min-w-0 flex-col gap-[3px]">
              <span className="text-[11px] leading-[1.35] tracking-[-0.023em] text-muted">
                {tile.label}
              </span>
              <span className="text-[20px] leading-[1.3] font-semibold tracking-[-0.03em] text-ink">
                {tile.value}
              </span>
              {tile.changeBps !== null ? (
                <span
                  className={`flex items-center gap-1 text-[11px] tracking-[-0.023em] ${
                    tile.changeBps < 0 ? 'text-err' : 'text-good'
                  }`}
                >
                  <TrendingUpIcon size={12} className={tile.changeBps < 0 ? 'rotate-180' : ''} />
                  {signedPercent(tile.changeBps)}
                  <span className="text-muted">{tile.deltaLabel}</span>
                </span>
              ) : (
                <span className="text-[11px] tracking-[-0.023em] text-amberink">{tile.caption}</span>
              )}
            </span>
          </article>
        ))}
      </section>

      {/* User growth. */}
      {can('users') && view.growth ? (
        <Panel>
          <PanelHead
            title={o.growthTitle}
            description={o.growthSubtitle}
            action={
              <span className="text-[12px] tracking-[-0.023em] text-muted">
                {fill(o.range, { days: range })}
              </span>
            }
          />
          <div className="flex flex-col gap-4 p-[19px]">
            <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
              <span className="flex flex-col gap-0.5">
                <span className="text-[19px] leading-[1.3] font-semibold tracking-[-0.03em] text-ink">
                  {(view.users?.inWindow ?? 0).toLocaleString('en-US')}
                </span>
                <span className="text-[11px] tracking-[-0.023em] text-muted">{o.growthNewUsers}</span>
              </span>
              {/* Who paid is billing data; a session without it sees sign-ups alone. */}
              {view.conversionBps !== null ? (
                <span className="flex flex-col gap-0.5">
                  <span className="text-[19px] leading-[1.3] font-semibold tracking-[-0.03em] text-ink">
                    {percentFromBps(view.conversionBps)}%
                  </span>
                  <span className="text-[11px] tracking-[-0.023em] text-muted">{o.growthConversion}</span>
                </span>
              ) : null}
              <ul className="flex items-center gap-3.5">
                {[
                  { label: o.seriesUsers, dot: 'bg-barstrong' },
                  ...(view.growthIncludesPaid ? [{ label: o.seriesPaid, dot: 'bg-bar' }] : []),
                ].map((series) => (
                  <li
                    key={series.label}
                    className="flex items-center gap-1.5 text-[11px] tracking-[-0.023em] text-muted"
                  >
                    <span aria-hidden className={`size-[7px] rounded-full ${series.dot}`} />
                    {series.label}
                  </li>
                ))}
              </ul>
            </div>
            <GrowthChart points={view.growth} showPaid={view.growthIncludesPaid} />
          </div>
        </Panel>
      ) : null}

      {/* Live activity -- reachable only with the audit capability, since it is
          a window onto the same events the audit log records. */}
      {can('audit') && view.activity ? (
        <Panel>
          <PanelHead
            title={o.activityTitle}
            description={o.activitySubtitle}
            action={
              <Link
                href="/admin/audit"
                className="inline-flex items-center gap-1.5 text-[12px] tracking-[-0.023em] text-brandink hover:text-brand"
              >
                {o.activityLink}
                <ArrowUpRightIcon size={13} />
              </Link>
            }
          />
          {view.activity.length === 0 ? (
            <p className="px-[17px] py-5 text-[12px] tracking-[-0.023em] text-muted">{o.activityEmpty}</p>
          ) : (
            <ul className="px-[17px]">
              {view.activity.map((entry, index) => {
                const title = actionLabels[entry.action] ?? entry.action;
                const who = entry.administratorName ?? entry.administratorEmail ?? o.unknownAdmin;
                return (
                  <li
                    key={entry.id}
                    className={`flex items-center gap-2.5 py-3.5 ${
                      index === view.activity!.length - 1 ? '' : 'border-b-2 border-line'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`flex size-[29px] shrink-0 items-center justify-center rounded-[7px] ${ACTIVITY_TONE[activityTone(entry)]}`}
                    >
                      <span className="size-1.5 rounded-full bg-current" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                      <span className="truncate text-[12px] tracking-[-0.023em] text-ink">
                        {entry.result === 'success' ? title : `${title} · ${o.activityFailed}`}
                      </span>
                      <span className="truncate text-[11px] tracking-[-0.023em] text-muted">
                        {entry.targetId ? `${who} · ${entry.targetId}` : who}
                      </span>
                    </span>
                    <span
                      title={entry.createdAt.toISOString()}
                      className="shrink-0 text-[11px] tracking-[-0.023em] whitespace-nowrap text-muted"
                    >
                      {ago(now.getTime() - entry.createdAt.getTime(), o)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      ) : null}

      {/* Platform health. */}
      <Panel>
        <PanelHead
          title={o.healthTitle}
          description={o.healthSubtitle}
          action={
            <span
              className={`inline-flex items-center gap-1.5 text-[12px] font-semibold tracking-[-0.023em] ${
                attention ? 'text-amberink' : 'text-pubink'
              }`}
            >
              <span aria-hidden className={`size-1.5 rounded-full ${attention ? 'bg-amberink' : 'bg-good'}`} />
              {attention ? o.healthAttention : o.healthOk}
            </span>
          }
        />
        <ul className="flex flex-col gap-3.5 px-[17px] py-4">
          {health.map((row) => (
            <li key={row.label} className="flex flex-col gap-2">
              <span className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-semibold tracking-[-0.023em] text-ink">{row.label}</span>
                <span className="text-[11px] tracking-[-0.023em] text-muted">{row.value}</span>
              </span>
              <Meter value={row.percent} />
            </li>
          ))}
        </ul>

        {/* External services -- wired up or not, from the environment and the registry. */}
        <div className="border-t-2 border-line px-[17px] py-4">
          <p className="mb-3 text-[11px] font-bold tracking-[0.02em] text-faint">{o.services.title}</p>
          <ul className="flex flex-col gap-2.5">
            {serviceRows.map((row) => (
              <li key={row.label} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] font-semibold tracking-[-0.023em] text-ink">{row.label}</span>
                <span className="flex items-center gap-2">
                  <span className="text-[11px] tracking-[-0.023em] text-muted">{row.value}</span>
                  <Pill tone={row.tone}>
                    {row.tone === 'ok' ? o.services.on : row.tone === 'warn' ? o.services.off : o.services.absent}
                  </Pill>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Panel>
    </div>
  );
}

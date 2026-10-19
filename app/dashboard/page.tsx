import type { Metadata } from 'next';
import { ApiQuickstart } from '@/components/dashboard/api-quickstart';
import { CopyButton } from '@/components/dashboard/copy-button';
import { UsageChart, type UsageChartDay } from '@/components/dashboard/usage-chart';
import {
  ActionButton,
  ArrowLink,
  PANEL,
  PageHeader,
  PanelHeading,
  StatusLabel,
} from '@/components/dashboard/ui';
import { GlobeIcon, PlusIcon, TerminalIcon } from '@/components/ui/icons';
import { listApiKeys } from '@/lib/application/auth';
import { listWorkspaceWidgetSites } from '@/lib/application/embed';
import { listPublicLibraries, listWorkspaceLibraries } from '@/lib/application/libraries';
import { periodLastDay, workspaceBilling } from '@/lib/application/plans';
import {
  API_KEY_PLACEHOLDER,
  EXAMPLE_LIBRARY_ID,
  installCommand,
  mcpEndpoint,
  quickstartTabs,
} from '@/lib/dashboard/snippets';
import { usdHeadline } from '@/lib/domain/plans';
import { workspaceUsage } from '@/lib/http/dashboard';
import { appBaseUrl, requireSession } from '@/lib/http/session';
import { fill } from '@/lib/i18n/format';
import { getMessages, translations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.overview.title };
}

const CHART_DAYS = 10;

/**
 * The overview, on the ledger: quota and volume from the rebuilt usage
 * summary (architecture.md 11.1), library and key counts from the rows
 * themselves, the plan and this period's cost from the workspace's Plan
 * Version (requirement.md 4.1, 4.3). The install and quickstart panels are
 * built for this deployment and this workspace: the real base URL, the real
 * MCP endpoint and one of the workspace's own libraries.
 */
export default async function DashboardOverviewPage() {
  const [session, { locale, t }] = await Promise.all([
    requireSession('/dashboard'),
    translations(),
  ]);
  const o = t.dashboard.overview;
  const workspaceId = session.workspace.id;

  const [overview, keys, libraries, billing, siteKeys] = await Promise.all([
    workspaceUsage(workspaceId),
    listApiKeys(workspaceId),
    listWorkspaceLibraries(workspaceId),
    workspaceBilling(workspaceId),
    listWorkspaceWidgetSites(workspaceId),
  ]);

  /* requirement.md 9.4: the sites the widget may run on, and which have it live. */
  const sites = siteKeys.flatMap((key) =>
    key.origins.map((origin) => ({ ...origin, library: key.library.title, accent: key.accent })),
  );
  const sitesReached = sites.filter((site) => site.lastSeenAt !== null).length;

  /*
   * The examples query something the reader can actually call: their own
   * first library, or the most popular public one when they have none yet.
   * The catalogue is read only in that case, and a catalogue with nothing
   * published falls back to a well-known id rather than an empty string.
   */
  const own = libraries[0] ?? null;
  const catalogue = own ? null : ((await listPublicLibraries({ sort: 'popular', limit: 1 }))[0] ?? null);
  const example = own
    ? { libraryId: own.publicId, title: own.title }
    : catalogue
      ? { libraryId: catalogue.publicId, title: catalogue.title }
      : { libraryId: EXAMPLE_LIBRARY_ID, title: 'Next.js' };

  const baseUrl = appBaseUrl();
  const install = installCommand(baseUrl);
  const endpoint = mcpEndpoint(baseUrl);
  const tabs = quickstartTabs({
    baseUrl,
    libraryId: example.libraryId,
    title: example.title,
    labels: { search: o.live.tabSearch, context: o.live.tabContext },
  });

  const number = new Intl.NumberFormat(locale);
  const stats: {
    label: string;
    value: string;
    caption?: string;
    quota?: { used: number; limit: number };
  }[] = [
    {
      label: o.stats.calls,
      value: `${number.format(overview.callsThisPeriod)} / ${number.format(overview.planAllowance)}`,
      quota: { used: overview.callsThisPeriod, limit: Math.max(1, overview.planAllowance) },
    },
    {
      label: o.stats.tokens,
      value: number.format(overview.returnedTokensThisPeriod),
      caption: o.stats.tokensCaption,
    },
    {
      label: o.stats.libraries,
      value: number.format(libraries.length),
      caption: o.stats.librariesCaption,
    },
    {
      label: o.stats.addon,
      value: number.format(overview.addonBalanceRemaining),
      caption: o.stats.addonCaption,
    },
    {
      label: o.stats.buildCalls,
      value: number.format(overview.buildCallsThisPeriod),
      caption: o.stats.buildCallsCaption,
    },
  ];

  const byDate = new Map(overview.buckets.map((bucket) => [bucket.date, bucket.calls]));
  const dayFormat = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const days: UsageChartDay[] = Array.from({ length: CHART_DAYS }, (_, index) => {
    const at = new Date(Date.now() - (CHART_DAYS - 1 - index) * 86_400_000);
    return {
      label: dayFormat.format(at),
      calls: byDate.get(at.toISOString().slice(0, 10)) ?? 0,
    };
  });

  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  /* The ledger's periods are UTC days; formatted in the server's timezone
     they slide by one. The settings screen prints the same period. */
  const utcDate = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });

  /*
   * The plan and the cost, side by side. `periodEnd` is exclusive on the
   * ledger, so the printed range ends on the day before it -- "1 – 30 Sep",
   * not "1 Sep – 1 Oct".
   */
  const { plan, cost } = billing;
  const planPrice = plan.priceMinor === 0 ? o.live.planFree : fill(o.live.planPrice, { price: usdHeadline(plan.priceMinor) });
  const costBreakdown =
    cost.packsBought > 0
      ? fill(o.live.costBreakdown, {
          plan: usdHeadline(cost.planMinor),
          packs: cost.packsBought,
          packsPrice: usdHeadline(cost.packsMinor),
        })
      : fill(o.live.costBreakdownNoPacks, { plan: usdHeadline(cost.planMinor) });
  const costPeriod = fill(o.live.costPeriod, {
    start: utcDate.format(plan.periodStart),
    end: utcDate.format(periodLastDay(plan.periodEnd)),
  });

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Page header -- design source `MWSfb`. */}
      <PageHeader
        eyebrow={session.workspace.name}
        title={o.title}
        description={o.description}
        action={
          <ActionButton href="/dashboard/libraries/new">
            <PlusIcon size={15} />
            {o.addLibrary}
          </ActionButton>
        }
      />

      {/*
        * Metric strip -- design source `J5PPjZ`. One column per tile: the
        * grid was four wide while `stats` built five, so the fifth dropped to
        * a row of its own and took the "every cell but the first" divider
        * with it, drawing a rule against nothing. The column count and the
        * length of `stats` are the same number and have to stay so.
        */}
      <section className={`${PANEL} grid grid-cols-2 gap-y-5 p-5 md:grid-cols-5 md:gap-y-0`}>
        {stats.map((stat, index) => (
          <article
            key={stat.label}
            /* One divider between columns: every odd cell when wrapped to two, every cell but the first on wide. */
            className={`flex flex-col pr-[18px] ${
              index % 2 === 1 ? 'border-l border-line pl-5' : 'pl-1'
            } ${index === 0 ? 'md:border-l-0 md:pl-1' : 'md:border-l md:border-line md:pl-5'}`}
          >
            <p className="text-[11px] tracking-[0.03em] text-muted">{stat.label}</p>
            <p className="mt-1.5 text-[20px] leading-[1.5] font-medium text-ink">
              {stat.value}
            </p>
            {stat.quota ? (
              <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-mutedbg">
                <div
                  className="h-full bg-brand"
                  style={{ width: `${Math.min(100, (stat.quota.used / stat.quota.limit) * 100)}%` }}
                />
              </div>
            ) : (
              <p className="mt-1 text-[12px] text-muted">{stat.caption}</p>
            )}
          </article>
        ))}
      </section>

      {/* Plan and cost -- requirement.md 5.2 概览: 当前套餐, 当前费用. */}
      <section className="grid gap-[18px] lg:grid-cols-2">
        <article className={`${PANEL} flex flex-col gap-2 p-[30px]`}>
          <p className="text-[11px] tracking-[0.03em] text-muted">{o.live.planTitle}</p>
          <p className="flex items-baseline gap-2">
            <span className="text-[22px] leading-[1.4] font-medium text-ink">
              {plan.planName}
            </span>
            <span className="text-[13px] text-muted">{planPrice}</span>
          </p>
          <p className="text-[12px] text-steel">
            {fill(o.live.planAllowance, { calls: number.format(plan.monthlyCalls) })}
          </p>
          <div className="mt-auto pt-2">
            <ArrowLink href="/pricing">{o.live.planManage}</ArrowLink>
          </div>
        </article>

        <article className={`${PANEL} flex flex-col gap-2 p-[30px]`}>
          <p className="text-[11px] tracking-[0.03em] text-muted">{o.live.costTitle}</p>
          <p className="flex items-baseline gap-2">
            <span className="text-[22px] leading-[1.4] font-medium text-ink">
              {usdHeadline(cost.totalMinor)}
            </span>
            <span className="text-[13px] text-muted">{costPeriod}</span>
          </p>
          <p className="text-[12px] text-steel">{costBreakdown}</p>
          {/* Said plainly: without a provider this is arithmetic, not an invoice. */}
          {billing.paymentConnected ? null : (
            <p className="text-[12px] text-amber">{o.live.costUnbilled}</p>
          )}
          <div className="mt-auto pt-2">
            <ArrowLink href="/dashboard/settings#billing">{o.live.costLink}</ArrowLink>
          </div>
        </article>
      </section>

      {/* Call volume -- design source `C06o6`. */}
      <section className={`${PANEL} flex flex-col gap-3.5 p-[30px]`}>
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex flex-col gap-[5px]">
            <h2 className="text-[16px] leading-[1.5] text-ink">
              {o.usageTitle}
            </h2>
            <p className="text-[13px] leading-[1.5] text-muted">
              {o.usageSubtitle}
            </p>
          </div>
          <span className="inline-flex h-[29px] items-center rounded-md border border-publine px-[11px]">
            <ArrowLink href="/pricing">{o.usageUpgrade}</ArrowLink>
          </span>
        </div>
        <UsageChart days={days} />
      </section>

      {/* API keys -- design source `DQVXY`. */}
      <section className={`${PANEL} flex flex-col gap-[22px] p-[30px]`}>
        <PanelHeading
          title={o.keysTitle}
          description={o.keysDescription}
          action={
            <ActionButton href="/dashboard/api-keys">
              <PlusIcon size={14} />
              {o.createKey}
            </ActionButton>
          }
        />

        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                {o.keyColumns.map((head, index) => (
                  <th
                    key={head}
                    scope="col"
                    className={`pb-[9px] text-[11px] font-normal text-muted ${
                      index === 0 ? 'w-[29%]' : index === 3 ? 'w-[19%]' : 'w-[26%]'
                    }`}
                  >
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className="border-b border-line">
                  <td className="py-3.5 text-[12px] font-medium text-steel">
                    {key.name}
                  </td>
                  <td className="py-3.5">
                    <code className="inline-flex items-center rounded-md bg-mutedbg px-1.5 py-1 font-mono text-[11px] text-steel">
                      {key.masked}
                    </code>
                  </td>
                  <td className="py-3.5 text-[12px] text-steel">
                    {date.format(new Date(key.createdAt))}
                  </td>
                  <td className="py-3.5 text-[12px] text-steel">
                    {key.lastUsedAt ? dateTime.format(new Date(key.lastUsedAt)) : '—'}
                  </td>
                </tr>
              ))}
              {keys.length === 0 ? (
                <tr>
                  <td
                    colSpan={o.keyColumns.length}
                    className="py-6 text-center text-[12px] text-muted"
                  >
                    {o.keysEmpty}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* Website widget -- requirement.md 9.4. Where the snippet lives, and where it is live. */}
      <section className={`${PANEL} flex flex-col gap-[18px] p-[30px]`}>
        <PanelHeading
          title={o.widgetTitle}
          description={o.widgetDescription}
          action={
            <ActionButton href="/dashboard/widget" variant="outline">
              <GlobeIcon size={14} />
              {o.widgetLink}
            </ActionButton>
          }
        />
        {sites.length === 0 ? (
          <p className="text-[12px] text-muted">{o.widgetNone}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-steel">
              {fill(o.widgetSites, { reached: number.format(sitesReached), total: number.format(sites.length) })}
              <span className="text-muted"> · {fill(o.widgetKeys, { keys: number.format(siteKeys.length) })}</span>
            </p>
            <ul className="flex flex-col">
              {sites.slice(0, 5).map((site) => (
                <li
                  key={`${site.library}\n${site.origin}`}
                  className="flex items-center gap-4 border-t border-line py-2.5"
                >
                  <span
                    aria-hidden
                    className="size-[7px] shrink-0 rounded-full border border-line"
                    style={{ background: site.accent }}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <code className="truncate font-mono text-[12px] text-ink">{site.origin}</code>
                    <span className="truncate text-[10px] text-muted">{site.library}</span>
                  </span>
                  <StatusLabel tone={site.lastSeenAt ? 'live' : 'pending'}>
                    {site.lastSeenAt ? o.widgetReached : o.widgetWaiting}
                  </StatusLabel>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Install -- design source `QabFh`. The CLI command, then the endpoint it writes. */}
      <section className={`${PANEL} flex flex-col gap-[13px] p-[30px]`}>
        <PanelHeading
          title={o.installTitle}
          description={o.installDescription}
        />
        <div className="flex h-[52px] items-center gap-2.5 rounded-lg bg-terminal px-3.5">
          <TerminalIcon size={16} className="text-brandink" />
          <code className="flex-1 truncate font-mono text-[13px] text-white">
            {install}
          </code>
          <CopyButton
            value={install}
            label={o.installCommandLabel}
            className="text-faint hover:bg-white/10"
          />
        </div>
        <div className="flex h-[44px] items-center gap-2.5 rounded-lg bg-subtle px-3.5">
          <span className="shrink-0 text-[11px] text-muted">
            {o.live.mcpEndpointLabel}
          </span>
          <code className="flex-1 truncate font-mono text-[12px] text-steel">
            {endpoint}
          </code>
          <CopyButton
            value={endpoint}
            label={o.live.mcpEndpointLabel}
            className="text-muted hover:bg-mutedbg"
          />
        </div>
        <p className="text-[12px] text-muted">
          {fill(o.live.keyPlaceholderNote, { placeholder: API_KEY_PLACEHOLDER })}
        </p>
      </section>

      {/* REST quickstart -- design source `lRoBh`. */}
      <section className={`${PANEL} flex flex-col p-[30px]`}>
        <PanelHeading
          title={o.quickstartTitle}
          description={`${o.quickstartDescription} ${fill(
            own ? o.live.exampleLibraryOwn : o.live.exampleLibraryCatalog,
            { libraryId: example.libraryId },
          )}`}
        />
        <ApiQuickstart tabs={tabs} />
      </section>
    </div>
  );
}

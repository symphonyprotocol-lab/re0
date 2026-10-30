import type { Metadata } from 'next';
import {
  ArrowLink,
  Badge,
  IconTile,
  Meter,
  Notice,
  PANEL,
  PageHeader,
  StatusLabel,
  type StatusTone,
} from '@/components/dashboard/ui';
import {
  ArrowRightIcon,
  BadgeCheckIcon,
  CircleCheckIcon,
  CircleDollarSignIcon,
  ClockIcon,
  DownloadIcon,
  GitHubIcon,
  KeyIcon,
  LinkIcon,
  MailIcon,
  NotionIcon,
  ReceiptIcon,
  ShieldCheckIcon,
} from '@/components/ui/icons';
import Link from 'next/link';
import { CheckoutSync, RefreshOnReturn } from '@/components/dashboard/checkout-sync';
import { PendingSubmitButton } from '@/components/ui/pending-submit-button';
import {
  changeHandleAction,
  disconnectGithubAction,
  disconnectNotionAction,
  openBillingPortalAction,
  startCheckoutAction,
} from './actions';
import { accountProfile, githubConnectionFor, notionConnectionFor } from '@/lib/application/auth';
import {
  BILLING_ROLES,
  hasInvoice,
  isCheckoutRefusal,
  isInvoiceRefusal,
  listBillingDocuments,
  workspaceProviderCustomer,
} from '@/lib/application/billing';
import { countWorkspaceLibraries } from '@/lib/application/libraries';
import { isPaymentConnected, periodLastDay, workspacePlanVersion, workspaceStorage } from '@/lib/application/plans';
import type { BillingDocumentStatus } from '@/lib/domain/billing';
import { BYTES_PER_MB, storageCapacityBytes, usdHeadline } from '@/lib/domain/plans';
import { formatCapacity } from '@/lib/domain/pricing-page';
import { workspaceInitial } from '@/lib/domain/auth';
import { workspaceUsage } from '@/lib/http/dashboard';
import { isGithubConnectOutcome } from '@/lib/domain/github';
import { isNotionConnectOutcome } from '@/lib/domain/notion';
import { currentLocale, getMessages } from '@/lib/i18n/server';
import { fill } from '@/lib/i18n/format';
import { isNotionOAuthConfigured } from '@/lib/infrastructure/identity/notion';
import { requireSession } from '@/lib/http/session';
import { workspaceHandle } from '@/lib/application/workspaces/handle';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getMessages()).dashboard.settings.metaTitle };
}

/** The most recent documents the card lists; the provider's console has the rest. */
const BILLING_ROWS = 12;

/** The plan card's two button weights, shared by its links and its forms. */
const PLAN_PRIMARY =
  'flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-brand text-[12px] font-medium text-white transition-colors hover:bg-brand/90';
const PLAN_SECONDARY =
  'flex h-10 w-full items-center justify-center rounded-lg border border-line text-[12px] text-steel transition-colors hover:bg-subtle';

/**
 * The dot beside a document's status. Money in is live, money owed is
 * pending, money that failed to arrive is blocked, and a document that no
 * longer asks for anything -- refunded, voided -- is exempt.
 */
const BILLING_STATUS_TONE: Record<BillingDocumentStatus, StatusTone> = {
  draft: 'pending',
  open: 'pending',
  paid: 'live',
  failed: 'blocked',
  uncollectible: 'blocked',
  refunded: 'exempt',
  void: 'exempt',
};

/** Card header: icon tile, title and sub-line, with an optional trailing slot. */
function CardHead({
  icon,
  title,
  description,
  aside,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
      <IconTile>{icon}</IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <p className="text-[14px] leading-[1.5] text-ink">{title}</p>
        <p className="truncate text-[11px] text-muted">{description}</p>
      </div>
      {aside}
    </div>
  );
}

/**
 * One provider row of the connections card. Connecting posts to the same
 * route the wizard uses, landing back here with `?github=` or `?notion=`;
 * disconnecting is a server action that forgets the sealed token.
 */
function ConnectionRow({
  provider,
  icon,
  name,
  note,
  connectedAs,
  connectedAt,
  unavailable,
  disconnect,
  labels,
  locale,
}: {
  provider: 'github' | 'notion';
  icon: React.ReactNode;
  name: string;
  note: string;
  connectedAs: string | null;
  connectedAt: Date | null;
  unavailable: boolean;
  disconnect: () => Promise<void>;
  labels: {
    connectedAs: string;
    connectedAt: string;
    notConnected: string;
    unavailable: string;
    connect: string;
    reconnect: string;
    disconnect: string;
  };
  locale: string;
}) {
  const connected = connectedAt !== null;
  const status = unavailable
    ? labels.unavailable
    : connected
      ? [
          connectedAs ? fill(labels.connectedAs, { name: connectedAs }) : null,
          fill(labels.connectedAt, { date: connectedAt.toLocaleDateString(locale) }),
        ]
          .filter(Boolean)
          .join(' · ')
      : labels.notConnected;
  return (
    <li className="flex flex-wrap items-center gap-3 px-5 py-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-ink text-white">
        {icon}
      </span>
      <span className="flex min-w-[200px] flex-1 flex-col gap-[3px]">
        <span className="flex items-center gap-2 text-[13px] text-ink">
          {name}
          <Badge tone={connected ? 'brand' : 'neutral'}>{status}</Badge>
        </span>
        <span className="text-[11px] text-muted">{note}</span>
      </span>
      <span className="flex items-center gap-2">
        {/* POST, same-origin, behind the session: the connect route refuses anything else. */}
        {unavailable ? null : (
          <form method="post" action={`/api/auth/${provider}/connect`}>
            <input type="hidden" name="returnTo" value="/dashboard/settings" />
            <button
              type="submit"
              className="h-8 rounded-md bg-brand px-3 text-[11px] font-medium text-white transition-colors hover:bg-brand/90"
            >
              {connected ? labels.reconnect : labels.connect}
            </button>
          </form>
        )}
        {connected ? (
          <form action={disconnect}>
            <button
              type="submit"
              className="h-8 rounded-md border border-line bg-card px-3 text-[11px] text-steel transition-colors hover:bg-subtle"
            >
              {labels.disconnect}
            </button>
          </form>
        ) : null}
      </span>
    </li>
  );
}

export default async function DashboardSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{
    github?: string;
    notion?: string;
    checkout?: string;
    invoice?: string;
  }>;
}) {
  const session = await requireSession('/dashboard/settings');
  const workspaceId = session.workspace.id;
  const [
    t,
    locale,
    params,
    github,
    notion,
    profile,
    planVersion,
    overview,
    libraryCount,
    storage,
    billing,
    providerCustomer,
    handle,
  ] = await Promise.all([
    getMessages(),
    currentLocale(),
    searchParams,
    githubConnectionFor(session.user.id),
    notionConnectionFor(session.user.id),
    accountProfile(session.user.id),
    workspacePlanVersion(workspaceId),
    workspaceUsage(workspaceId),
    countWorkspaceLibraries(workspaceId),
    workspaceStorage(workspaceId),
    listBillingDocuments({ workspaceId, limit: BILLING_ROWS }),
    workspaceProviderCustomer(workspaceId),
    workspaceHandle(workspaceId),
  ]);
  const handleNotice = typeof (params as Record<string, unknown>).handle === 'string' ? String((params as Record<string, unknown>).handle) : null;
  const g = t.dashboard.settings;
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  /* The session already proved the user row exists; the profile read only
     adds the join date and linked providers on top of it. */
  const account = {
    name: profile?.displayName ?? session.user.displayName,
    initials: workspaceInitial(profile?.displayName ?? session.user.displayName),
    email: profile?.email ?? session.user.email,
    provider:
      (profile?.providers ?? [])
        .map((id) => g.providerNames[id as keyof typeof g.providerNames] ?? id)
        .join(' · ') || '—',
    joined: profile ? date.format(profile.createdAt) : '—',
  };

  const planNotes: Record<string, string> = g.planNotes;
  const capacity = formatCapacity(storage.capacityBytes, number);
  const plan = {
    /* The name comes from the same read as the price, the allowance and the
       limits below it, so the card cannot print one tier's name over
       another's figures. */
    name: planVersion.planName,
    price: usdHeadline(planVersion.priceMinor),
    period: g.planPeriodMonth,
    note: planNotes[planVersion.planId] ?? '',
    /*
     * agent-first-proposal.md 8.1: storage is the owner's tier, not the plan
     * version's. The base tier says what raises it; the extended one, that it
     * has been raised and stays so.
     */
    storageNote:
      storage.tier === 'extended'
        ? fill(g.storageTier.extended, { capacity })
        : fill(g.storageTier.base, { extended: formatCapacity(storageCapacityBytes('extended'), number) }),
    perks: [
      fill(g.planPerks.calls, { count: number.format(planVersion.monthlyCalls) }),
      g.planPerks.libraries,
      fill(g.planPerks.storage, { capacity }),
      fill(g.planPerks.apiKeys, { count: number.format(planVersion.apiKeyLimit) }),
    ],
  };

  /*
   * The window is half-open and stored in UTC; the last day inside it is what
   * a person calls the end. `periodLastDay` is that subtraction and the UTC
   * formatter keeps the server's timezone out of it -- the overview screen
   * prints the same period from the same two, and used to print a different
   * day for it.
   */
  const utcDate = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const billingPeriod = fill(g.billingPeriod, {
    start: utcDate.format(new Date(overview.periodStart)),
    end: utcDate.format(periodLastDay(new Date(overview.periodEnd))),
  });

  const percent = (used: number, limit: number) =>
    limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const usedMb = storage.usedBytes / BYTES_PER_MB;
  const usageMeters = [
    /* The whole workspace against its tier's capacity; the library count is a footnote, not a ceiling. */
    {
      ...g.meters.storage,
      value: fill(g.meters.storage.value, {
        used: `${usedMb < 10 ? usedMb.toFixed(1) : number.format(Math.round(usedMb))} MB`,
        limit: capacity,
      }),
      percent: percent(storage.usedBytes, storage.capacityBytes),
      note: fill(g.meters.storage.note, { count: number.format(libraryCount) }),
    },
    {
      ...g.meters.calls,
      value: fill(g.meters.calls.value, {
        used: number.format(overview.planCallsThisPeriod),
        limit: number.format(overview.planAllowance),
      }),
      percent: percent(overview.planCallsThisPeriod, overview.planAllowance),
      /* Calls past the allowance were paid by packs; said under the meter rather than overflowing it. */
      note:
        overview.addonCallsThisPeriod > 0
          ? fill(g.meters.calls.fromPacks, { n: number.format(overview.addonCallsThisPeriod) })
          : null,
    },
    /* The packs' balance, from the first one bought; it has no period, so it is not "this period's". */
    ...(overview.addonGranted > 0
      ? [
          {
            ...g.meters.packs,
            value: fill(g.meters.packs.value, {
              remaining: number.format(overview.addonBalanceRemaining),
              granted: number.format(overview.addonGranted),
            }),
            percent: percent(overview.addonBalanceRemaining, overview.addonGranted),
            note: g.meters.packs.note,
          },
        ]
      : []),
  ];

  const outcome = isGithubConnectOutcome(params.github)
    ? { provider: g.connectionGithub, code: params.github }
    : isNotionConnectOutcome(params.notion)
      ? { provider: g.connectionNotion, code: params.notion }
      : null;
  const connectionLabels = {
    connectedAs: g.connectionConnectedAs,
    connectedAt: g.connectionConnectedAt,
    notConnected: g.connectionNotConnected,
    unavailable: g.connectionUnavailable,
    connect: g.connectionConnect,
    reconnect: g.connectionReconnect,
    disconnect: g.connectionDisconnect,
  };

  /*
   * Amounts print in the document's own currency: the mirror keeps whatever
   * the provider settled in (requirement.md 4.3), and relabelling a franc as
   * a dollar would be a lie about a receipt. USD, the price list's own
   * currency, prints as a bare `$` like everywhere else on the site (zh would
   * otherwise say `US$`); any other keeps the locale's disambiguated symbol,
   * since a narrow `$` would pass a Canadian dollar off as a US one.
   */
  const money = (minor: number, currency: string) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: currency === 'USD' ? 'narrowSymbol' : 'symbol',
    }).format(minor / 100);
  const issued = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const paymentConnected = isPaymentConnected();

  /*
   * What the last billing action came back with. `success` is Paddle's
   * success URL, which says only that the checkout closed paid -- the plan
   * itself changes when the webhook lands, a moment later, which the message
   * says rather than pretending the card above is already up to date.
   */
  const checkoutOutcome =
    params.checkout === 'success' || params.checkout === 'failed' || isCheckoutRefusal(params.checkout)
      ? params.checkout
      : null;
  /* Where an invoice download that could not be served sent the browser back. */
  const invoiceOutcome =
    params.invoice === 'failed' || isInvoiceRefusal(params.invoice) ? params.invoice : null;
  /* The invoice carries the billing address, so it follows the billing roles. */
  const canDownloadInvoices = paymentConnected && BILLING_ROLES.has(session.workspace.role);

  const profileRows = [
    { label: g.email, value: account.email, Icon: MailIcon },
    { label: g.provider, value: account.provider, Icon: KeyIcon },
    { label: g.joined, value: account.joined, Icon: ClockIcon },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Back from a checkout in another tab, or after a slow webhook: the plan and billing cards catch up on return. */}
      <RefreshOnReturn />
      <PageHeader
        eyebrow={g.eyebrow}
        title={g.title}
        description={g.description}
      />

      <section className="grid gap-4 lg:grid-cols-2">
        {/* Profile -- design source frame `mwiI4`. */}
        <article className={`${PANEL} flex flex-col overflow-hidden p-0.5`}>
          <CardHead
            icon={<BadgeCheckIcon size={17} />}
            title={g.profileTitle}
            description={g.profileDescription}
          />

          <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
            <span
              aria-hidden
              className="flex size-[46px] shrink-0 items-center justify-center rounded-xl bg-ink text-[15px] font-medium text-white"
            >
              {account.initials}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <span className="text-[14px] text-ink">{account.name}</span>
              <span className="text-[11px] text-muted">{g.accountKind}</span>
            </span>
            <span className="text-[11px] text-brandink">{g.emailVerified}</span>
          </div>

          <dl className="flex-1 px-5">
            {profileRows.map((row, index) => (
              <div
                key={row.label}
                className={`flex items-center justify-between gap-3 py-3.5 ${
                  index < profileRows.length - 1 ? 'border-b border-line' : ''
                }`}
              >
                <dt className="flex items-center gap-[7px] text-[11px] text-muted">
                  <row.Icon size={14} />
                  {row.label}
                </dt>
                <dd className="truncate text-[11px] font-medium text-steel">
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>

          {/* The workspace's public name: `/u/{handle}` and the user Agent Card (agent-first-proposal.md 12). */}
          <form id="handle" action={changeHandleAction} className="flex flex-col gap-2 border-t border-line px-5 py-4">
            <span className="text-[11px] font-medium text-steel">{g.handle.label}</span>
            <span className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center rounded-md border border-line bg-field pl-3">
                <span className="text-[12px] text-muted">/u/</span>
                <input
                  name="handle"
                  defaultValue={handle ?? ''}
                  required
                  minLength={3}
                  maxLength={32}
                  disabled={session.workspace.role !== 'owner'}
                  className="h-9 min-w-0 flex-1 bg-transparent pr-3 text-[12.5px] text-ink focus:outline-none"
                />
              </span>
              <button
                type="submit"
                disabled={session.workspace.role !== 'owner'}
                className="inline-flex h-9 items-center rounded-md border border-line bg-card px-3 text-[12px] font-medium text-ink hover:bg-subtle disabled:opacity-50"
              >
                {g.handle.save}
              </button>
            </span>
            <span className={`text-[10.5px] leading-[1.5] ${handleNotice && handleNotice !== 'saved' ? 'text-rose' : 'text-muted'}`}>
              {handleNotice ? ((g.handle.notices as Record<string, string>)[handleNotice] ?? g.handle.notices.unavailable) : g.handle.hint}
            </span>
          </form>

          <footer className="flex items-center gap-2 border-t border-line px-5 py-3.5">
            <ShieldCheckIcon size={14} className="text-muted" />
            <p className="text-[11px] text-muted">{g.providerManaged}</p>
          </footer>
        </article>

        {/* Subscription -- design source frame `mwiI4`. */}
        <article id="plan" className={`${PANEL} flex flex-col overflow-hidden p-0.5`}>
          <CardHead
            icon={<CircleDollarSignIcon size={17} />}
            title={g.planTitle}
            description={g.planDescription}
            aside={<Badge tone="brand">{plan.name}</Badge>}
          />

          <div className="flex flex-col gap-1.5 border-b border-line px-5 py-4">
            <p className="flex items-baseline gap-1">
              <span className="text-[26px] leading-[1.2] font-medium text-ink">
                {plan.price}
              </span>
              <span className="text-[13px] text-muted">{plan.period}</span>
            </p>
            <p className="text-[11px] text-muted">{plan.note}</p>
            <p className="text-[11px] text-steel">{plan.storageNote}</p>
            {/* A cancellation leaves the plan active to the period's end; this is the only place it shows. */}
            {planVersion.renewal ? (
              <p
                className={`text-[11px] ${
                  planVersion.renewal.kind === 'cancels' ? 'text-amberink' : 'text-steel'
                }`}
              >
                {fill(planVersion.renewal.kind === 'cancels' ? g.planCancels : g.planRenews, {
                  date: utcDate.format(planVersion.renewal.at),
                })}
              </p>
            ) : null}
          </div>

          <ul className="flex flex-1 flex-col gap-3 px-5 py-4">
            {plan.perks.map((perk) => (
              <li
                key={perk}
                className="flex items-center gap-2 text-[12px] text-steel"
              >
                <CircleCheckIcon size={14} className="text-brandink" />
                {perk}
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-2 px-5 pb-5">
            {checkoutOutcome ? (
              <p
                role="status"
                className={`text-[11px] leading-[1.6] ${
                  checkoutOutcome === 'success' ? 'text-brandink' : 'text-err'
                }`}
              >
                {g.checkout.outcomes[checkoutOutcome]}
                {checkoutOutcome === 'success' ? (
                  <CheckoutSync
                    fingerprint={JSON.stringify([
                      planVersion.planVersionId,
                      planVersion.subscribed,
                      overview.planAllowance,
                      overview.addonBalanceRemaining,
                      overview.addonGranted,
                      billing.rows[0]?.id ?? null,
                      billing.rows[0]?.status ?? null,
                    ])}
                  />
                ) : null}
              </p>
            ) : null}
            {!paymentConnected ? (
              <Link href="/pricing" className={PLAN_PRIMARY}>
                {g.pricingCta}
                <ArrowRightIcon size={14} />
              </Link>
            ) : (
              <>
                {/* Anyone may buy a pack (agent-first-proposal.md 8.1); it is the one thing to buy. */}
                <form action={startCheckoutAction}>
                  <PendingSubmitButton className={PLAN_PRIMARY}>{g.checkout.buyPack}</PendingSubmitButton>
                </form>
                {/* A workspace that has paid before has a portal: its invoices and its card are there. */}
                {providerCustomer ? (
                  <form action={openBillingPortalAction}>
                    <PendingSubmitButton className={PLAN_SECONDARY} arrow={false}>
                      {g.checkout.manage}
                    </PendingSubmitButton>
                  </form>
                ) : (
                  <Link href="/pricing" className={PLAN_SECONDARY}>
                    {g.checkout.comparePlans}
                  </Link>
                )}
              </>
            )}
          </div>
        </article>
      </section>

      {/* Connected accounts: the grants the wizard imports with. */}
      <section className={`${PANEL} overflow-hidden p-0.5`}>
        <CardHead
          icon={<LinkIcon size={17} />}
          title={g.connectionsTitle}
          description={g.connectionsDescription}
        />
        {outcome ? (
          <p
            className={`border-b border-line px-5 py-3 text-[11px] ${
              outcome.code === 'connected' ? 'text-brandink' : 'text-rose'
            }`}
          >
            {fill(g.connectionOutcome[outcome.code], { provider: outcome.provider })}
          </p>
        ) : null}
        <ul className="divide-y-2 divide-line">
          <ConnectionRow
            provider="github"
            icon={<GitHubIcon size={17} className="text-white" />}
            name={g.connectionGithub}
            note={g.connectionGithubNote}
            connectedAs={github ? `@${github.login}` : null}
            connectedAt={github?.connectedAt ?? null}
            unavailable={false}
            disconnect={disconnectGithubAction}
            labels={connectionLabels}
            locale={locale}
          />
          <ConnectionRow
            provider="notion"
            icon={<NotionIcon size={17} className="text-white" />}
            name={g.connectionNotion}
            note={g.connectionNotionNote}
            connectedAs={notion ? (notion.workspaceName ?? notion.ownerName) : null}
            connectedAt={notion?.connectedAt ?? null}
            unavailable={!isNotionOAuthConfigured()}
            disconnect={disconnectNotionAction}
            labels={connectionLabels}
            locale={locale}
          />
        </ul>
        <footer className="flex items-center gap-2 border-t border-line px-5 py-3.5">
          <ShieldCheckIcon size={14} className="shrink-0 text-muted" />
          <p className="text-[11px] text-muted">{g.connectionFootnote}</p>
        </footer>
      </section>

      {/* Current usage -- design source frame `mwiI4`. */}
      <section className={`${PANEL} overflow-hidden p-0.5`}>
        <CardHead
          icon={<ClockIcon size={17} />}
          title={g.usageTitle}
          description={billingPeriod}
          aside={<ArrowLink href="/dashboard/requests">{g.usageLink}</ArrowLink>}
        />
        <div className={`grid gap-6 px-5 py-5 sm:grid-cols-2 ${usageMeters.length > 3 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
          {usageMeters.map((meter) => (
            <div key={meter.label} className="flex flex-col gap-1">
              <p className="text-[12px] text-steel">{meter.value}</p>
              <p className="text-[11px] text-muted">{meter.label}</p>
              <Meter value={meter.percent} className="mt-2" />
              {'note' in meter && meter.note ? <p className="mt-1 text-[10.5px] leading-[1.5] text-muted">{meter.note}</p> : null}
            </div>
          ))}
        </div>
      </section>

      {/*
        Billing -- requirement.md 5.2 设置. A read-only mirror of the Payment
        Provider's documents for this workspace, the same rows the console
        shows platform-wide; until a provider is connected there are none.
      */}
      <section id="billing" className={`${PANEL} overflow-hidden p-0.5`}>
        <CardHead
          icon={<ReceiptIcon size={17} />}
          title={g.billing.title}
          description={g.billing.description}
        />
        {invoiceOutcome ? (
          <p role="status" className="border-b border-line px-5 py-3 text-[11px] text-err">
            {g.billing.invoiceOutcomes[invoiceOutcome]}
          </p>
        ) : null}
        {billing.rows.length === 0 ? (
          <p className="px-5 py-6 text-center text-[12px] text-muted">
            {g.billing.empty}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-left">
              <thead>
                <tr className="border-b border-line">
                  {g.billing.columns.map((head) => (
                    <th
                      key={head}
                      scope="col"
                      className="px-5 py-3 text-[11px] font-normal text-muted"
                    >
                      {head}
                    </th>
                  ))}
                  {canDownloadInvoices ? (
                    <th scope="col" className="px-5 py-3">
                      <span className="sr-only">{g.billing.invoiceColumn}</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {billing.rows.map((row, index) => (
                  <tr
                    key={row.id}
                    className={index < billing.rows.length - 1 ? 'border-b border-line' : ''}
                  >
                    <td className="px-5 py-3.5 text-[12px] font-medium text-steel">
                      {row.number}
                    </td>
                    <td className="px-5 py-3.5 text-[12px] text-steel">
                      {g.billing.kinds[row.kind]}
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusLabel tone={BILLING_STATUS_TONE[row.status]}>
                        {g.billing.statuses[row.status]}
                      </StatusLabel>
                    </td>
                    <td className="px-5 py-3.5 text-[12px] text-steel">
                      {money(row.amountMinor, row.currency)}
                      {row.refundedMinor > 0 ? (
                        <span className="block text-[11px] text-muted">
                          {fill(g.billing.refunded, {
                            amount: money(row.refundedMinor, row.currency),
                          })}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-5 py-3.5 text-[12px] text-steel">
                      {issued.format(row.issuedAt)}
                    </td>
                    {canDownloadInvoices ? (
                      <td className="px-5 py-3.5 text-right">
                        {hasInvoice(row) ? (
                          /*
                           * A plain anchor, not <Link>: the route answers with
                           * a redirect to the provider's file, which the
                           * client router must not try to render.
                           */
                          <a
                            href={`/dashboard/settings/invoices/${row.id}`}
                            aria-label={fill(g.billing.downloadLabel, { number: row.number })}
                            className="inline-flex items-center gap-1.5 text-[12px] font-medium whitespace-nowrap text-brandink hover:underline"
                          >
                            <DownloadIcon size={14} />
                            {g.billing.download}
                          </a>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {paymentConnected ? null : (
          <footer className="flex items-center gap-2 border-t border-line px-5 py-3.5">
            <ShieldCheckIcon size={14} className="shrink-0 text-muted" />
            <p className="text-[11px] text-muted">{g.billing.unbilled}</p>
          </footer>
        )}
      </section>

      <Notice
        tone="brand"
        icon={<CircleDollarSignIcon size={17} />}
        title={g.billingNoticeTitle}
        body={g.billingNoticeBody}
        action={
          <span className="flex flex-wrap items-center gap-4">
            <ArrowLink href="#billing">{g.billing.noticeLink}</ArrowLink>
            <ArrowLink href="/contact">{g.billingNoticeLink}</ArrowLink>
          </span>
        }
      />
    </div>
  );
}

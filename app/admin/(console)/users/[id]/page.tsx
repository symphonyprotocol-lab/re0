import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { param } from '@/lib/domain/list';
import { adminUser, userEntries, userPurchases, userRees, userRoles, type AdminUserDetail } from '@/lib/services/admin-users';
import type { Messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import { serverMessages } from '@/i18n/server';
import { fill, formatDate, formatDateTime, formatNumber, formatUsd } from '@/i18n/format';
import { Fields, LinkPager, PageHead, RecordsTable, RoleBadge, Tag } from '@/components/admin/list-kit';
import { AdjustCreditsButton, UserStatusButton } from '@/components/admin/user-detail-actions';
import { RoleHistory, RolePanel } from '@/components/admin/user-detail-roles';
import { RequirementChecks } from '@/components/ui/requirement-checks';
import { Icon, type IconName } from '@/components/ui/icons';
import { ReeAvatar, UserAvatar } from '@/components/ui/ree-avatar';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABS = ['summary', 'roles', 'credits', 'kyc', 'purchases', 'payouts', 'rees'] as const;
type Tab = (typeof TABS)[number];
const LEDGER_SIZE = 20;

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { t } = await serverMessages();
  const { id } = await params;
  const user = UUID.test(id) ? await adminUser(id) : null;
  return { title: user ? `${user.name} · ${t.consoleUsers.detail.title}` : t.consoleUsers.detail.title };
}

/** Only a console list may be the way back: anything else falls back to the users list. */
function backTo(raw: string): string {
  return /^\/admin\/(users|verifications)(?:[/?]|$)/.test(raw) ? raw : '/admin/users';
}

/**
 * `/admin/users/[id]` (prototype suite.js `userDetail`, role-pages.js
 * `adminUser`): the header, balances, account actions, and seven tabs as
 * links so reload and back keep the place.
 */
export default async function UserDetailPage({ params, searchParams }: Props) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const query = await searchParams;
  const { t, locale } = await serverMessages();
  const user = await adminUser(id);
  if (!user) notFound();
  const d = t.consoleUsers.detail;
  const tabParam = param(query, 'tab');
  const tab: Tab = (TABS as readonly string[]).includes(tabParam) ? (tabParam as Tab) : 'summary';
  const from = backTo(param(query, 'from'));
  const pageParam = Number(param(query, 'page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  const href = (target: Tab, extra: Record<string, string | number> = {}) => {
    const search = new URLSearchParams();
    if (target !== 'summary') search.set('tab', target);
    for (const [key, value] of Object.entries(extra)) search.set(key, String(value));
    if (from !== '/admin/users') search.set('from', from);
    const text = search.toString();
    return text ? `/admin/users/${id}?${text}` : `/admin/users/${id}`;
  };
  const self = href(tab, tab === 'credits' && page > 1 ? { page } : {});
  const back = encodeURIComponent(self);
  const n = (value: number) => formatNumber(value, locale);
  const official = user.role === 'official';
  const fromVerifications = from.startsWith('/admin/verifications');

  let body: ReactNode;
  if (tab === 'summary') {
    const [rees, purchases] = await Promise.all([userRees(id), userPurchases(id)]);
    body = <Summary t={t} locale={locale} user={user} reesCount={rees.length} purchasesCount={purchases.purchases.length} />;
  } else if (tab === 'roles') {
    const roles = await userRoles(id);
    body = (
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <RolePanel t={t} locale={locale} user={user} />
          <section className="card min-w-0 p-5">
            <h2 className="text-[15px] font-bold">{d.roles.checks}</h2>
            <p className="mt-1 text-[12px] text-muted">{d.roles.checksHint}</p>
            <div className="mt-2">
              <RequirementChecks t={t} locale={locale} metrics={roles.metrics} />
            </div>
          </section>
        </div>
        <RoleHistory t={t} locale={locale} requests={roles.requests} events={roles.events} back={back} />
      </div>
    );
  } else if (tab === 'credits') {
    const entries = await userEntries(id, page, LEDGER_SIZE);
    const c = d.credits;
    body = (
      <section className="card min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-[15px] font-bold">{c.title}</h2>
          <small className="text-[11px] text-muted">{c.hint}</small>
        </div>
        <RecordsTable
          label={t.console.list.tableRegion}
          empty={c.empty}
          head={[c.columns.item, c.columns.note, c.columns.delta, c.columns.time]}
          rows={entries.items.map((entry) => [
            <span key="item" className="font-semibold whitespace-nowrap">
              {t.billing.reasons[entry.reason] ?? entry.reason}
            </span>,
            <span key="note" className="block max-w-[320px] break-words text-muted">
              {entry.note || '—'}
            </span>,
            <Delta key="delta" value={entry.delta} locale={locale} />,
            <span key="time" className="whitespace-nowrap">
              {formatDateTime(entry.createdAt, locale)}
            </span>,
          ])}
        />
        <LinkPager t={t} page={entries.page} total={entries.total} size={entries.size} href={(target) => href('credits', target > 1 ? { page: target } : {})} />
      </section>
    );
  } else if (tab === 'kyc') {
    body = <Empty icon="shield" title={d.kyc.title} body={official ? d.kyc.official : d.kyc.body} />;
  } else if (tab === 'payouts') {
    body = <Empty icon="send" title={d.payouts.title} body={official ? d.payouts.official : d.payouts.body} />;
  } else if (tab === 'purchases') {
    const { purchases, subscriptions } = await userPurchases(id);
    const p = t.consoleUsers.purchases;
    const s = d.purchases.subscriptionColumns;
    body = (
      <div className="flex min-w-0 flex-col gap-4">
        <section className="card min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-bold">{d.purchases.subscription}</h2>
            <Tag tone={user.membership === 'active' ? 'green' : user.membership === 'none' ? 'grey' : 'orange'}>{t.consoleUsers.users.membership[user.membership]}</Tag>
          </div>
          <RecordsTable
            label={t.console.list.tableRegion}
            empty={d.purchases.noSubscription}
            head={[s.id, s.status, s.renewal, s.period, s.updated]}
            rows={subscriptions.map((row) => [
              <span key="id" className="block max-w-[220px] font-mono text-[11px] break-all">
                {row.paddleSubscriptionId}
              </span>,
              <Tag key="status" tone={row.status === 'active' ? 'green' : row.status === 'cancelled' ? 'orange' : 'grey'}>
                {p.subscriptionStatus[row.status]}
              </Tag>,
              row.status === 'active' && !row.cancelAtPeriodEnd ? <Tag key="renewal" tone="green">{p.renewalOn}</Tag> : <Tag key="renewal">{p.renewalOff}</Tag>,
              <span key="period" className="whitespace-nowrap">
                {row.currentPeriodStart && row.currentPeriodEnd
                  ? `${formatDateTime(row.currentPeriodStart, locale)} — ${formatDateTime(row.currentPeriodEnd, locale)}`
                  : '—'}
              </span>,
              <span key="updated" className="whitespace-nowrap">
                {formatDateTime(row.updatedAt, locale)}
              </span>,
            ])}
          />
        </section>
        <section className="card min-w-0 overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-bold">{d.purchases.title}</h2>
          </div>
          <RecordsTable
            label={t.console.list.tableRegion}
            empty={d.purchases.empty}
            head={[p.columns.typeAmount, p.columns.transaction, p.columns.credits, p.columns.statusTime, p.columns.action]}
            rows={purchases.map((row) => [
              <div key="type">
                <strong className="font-mono">{money(row.amountMinor, row.currency, locale)}</strong>
                <small className="block text-muted">
                  {p.kinds[row.kind]}
                  {row.quantity > 1 && ` ${fill(p.quantity, { n: row.quantity })}`}
                </small>
              </div>,
              <span key="txn" className="block max-w-[220px] font-mono text-[11px] break-all">
                {row.paddleTransactionId}
              </span>,
              <div key="credits">
                <span className="font-mono">{n(row.credits)}</span>
                {row.reversedCredits > 0 && <small className="block text-red">{fill(p.reversed, { n: n(row.reversedCredits) })}</small>}
              </div>,
              <div key="status" className="flex flex-col items-start gap-1">
                <PurchaseStatusTag t={t} status={row.status} />
                <small className="whitespace-nowrap text-muted">{formatDateTime(row.createdAt, locale)}</small>
              </div>,
              <Link key="action" href={`/admin/purchases/${row.id}?from=${back}`} className="btn-secondary btn-sm">
                {p.transaction}
              </Link>,
            ])}
          />
        </section>
      </div>
    );
  } else {
    const rees = await userRees(id);
    const r = d.rees;
    body = (
      <section className="card min-w-0 overflow-hidden">
        <RecordsTable
          label={t.console.list.tableRegion}
          empty={r.empty}
          head={[r.columns.name, r.columns.visibility, r.columns.sources, r.columns.created]}
          rows={rees.map((ree) => {
            const visibility = ree.deletedAt ? 'deleted' : ree.moderatedAt ? 'moderated' : ree.isPublic ? 'public' : 'private';
            return [
              <Link key="name" href={`/admin/rees/${ree.id}?from=${back}`} className="flex max-w-[280px] min-w-0 items-center gap-2.5 hover:text-blue">
                <ReeAvatar avatar={ree.avatarBlob} color={ree.color} size="sm" />
                <span className="min-w-0">
                  <strong className="block truncate">{ree.name}</strong>
                  <small className="block truncate font-mono text-[11px] text-muted">{ree.slug}</small>
                </span>
              </Link>,
              <Tag key="visibility" tone={visibility === 'public' ? 'green' : visibility === 'moderated' ? 'red' : 'grey'}>
                {r.visibility[visibility]}
              </Tag>,
              <span key="sources" className="font-mono">
                {n(ree.readySources)} / {n(ree.sources)}
              </span>,
              <span key="created" className="whitespace-nowrap">
                {formatDateTime(ree.createdAt, locale)}
              </span>,
            ];
          })}
        />
      </section>
    );
  }

  const stats: { label: string; value: number; hint: string; icon: IconName; tone?: string }[] = [
    {
      label: d.stats.plan,
      value: user.balances.plan,
      hint: user.planActive && user.subscription?.currentPeriodEnd ? fill(d.stats.planUntil, { date: formatDate(user.subscription.currentPeriodEnd, locale) }) : d.stats.planNone,
      icon: 'layers',
    },
    { label: d.stats.pack, value: user.balances.pack, hint: d.stats.packHint, icon: 'cards' },
    { label: d.stats.earned, value: user.balances.earned, hint: official ? d.stats.earnedOfficial : d.stats.earnedHint, icon: 'sparkle' },
    { label: d.stats.welcome, value: user.balances.welcome, hint: d.stats.welcomeHint, icon: 'plus' },
  ];
  if (user.debt > 0) stats.push({ label: d.stats.debt, value: user.debt, hint: d.stats.debtHint, icon: 'info', tone: 'text-red' });

  return (
    <>
      <PageHead
        crumbs={[
          { label: t.console.nav.home, href: '/admin/overview' },
          { label: fromVerifications ? t.console.nav.verifications : t.console.nav.users, href: from },
          { label: user.name },
        ]}
        title={
          <span className="flex min-w-0 items-center gap-3">
            <UserAvatar name={user.name} className="size-11 text-[14px]" />
            <span className="min-w-0 break-words">{user.name}</span>
          </span>
        }
        lede={
          <span className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all">
              {user.email} · {fill(d.id, { id: user.id })}
            </span>
            <Tag tone={user.disabledAt ? 'red' : 'green'}>{t.consoleUsers.users.status[user.disabledAt ? 'disabled' : 'active']}</Tag>
            <RoleBadge t={t} role={user.role} showNormal />
          </span>
        }
        actions={
          <>
            <AdjustCreditsButton id={user.id} name={user.name} email={user.email} planActive={user.planActive} />
            <UserStatusButton id={user.id} disabled={Boolean(user.disabledAt)} />
          </>
        }
      />
      <div className={`mb-4 grid grid-cols-2 gap-3 ${stats.length > 4 ? 'md:grid-cols-3 xl:grid-cols-5' : 'md:grid-cols-4'}`}>
        {stats.map((stat) => (
          <div key={stat.label} className="card min-w-0 px-4 py-3">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted">
              <Icon name={stat.icon} className="size-3.5 flex-none" />
              <span className="truncate">{stat.label}</span>
            </span>
            <strong className={`mt-1 block font-mono text-[20px] leading-tight ${stat.tone ?? ''}`}>{n(stat.value)}</strong>
            <small className="mt-0.5 block text-[11px] text-muted">{stat.hint}</small>
          </div>
        ))}
      </div>
      <nav aria-label={d.tabs.label} className="mb-4 flex max-w-full gap-1 overflow-x-auto border-b border-line">
        {TABS.map((value) => (
          <Link
            key={value}
            href={href(value)}
            aria-current={value === tab ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2.5 text-[13px] font-semibold whitespace-nowrap ${value === tab ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {d.tabs[value]}
          </Link>
        ))}
      </nav>
      {body}
    </>
  );
}

function money(minor: number, currency: string, locale: Locale): string {
  return currency === 'USD' ? formatUsd(minor, locale) : `${(minor / 100).toFixed(2)} ${currency}`;
}

function Delta({ value, locale }: { value: number; locale: Locale }) {
  return (
    <span className={`font-mono whitespace-nowrap ${value > 0 ? 'text-green' : value < 0 ? 'text-ink' : 'text-muted'}`}>
      {value > 0 ? '+' : ''}
      {formatNumber(value, locale)}
    </span>
  );
}

function PurchaseStatusTag({ t, status }: { t: Messages; status: 'paid' | 'refunded' | 'chargeback' }) {
  return <Tag tone={status === 'paid' ? 'green' : status === 'refunded' ? 'orange' : 'red'}>{t.consoleUsers.purchases.status[status]}</Tag>;
}

function Empty({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <section className="card flex min-w-0 flex-col items-center px-6 py-12 text-center">
      <span className="inline-flex size-11 items-center justify-center rounded-xl bg-soft text-blue">
        <Icon name={icon} className="size-5" />
      </span>
      <h2 className="mt-3 text-[15px] font-bold">{title}</h2>
      <p className="mt-1.5 max-w-[420px] text-[13px] leading-relaxed text-muted">{body}</p>
    </section>
  );
}

function Summary({ t, locale, user, reesCount, purchasesCount }: { t: Messages; locale: Locale; user: AdminUserDetail; reesCount: number; purchasesCount: number }) {
  const d = t.consoleUsers.detail;
  const s = d.summary;
  const time = (value: Date | null | undefined) => (value ? formatDateTime(value, locale) : '—');
  const subscription = user.subscription;
  const total = user.balances.plan + user.balances.pack + user.balances.earned + user.balances.welcome;
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section className="card min-w-0 p-5">
        <h2 className="mb-4 text-[15px] font-bold">{s.account}</h2>
        <Fields
          items={[
            [s.email, <span key="email" className="break-all">{user.email}</span>],
            [s.provider, d.providers[user.provider]],
            [s.handle, user.providerHandle ? <span key="handle" className="break-all">{user.providerHandle}</span> : '—'],
            [
              s.status,
              <span key="status" className="flex flex-wrap items-center gap-2">
                <Tag tone={user.disabledAt ? 'red' : 'green'}>{t.consoleUsers.users.status[user.disabledAt ? 'disabled' : 'active']}</Tag>
                {user.disabledAt && <small className="text-muted">{fill(s.disabledAt, { time: time(user.disabledAt) })}</small>}
              </span>,
            ],
            [s.created, time(user.createdAt)],
            [s.lastLogin, user.lastLoginAt ? time(user.lastLoginAt) : s.never],
            [
              s.membership,
              <Tag key="membership" tone={user.membership === 'active' ? 'green' : user.membership === 'none' ? 'grey' : 'orange'}>
                {t.consoleUsers.users.membership[user.membership]}
              </Tag>,
            ],
            [
              s.period,
              subscription?.currentPeriodStart && subscription.currentPeriodEnd ? `${time(subscription.currentPeriodStart)} — ${time(subscription.currentPeriodEnd)}` : '—',
            ],
            [s.renewal, subscription ? (subscription.status === 'active' && !subscription.cancelAtPeriodEnd ? s.renewalOn : s.renewalOff) : '—'],
            [s.role, <RoleBadge key="role" t={t} role={user.role} showNormal />],
            [s.total, <span key="total" className="font-mono">{formatNumber(total, locale)}</span>],
            [s.reesCount, <span key="rees" className="font-mono">{formatNumber(reesCount, locale)}</span>],
            [s.purchasesCount, <span key="purchases" className="font-mono">{formatNumber(purchasesCount, locale)}</span>],
            [d.stats.debt, <span key="debt" className={`font-mono ${user.debt > 0 ? 'text-red' : ''}`}>{formatNumber(user.debt, locale)}</span>],
          ]}
        />
      </section>
      <RolePanel t={t} locale={locale} user={user} footnote />
    </div>
  );
}

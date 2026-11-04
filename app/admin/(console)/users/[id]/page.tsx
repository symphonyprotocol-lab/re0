import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { notFound } from 'next/navigation';
import { Fragment, type ReactNode } from 'react';
import type { KycStatus } from '@/db/schema';
import { param } from '@/lib/domain/list';
import { adminUser, userEntries, userPurchases, userRees, userRoles, type AdminUserDetail } from '@/lib/services/admin-users';
import type { Messages } from '@/i18n';
import type { Locale } from '@/i18n/locale';
import { serverMessages } from '@/i18n/server';
import { fill, formatDate, formatDateTime, formatNumber, formatUsd } from '@/i18n/format';
import { LinkPager, RecordsTable, RoleBadge, Stats, Subline, Tag } from '@/components/admin/list-kit';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { AdjustCreditsButton, UserStatusButton } from '@/components/admin/user-detail-actions';
import { DotAvatar, RoleChecks, RoleHistory, RolePanel } from '@/components/admin/user-detail-roles';
import { kycHistory } from '@/lib/services/kyc';
import { listNotices } from '@/lib/services/notices';
import { answerCounts } from '@/lib/services/statistics';
import { payoutsOf } from '@/lib/services/payouts';
import { KycStatusTag } from '@/components/admin/payout-kit';
import { PayoutsTable } from '@/components/admin/payouts-table';
import { ReeRowActions } from '@/components/admin/ree-detail';
import { UserNotices } from '@/components/admin/user-notices';
import { ReasonAction } from '@/components/admin/list-client';
import { ADMIN_REASON } from '@/lib/constants';

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

/** Only a console page may be the way back: anything else falls back to the users list. */
function backTo(raw: string): string {
  return /^\/admin\/(users|verifications|kyc|payouts|payout-history|purchases|audit|rees)(?:[/?]|$)/.test(raw) && !raw.includes('//') && !raw.includes('\\') ? raw : '/admin/users';
}

/** The crumb for the page that linked here, named as in the console's navigation. */
function listLabel(t: Messages, from: string): string {
  const key = (['verifications', 'kyc', 'payout-history', 'payouts', 'purchases', 'audit', 'rees'] as const).find((name) => from.startsWith(`/admin/${name}`));
  return t.console.nav[key ?? 'users'];
}

/**
 * `/admin/users/[id]` (prototype suite.js `userDetail`, role-pages.js
 * `adminUser`): the header, balances, and seven tabs as links in the top
 * bar's second row (`?tab=credits`, `from` kept) so reload and back keep the
 * place; the account actions sit in the summary, as in the prototype.
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

  const table = t.console.list.tableRegion;
  const person = <UserLink user={user} href={href('summary')} />;
  let body: ReactNode;
  if (tab === 'summary') {
    const [kyc, notices] = await Promise.all([kycHistory(id), listNotices(id, 1)]);
    body = (
      <>
        <Summary t={t} locale={locale} user={user} kyc={kyc[0] ?? null} />
        <RolePanel t={t} locale={locale} user={user} footnote />
        <UserNotices t={t} locale={locale} items={notices.items} total={notices.total} />
      </>
    );
  } else if (tab === 'roles') {
    const roles = await userRoles(id);
    body = (
      <>
        <RolePanel t={t} locale={locale} user={user} />
        <RoleHistory t={t} locale={locale} requests={roles.requests} events={roles.events} back={back} />
        <section className="card role-panel">
          <h2>{d.roles.checks}</h2>
          <p>{d.roles.checksHint}</p>
          <RoleChecks t={t} locale={locale} metrics={roles.metrics} />
        </section>
      </>
    );
  } else if (tab === 'credits') {
    const entries = await userEntries(id, page, LEDGER_SIZE);
    const c = d.credits;
    body = (
      <section className="card">
        <RecordsTable
          label={table}
          empty={c.empty}
          head={[c.columns.item, c.columns.time, c.columns.note, c.columns.delta]}
          rows={entries.items.map((entry) => [
            t.billing.reasons[entry.reason] ?? entry.reason,
            formatDateTime(entry.createdAt, locale),
            entry.note || '—',
            <span key="delta" className={`mono ${entry.delta > 0 ? 'positive' : ''}`}>
              {entry.delta > 0 ? '+' : ''}
              {n(entry.delta)}
            </span>,
          ])}
        />
        {entries.total > entries.size && (
          <LinkPager t={t} page={entries.page} total={entries.total} size={entries.size} href={(target) => href('credits', target > 1 ? { page: target } : {})} />
        )}
      </section>
    );
  } else if (tab === 'kyc') {
    const records = await kycHistory(id);
    const k = d.kyc;
    const kp = t.consolePayouts.kyc;
    const kd = t.consolePayouts.kycDetail;
    const time = (value: Date | null) => (value ? formatDateTime(value, locale) : '—');
    body = (
      <section className="card">
        <RecordsTable
          label={table}
          empty={official ? k.official : t.consolePayouts.user.kycEmpty}
          head={[k.columns.user, k.columns.identity, k.columns.document, k.columns.tax, k.columns.time, k.columns.action]}
          rows={records.map((row, index) => [
            person,
            <Fragment key="identity">
              {row.legalName ?? '—'}
              <Subline>{row.country ?? '—'}</Subline>
            </Fragment>,
            <Fragment key="document">
              <KycStatusTag t={t} status={row.status} />
              <Subline>
                {row.documentKind ? t.payouts.kyc.kinds[row.documentKind] : '—'} {row.documentLast4 ? `•••• ${row.documentLast4}` : ''}
              </Subline>
              {row.filesDeleted && <Subline>{kp.filesDeleted}</Subline>}
            </Fragment>,
            <Fragment key="tax">
              {row.taxForm ?? '—'}
              <Subline>{row.declared ? kp.declared : kp.notDeclared}</Subline>
            </Fragment>,
            <Fragment key="time">
              {time(row.createdAt)}
              <Subline>
                {time(row.decidedAt)} · {row.reviewer ?? '—'}
              </Subline>
            </Fragment>,
            <div key="action" className="flex">
              <Link href={`/admin/kyc/${row.id}?from=${back}`} className="btn secondary sm">
                {row.status === 'pending' ? kp.review : kp.view}
              </Link>
              {index === 0 && !official && (row.status === 'verified' || row.status === 'rejected') && (
                <ReasonAction
                  endpoint={`/api/admin/kyc/${row.id}/reset`}
                  label={kd.reset}
                  className="btn ghost sm"
                  title={kd.resetTitle}
                  subtitle={user.name}
                  body={kd.resetBody}
                  confirmLabel={kd.resetConfirm}
                  reason={{ min: ADMIN_REASON.min, max: ADMIN_REASON.max, required: true, label: kd.resetReason }}
                  errors={t.consolePayouts.errors}
                />
              )}
            </div>,
          ])}
        />
      </section>
    );
  } else if (tab === 'payouts') {
    const rows = await payoutsOf(id);
    body = (
      <section className="card">
        <PayoutsTable t={t} locale={locale} items={rows} back={back} empty={official ? d.payouts.official : t.consolePayouts.user.payoutsEmpty} />
      </section>
    );
  } else if (tab === 'purchases') {
    const { purchases, subscriptions } = await userPurchases(id);
    const p = t.consoleUsers.purchases;
    const pc = d.purchases.columns;
    const s = d.purchases.subscriptionColumns;
    body = (
      <>
        <section className="card">
          <div className="console-table-head">
            <h2>{d.purchases.title}</h2>
            <Tag tone={user.membership === 'active' ? 'green' : user.membership === 'cancelled' ? 'orange' : 'grey'}>{t.consoleUsers.users.membershipCell[user.membership]}</Tag>
          </div>
          <RecordsTable
            label={table}
            empty={d.purchases.empty}
            head={[pc.user, pc.kind, pc.amount, pc.credits, pc.transaction, pc.status, pc.time, pc.action]}
            rows={purchases.map((row) => [
              person,
              <Tag key="kind" dot={false}>
                {p.kinds[row.kind]}
                {row.quantity > 1 && ` ${fill(p.quantity, { n: row.quantity })}`}
              </Tag>,
              money(row.amountMinor, row.currency, locale),
              <Fragment key="credits">
                <span className="mono">{n(row.credits)}</span>
                {row.reversedCredits > 0 && <Subline>{fill(p.reversed, { n: n(row.reversedCredits) })}</Subline>}
              </Fragment>,
              <code key="txn">{row.paddleTransactionId}</code>,
              <PurchaseStatusTag key="status" t={t} status={row.status} />,
              formatDateTime(row.createdAt, locale),
              <Link key="action" href={`/admin/purchases/${row.id}?from=${back}`} className="btn secondary sm">
                {p.transaction}
              </Link>,
            ])}
          />
        </section>
        {subscriptions.length > 0 && (
          <section className="card mt24">
            <div className="console-table-head">
              <h2>{d.purchases.subscription}</h2>
            </div>
            <RecordsTable
              label={table}
              empty={d.purchases.noSubscription}
              head={[s.id, s.status, s.renewal, s.period, s.updated]}
              rows={subscriptions.map((row) => [
                <code key="id">{row.paddleSubscriptionId}</code>,
                <Tag key="status" tone={row.status === 'active' ? 'green' : row.status === 'cancelled' ? 'orange' : 'grey'}>
                  {p.subscriptionStatus[row.status]}
                </Tag>,
                row.status === 'active' && !row.cancelAtPeriodEnd ? p.renewalOn : p.renewalOff,
                row.currentPeriodStart && row.currentPeriodEnd ? `${formatDateTime(row.currentPeriodStart, locale)} — ${formatDateTime(row.currentPeriodEnd, locale)}` : '—',
                formatDateTime(row.updatedAt, locale),
              ])}
            />
          </section>
        )}
      </>
    );
  } else {
    const rees = await userRees(id);
    const answers = await answerCounts(rees.map((ree) => ree.id), null);
    const r = d.rees;
    body = (
      <section className="card">
        <RecordsTable
          label={table}
          empty={r.empty}
          head={[r.columns.name, r.columns.owner, r.columns.visibility, r.columns.sources, r.columns.fee, r.columns.answers, r.columns.action]}
          rows={rees.map((ree) => {
            const live = ree.moderatedAt ? 'moderated' : ree.isPublic ? 'public' : 'private';
            const visibility = ree.deletedAt ? 'deleted' : live;
            const detail = `/admin/rees/${ree.id}?from=${back}`;
            return [
              <Link key="name" href={detail} className="table-person admin-ree-name-link" aria-label={fill(r.open, { name: ree.name })}>
                <DotAvatar avatar={ree.avatarBlob} color={ree.color} />
                <span>
                  <strong>{ree.name}</strong>
                  <small>{ree.slug}</small>
                </span>
              </Link>,
              person,
              <span key="visibility" className={`tag ${visibility === 'moderated' ? 'orange' : visibility === 'public' ? 'blue' : ''}`}>
                {r.visibility[visibility]}
              </span>,
              n(ree.sources),
              <Fragment key="fee">
                <span className="mono">{n(ree.queryFee)}</span> credits
              </Fragment>,
              n(answers.get(ree.id) ?? 0),
              <ReeRowActions
                key="action"
                t={t}
                ree={{ id: ree.id, name: ree.name, slug: ree.slug, visibility: live, deleted: Boolean(ree.deletedAt) }}
                detailHref={detail}
              />,
            ];
          })}
        />
      </section>
    );
  }

  return (
    <ConsolePage>
      <ConsoleTopbar
        crumbs={[
          { label: t.console.nav.home, href: '/admin/overview' },
          { label: listLabel(t, from), href: from },
          { label: user.name },
        ]}
        tabs={TABS.map((value) => ({ label: d.tabs[value], href: href(value), active: value === tab }))}
        tabsLabel={d.tabs.label}
      />
      <div className="user-detail-head">
        <span className="avatar">{Array.from(user.name.trim())[0] ?? '?'}</span>
        <div className="grow">
          <h1>{user.name}</h1>
          <p>
            {user.email} · {fill(d.id, { id: user.id })}
          </p>
        </div>
        <Tag tone={user.disabledAt ? 'grey' : 'green'}>{t.consoleUsers.users.status[user.disabledAt ? 'disabled' : 'active']}</Tag>
        <RoleBadge t={t} role={user.role} showNormal />
      </div>
      <Stats
        items={[
          {
            label: d.stats.plan,
            value: n(user.balances.plan),
            note: user.planActive && user.subscription?.currentPeriodEnd ? fill(d.stats.planUntil, { date: formatDate(user.subscription.currentPeriodEnd, locale) }) : d.stats.planNone,
            icon: 'wallet',
          },
          { label: d.stats.pack, value: n(user.balances.pack), note: d.stats.packHint, icon: 'layers' },
          { label: d.stats.earned, value: n(user.balances.earned), note: official ? d.stats.earnedOfficial : d.stats.earnedHint, icon: 'sparkle' },
        ]}
      />
      {body}
    </ConsolePage>
  );
}

function money(minor: number, currency: string, locale: Locale): string {
  return currency === 'USD' ? formatUsd(minor, locale) : `${(minor / 100).toFixed(2)} ${currency}`;
}

function PurchaseStatusTag({ t, status }: { t: Messages; status: 'paid' | 'refunded' | 'chargeback' }) {
  return <Tag tone={status === 'paid' ? 'green' : status === 'refunded' ? 'grey' : 'red'}>{t.consoleUsers.purchases.status[status]}</Tag>;
}

/** The user as the prototype's tables show a person (suite.js `userLink`): initial, name and email. */
function UserLink({ user, href }: { user: { name: string; email: string }; href: string }) {
  return (
    <Link href={href}>
      <span className="table-person">
        <span className="avatar">{Array.from(user.name.trim())[0] ?? '?'}</span>
        <span>
          <strong>{user.name}</strong>
          <small>{user.email}</small>
        </span>
      </span>
    </Link>
  );
}

function Summary({
  t,
  locale,
  user,
  kyc,
}: {
  t: Messages;
  locale: Locale;
  user: AdminUserDetail;
  /** The newest `kyc_record`, whose state and tax form the summary shows. */
  kyc: { status: KycStatus; taxForm: string | null } | null;
}) {
  const d = t.consoleUsers.detail;
  const s = d.summary;
  const time = (value: Date | null | undefined) => (value ? formatDateTime(value, locale) : '—');
  const subscription = user.subscription;
  const lines: [string, ReactNode][] = [
    [s.email, user.email],
    [s.status, <Tag key="status" tone={user.disabledAt ? 'grey' : 'green'}>{t.consoleUsers.users.status[user.disabledAt ? 'disabled' : 'active']}</Tag>],
    [
      s.membership,
      <Tag key="membership" tone={user.membership === 'active' ? 'green' : user.membership === 'cancelled' ? 'orange' : 'grey'}>
        {t.consoleUsers.users.membershipCell[user.membership]}
      </Tag>,
    ],
    [s.period, subscription?.currentPeriodStart && subscription.currentPeriodEnd ? `${time(subscription.currentPeriodStart)} — ${time(subscription.currentPeriodEnd)}` : '—'],
    [
      s.kyc,
      user.role === 'official' ? (
        <Tag key="kyc" dot={false}>
          {t.consoleUsers.users.kycExempt}
        </Tag>
      ) : kyc ? (
        <KycStatusTag key="kyc" t={t} status={kyc.status} />
      ) : (
        <Tag key="kyc">{t.consoleUsers.users.kyc.none}</Tag>
      ),
    ],
    [s.taxForm, kyc?.taxForm ?? '—'],
    [s.renewal, subscription ? (subscription.status === 'active' && !subscription.cancelAtPeriodEnd ? s.renewalOn : s.renewalOff) : '—'],
    [s.provider, user.providerHandle ? `${d.providers[user.provider]} · ${user.providerHandle}` : d.providers[user.provider]],
    [s.created, time(user.createdAt)],
    [s.lastLogin, user.lastLoginAt ? time(user.lastLoginAt) : s.never],
  ];
  if (user.disabledAt) lines.push([s.disabledSince, time(user.disabledAt)]);
  lines.push([s.welcome, <span key="welcome" className="mono">{formatNumber(user.balances.welcome, locale)}</span>]);
  if (user.debt > 0) lines.push([d.stats.debt, <span key="debt" className="mono">{formatNumber(user.debt, locale)}</span>]);
  return (
    <div className="user-detail-overview">
      <section className="card settings-card">
        <h2>{s.account}</h2>
        {lines.map(([label, value]) => (
          <div key={label} className="detail-line">
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>
      <section className="card settings-card">
        <h2>{s.actions}</h2>
        <p className="muted mt16">{s.actionsBody}</p>
        <AdjustCreditsButton id={user.id} name={user.name} email={user.email} planActive={user.planActive} />
        <UserStatusButton id={user.id} disabled={Boolean(user.disabledAt)} />
        <p className="form-hint mt16">{s.actionsHint}</p>
      </section>
    </div>
  );
}

import type { Metadata } from 'next';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { requireAdministrator } from '@/lib/http/admin';
import { TASK_KINDS } from '@/lib/domain/invites';
import { inviteOverview } from '@/lib/services/invites';
import { welcomeCredits } from '@/lib/services/signup-reward';
import { serverMessages } from '@/i18n/server';
import { fill, formatDateTime, formatNumber } from '@/i18n/format';
import { ConsolePage, ConsoleTopbar } from '@/components/admin/console-topbar';
import { PageHead, RecordsTable, SummaryCards, Subline, Tag } from '@/components/admin/list-kit';
import { CI } from '@/components/admin/console-icon';
import { InvitesForm } from '@/components/admin/invites-form';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.invites.admin.title };
}

/**
 * `/admin/invites` (docs/design/invitations.md): the invitation, starter
 * task and check-in settings, the withdrawable quota's use, rewards paid of
 * each kind, check-ins, the leading inviters and the latest invitations.
 */
export default async function InvitesPage() {
  const administrator = await requireAdministrator();
  const [{ t, locale }, overview, welcome] = await Promise.all([serverMessages(), inviteOverview(administrator), welcomeCredits()]);
  const a = t.invites.admin;
  const n = (value: number) => formatNumber(value, locale);
  const taskCredits = overview.tasks.reduce((sum, row) => sum + row.credits, 0);
  const table = t.console.list.tableRegion;
  return (
    <ConsolePage>
      <ConsoleTopbar crumbs={[{ label: t.console.nav.home, href: '/admin/overview' }, { label: a.title }]} />
      <div className="console-body">
        <PageHead title={a.title} lede={a.lede} />
        <div className="info-strip mb16">
          <CI name="info" />
          <span>{a.note}</span>
        </div>
        <SummaryCards
          items={[
            { label: a.cards.state, value: <Tag tone={overview.state === 'open' ? 'green' : 'orange'}>{a.states[overview.state]}</Tag> },
            { label: a.cards.quota, value: fill(a.cards.quotaOf, { n: n(overview.withdrawableUsed), quota: n(overview.settings.withdrawableInvites) }) },
            { label: a.cards.attributed, value: n(overview.attributed) },
            { label: a.cards.capped, value: n(overview.invitersCapped) },
            { label: a.cards.withdrawable, value: n(overview.creditsWithdrawable) },
            { label: a.cards.gift, value: n(overview.creditsGift) },
            { label: a.cards.tasks, value: n(taskCredits) },
            { label: a.cards.checkIns, value: fill(a.cards.checkInsOf, { n: n(overview.checkIns.count), credits: n(overview.checkIns.credits) }) },
          ]}
        />
        <InvitesForm initial={overview.settings} welcomeCredits={welcome.credits} />
        <section className="card pricing-admin-card pricing-credit-card">
          <h2>{a.tasks.title}</h2>
          <RecordsTable
            label={table}
            empty={a.inviters.empty}
            head={[a.tasks.task, a.tasks.accounts, a.tasks.credits]}
            rows={TASK_KINDS.map((task) => {
              const row = overview.tasks.find((entry) => entry.task === task);
              return [a.taskNames[task], <span key="accounts" className="mono">{n(row?.accounts ?? 0)}</span>, <span key="credits" className="mono">{n(row?.credits ?? 0)}</span>];
            })}
          />
        </section>
        <section className="card pricing-admin-card pricing-credit-card">
          <h2>{a.inviters.title}</h2>
          <RecordsTable
            label={table}
            empty={a.inviters.empty}
            head={[a.inviters.user, a.inviters.invited, a.inviters.split, a.inviters.credits]}
            rows={overview.inviters.map((row) => [
              <Link key="user" href={`/admin/users/${row.id}`} className="text-link">
                {row.name}
                <small className="muted"> · {row.email}</small>
              </Link>,
              <span key="invited" className="mono">{n(row.invited)}</span>,
              <span key="split" className="mono">
                {n(row.withdrawable)} / {n(row.gift)}
              </span>,
              <span key="credits" className="mono">{n(row.credits)}</span>,
            ])}
          />
        </section>
        <section className="card pricing-admin-card pricing-credit-card">
          <h2>{a.recent.title}</h2>
          <RecordsTable
            label={table}
            empty={a.recent.empty}
            head={[a.recent.invitee, a.recent.inviter, a.recent.code, a.recent.reward, a.recent.time]}
            rows={overview.recent.map((row) => [
              <Link key="invitee" href={`/admin/users/${row.inviteeId}`} className="text-link">
                {row.inviteeName}
              </Link>,
              <Link key="inviter" href={`/admin/users/${row.inviterId}`} className="text-link">
                {row.inviterName}
              </Link>,
              <span key="code" className="mono">{row.code}</span>,
              <span key="reward" className="mono">
                {n(row.rewardCredits)} {row.rewardCredits > 0 && <Tag tone={row.withdrawable ? 'green' : 'grey'}>{a.kinds[row.withdrawable ? 'withdrawable' : 'gift']}</Tag>}
                {row.giftReason && <Subline>{a.giftReasons[row.giftReason]}</Subline>}
              </span>,
              formatDateTime(row.createdAt, locale),
            ])}
          />
        </section>
      </div>
    </ConsolePage>
  );
}

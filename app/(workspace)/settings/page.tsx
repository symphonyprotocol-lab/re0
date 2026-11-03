import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { githubConnectionFor, listDomains } from '@/lib/services/connections';
import { listNotices } from '@/lib/services/notices';
import { verificationOverview } from '@/lib/services/roles';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { AccountForm } from '@/components/settings/account-form';
import { BillingTab } from '@/components/billing/billing-tab';
import { Connections } from '@/components/settings/connections';
import { NoticesTab } from '@/components/settings/notices-tab';
import { RoleTab } from '@/components/settings/role-tab';
import '@/components/settings/settings.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.settings.title };
}

const TABS = ['account', 'role', 'connections', 'billing', 'notices'] as const;
const OUTCOMES = ['connected', 'canceled', 'failed'] as const;

/**
 * `/settings?tab=account|role|connections|billing|notices`. Connections holds GitHub and
 * the domain claims (step 2); billing holds balances, Plan / Pack and the
 * ledger (step 3; `activity`, `page`, `size`, `checkout` are its parameters).
 * Role holds the verification threshold and application, notices the
 * in-app notices (step 5; `page` is the notices' parameter).
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = (await currentUser())!;
  const { t } = await serverMessages();
  const query = await searchParams;
  const tab = (TABS as readonly string[]).includes(query.tab ?? '') ? (query.tab as (typeof TABS)[number]) : 'account';
  const s = t.settings;
  return (
    <>
      <Topbar
        crumbs={[{ label: t.dashboard.title, href: '/dashboard' }, { label: s.title }]}
        tabsLabel={s.tabs.label}
        tabs={[
          { label: s.tabs.account, href: '/settings?tab=account', active: tab === 'account' },
          { label: t.roles.tab, href: '/settings?tab=role', active: tab === 'role' },
          { label: s.tabs.connections, href: '/settings?tab=connections', active: tab === 'connections' },
          { label: s.tabs.billing, href: '/settings?tab=billing', active: tab === 'billing' },
          { label: t.notices.tab, href: '/settings?tab=notices', active: tab === 'notices' },
        ]}
      />
      <main className="settings-page">
        <div className="settings-layout">
          <div className="settings-content">
            {tab === 'account' ? (
              <AccountForm
                account={{
                  name: user.name,
                  avatarBlob: user.avatarBlob,
                  email: user.email,
                  provider: user.provider,
                  providerHandle: user.providerHandle,
                  lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
                }}
              />
            ) : tab === 'connections' ? (
              <Connections
                github={await githubConnectionFor(user.id)}
                domains={(await listDomains(user.id)).map((domain) => ({ ...domain, checkedAt: domain.checkedAt?.toISOString() ?? null }))}
                outcome={(OUTCOMES as readonly string[]).includes(query.github ?? '') ? (query.github as (typeof OUTCOMES)[number]) : null}
              />
            ) : tab === 'role' ? (
              <RoleTab overview={await verificationOverview(user.id)} />
            ) : tab === 'notices' ? (
              <NoticesTab {...(await noticesFor(user.id, Number(query.page) || 1))} />
            ) : (
              <BillingTab userId={user.id} query={query} />
            )}
          </div>
        </div>
      </main>
    </>
  );
}

async function noticesFor(userId: string, page: number) {
  const list = await listNotices(userId, page);
  return {
    items: list.items.map((item) => ({ ...item, readAt: item.readAt?.toISOString() ?? null, createdAt: item.createdAt.toISOString() })),
    total: list.total,
    page: list.page,
    size: list.size,
    unread: list.unread,
  };
}

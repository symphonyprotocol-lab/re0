import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/http/session';
import { githubRepositoryAccess } from '@/lib/infra/identity/github';
import { githubConnectionFor, listDomains } from '@/lib/services/connections';
import { verificationOverview } from '@/lib/services/roles';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { AccountForm } from '@/components/settings/account-form';
import { BillingTab } from '@/components/billing/billing-tab';
import { BalanceTab } from '@/components/billing/balance-tab';
import { Connections } from '@/components/settings/connections';
import { RoleTab } from '@/components/settings/role-tab';
import { ApiKeysTab } from '@/components/settings/api-keys-tab';
import { appBaseUrl } from '@/lib/http/cookies';
import { listApiKeys } from '@/lib/services/api-keys';
import { invitePanel } from '@/lib/services/invites';
import { InviteTab } from '@/components/settings/invite-tab';
import '@/components/settings/settings.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.settings.title };
}

const TABS = ['account', 'role', 'connections', 'balance', 'billing', 'invite', 'api'] as const;
const OUTCOMES = ['connected', 'canceled', 'failed'] as const;

/**
 * `/settings?tab=account|role|connections|balance|billing|invite|api` (`tab=notices` now goes to `/notifications`). Connections holds GitHub and
 * the domain claims (step 2); balance holds credits, Plan / Pack and payouts; billing holds the
 * ledger (`activity`, reporting period, search, and pagination). `checkout` belongs to balance.
 * Role holds the verification threshold and application, notices the
 * in-app notices (step 5; `page` is the notices' parameter). API holds the
 * keys for the MCP server and how to connect a client. Invite holds the
 * account's invite code and the people it invited.
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = (await currentUser())!;
  const { t } = await serverMessages();
  const query = await searchParams;
  if (query.tab === 'billing' && query.checkout) {
    const legacy = new URLSearchParams({ tab: 'balance', checkout: query.checkout });
    redirect(`/settings?${legacy}`);
  }
  /* 通知 has its own page in the navigation (v5); old links and bookmarks go there. */
  if (query.tab === 'notices') redirect(query.page ? `/notifications?page=${encodeURIComponent(query.page)}` : '/notifications');
  const tab = (TABS as readonly string[]).includes(query.tab ?? '') ? (query.tab as (typeof TABS)[number]) : 'account';
  const s = t.settings;
  return (
    <>
      <Topbar
        crumbs={[{ label: s.title }]}
        tabsLabel={s.tabs.label}
        tabs={[
          { label: s.tabs.account, href: '/settings?tab=account', active: tab === 'account', icon: 'user' },
          { label: t.roles.tab, href: '/settings?tab=role', active: tab === 'role', icon: 'shield' },
          { label: s.tabs.connections, href: '/settings?tab=connections', active: tab === 'connections', icon: 'link' },
          { label: s.tabs.balance, href: '/settings?tab=balance', active: tab === 'balance', icon: 'wallet' },
          { label: s.tabs.billing, href: '/settings?tab=billing', active: tab === 'billing', icon: 'file' },
          { label: t.invites.panel.tab, href: '/settings?tab=invite', active: tab === 'invite', icon: 'users' },
          { label: t.apiKeys.tab, href: '/settings?tab=api', active: tab === 'api', icon: 'key' },
        ]}
      />
      <main className="settings-page">
        <div className="settings-layout">
          <div className="settings-content">
            {tab === 'account' ? (
              <AccountForm
                account={{
                  name: user.name,
                  title: user.title,
                  description: user.description,
                  website: user.website,
                  socialContacts: user.socialContacts,
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
                githubAccess={githubRepositoryAccess()}
                domains={(await listDomains(user.id)).map((domain) => ({ ...domain, checkedAt: domain.checkedAt?.toISOString() ?? null }))}
                outcome={(OUTCOMES as readonly string[]).includes(query.github ?? '') ? (query.github as (typeof OUTCOMES)[number]) : null}
              />
            ) : tab === 'role' ? (
              <RoleTab overview={await verificationOverview(user.id)} />
            ) : tab === 'api' ? (
              <ApiKeysTab {...splitKeys(await listApiKeys(user.id))} mcpUrl={`${appBaseUrl()}/api/mcp`} />
            ) : tab === 'invite' ? (
              <InviteTab panel={await invitePanel(user.id)} />
            ) : tab === 'balance' ? (
              <BalanceTab userId={user.id} query={query} />
            ) : (
              <BillingTab userId={user.id} query={query} />
            )}
          </div>
        </div>
      </main>
    </>
  );
}


/** Keys, and the OAuth grants still live (connected apps; a revoked or lapsed one is only in the console). */
function splitKeys(items: Awaited<ReturnType<typeof listApiKeys>>) {
  const now = Date.now();
  return {
    keys: items.filter((key) => !key.oauthClient).map(serializeKey),
    apps: items.filter((key) => key.oauthClient && !key.revokedAt && (!key.expiresAt || key.expiresAt.getTime() > now)).map(serializeKey),
  };
}

function serializeKey(key: Awaited<ReturnType<typeof listApiKeys>>[number]) {
  return {
    ...key,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

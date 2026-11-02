import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { githubConnectionFor, listDomains } from '@/lib/services/connections';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { AccountForm } from '@/components/settings/account-form';
import { BillingTab } from '@/components/billing/billing-tab';
import { Connections } from '@/components/settings/connections';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.settings.title };
}

const TABS = ['account', 'connections', 'billing'] as const;
const OUTCOMES = ['connected', 'canceled', 'failed'] as const;

/**
 * `/settings?tab=account|connections|billing`. Connections holds GitHub and
 * the domain claims (step 2); billing holds balances, Plan / Pack and the
 * ledger (step 3; `activity`, `page`, `size`, `checkout` are its parameters).
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
          { label: s.tabs.account, href: '/settings?tab=account', active: tab === 'account', icon: 'user' },
          { label: s.tabs.connections, href: '/settings?tab=connections', active: tab === 'connections', icon: 'globe' },
          { label: s.tabs.billing, href: '/settings?tab=billing', active: tab === 'billing', icon: 'layers' },
        ]}
      />
      <main className={`mx-auto ${tab === 'billing' ? 'max-w-[1040px]' : 'max-w-[820px]'} px-4 py-8 md:px-8`}>
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
        ) : (
          <BillingTab userId={user.id} query={query} />
        )}
      </main>
    </>
  );
}

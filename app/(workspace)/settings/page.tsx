import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { githubConnectionFor, listDomains } from '@/lib/services/connections';
import { balanceOf } from '@/lib/services/credits';
import { serverMessages } from '@/i18n/server';
import { formatNumber } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { Icon } from '@/components/ui/icons';
import { AccountForm } from '@/components/settings/account-form';
import { Connections } from '@/components/settings/connections';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.settings.title };
}

const TABS = ['account', 'connections', 'billing'] as const;
const OUTCOMES = ['connected', 'canceled', 'failed'] as const;

/**
 * `/settings?tab=account|connections|billing`. Connections holds GitHub and
 * the domain claims (step 2); billing is a placeholder until step 3 (the
 * insufficient-credits dialog links here).
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string; github?: string }> }) {
  const user = (await currentUser())!;
  const { t, locale } = await serverMessages();
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
      <main className="mx-auto max-w-[820px] px-4 py-8 md:px-8">
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
          <section className="card p-6">
            <h1 className="text-[17px] font-bold">{s.billing.title}</h1>
            <div className="mt-5 rounded-xl border border-line bg-wash p-5">
              <p className="text-[12px] text-muted">{s.billing.balance}</p>
              <p className="mt-1 flex items-baseline gap-1">
                <strong className="font-mono text-[30px]">{formatNumber(await balanceOf(db(), user.id), locale)}</strong>
                <span className="text-[12px] text-muted">credits</span>
              </p>
              <p className="mt-1 text-[11px] text-muted">{s.billing.welcome}</p>
            </div>
            <p className="mt-5 flex items-center gap-2 text-[12px] text-muted">
              <Icon name="clock" className="size-4" />
              {s.billing.soon}
            </p>
          </section>
        )}
      </main>
    </>
  );
}

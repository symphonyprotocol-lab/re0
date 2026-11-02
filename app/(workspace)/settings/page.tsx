import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { balanceOf } from '@/lib/services/credits';
import { serverMessages } from '@/i18n/server';
import { formatNumber } from '@/i18n/format';
import { Topbar } from '@/components/shell/topbar';
import { Icon } from '@/components/ui/icons';
import { AccountForm } from '@/components/settings/account-form';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.settings.title };
}

/** `/settings?tab=account|billing`. Billing is a placeholder until step 3 (the insufficient-credits dialog links here). */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = (await currentUser())!;
  const { t, locale } = await serverMessages();
  const tab = (await searchParams).tab === 'billing' ? 'billing' : 'account';
  const s = t.settings;
  return (
    <>
      <Topbar
        crumbs={[{ label: t.dashboard.title, href: '/dashboard' }, { label: s.title }]}
        tabsLabel={s.tabs.label}
        tabs={[
          { label: s.tabs.account, href: '/settings?tab=account', active: tab === 'account', icon: 'user' },
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

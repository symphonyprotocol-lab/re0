'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/client';
import { Icon, type IconName } from '@/components/ui/icons';
import { LanguageToggle } from '@/components/ui/language-toggle';
import { AdministratorsButton } from '@/components/admin/administrators-dialog';

type NavKey = 'overview' | 'users' | 'verifications' | 'purchases' | 'rees' | 'models' | 'audit' | 'kyc' | 'payouts' | 'payout-history';

const NAV: { key: NavKey; icon: IconName; group: 'platform' | 'trust' | 'governance' }[] = [
  { key: 'overview', icon: 'dashboard', group: 'platform' },
  { key: 'users', icon: 'user', group: 'platform' },
  { key: 'rees', icon: 'ree', group: 'platform' },
  { key: 'models', icon: 'layers', group: 'platform' },
  { key: 'verifications', icon: 'shield', group: 'trust' },
  { key: 'kyc', icon: 'user', group: 'trust' },
  { key: 'purchases', icon: 'sparkle', group: 'trust' },
  { key: 'payouts', icon: 'check', group: 'trust' },
  { key: 'payout-history', icon: 'clock', group: 'trust' },
  { key: 'audit', icon: 'list', group: 'governance' },
];

/**
 * The console frame (prototype suite.js `adminShell`): a fixed sidebar with
 * the console's pages grouped as in the prototype, a drawer on phones, and a
 * top bar with language, administrators and sign-out.
 */
export function ConsoleShell({
  email,
  pendingVerifications,
  pendingKyc = 0,
  openPayouts = 0,
  children,
}: {
  email: string;
  pendingVerifications: number;
  /** Step 6: KYC submissions to review and payouts in progress, badged like the verification queue. */
  pendingKyc?: number;
  openPayouts?: number;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const c = t.console;
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  const sidebar = (mobile: boolean) => (
    <aside className={`flex h-full flex-col border-r border-line bg-[#0b1433] text-white ${mobile ? 'w-[264px] max-w-[85vw] shadow-2xl' : 'w-full'}`} aria-label={c.nav.label}>
      <div className="flex h-16 flex-none items-center gap-2 px-5">
        <span className="inline-flex size-7 items-center justify-center rounded-lg bg-blue text-white">
          <Icon name="shield" className="size-4" />
        </span>
        <span className="font-extrabold">{t.common.brand}</span>
        <span className="font-mono text-[10px] tracking-[0.18em] text-white/50">CONSOLE</span>
        {mobile && (
          <button type="button" className="icon-btn ml-auto text-white/70 hover:bg-white/10 hover:text-white" onClick={() => setDrawer(false)} aria-label={c.nav.close}>
            <Icon name="close" />
          </button>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {(['platform', 'trust', 'governance'] as const).map((group) => (
          <div key={group}>
            <p className="px-3 pt-4 pb-2 font-mono text-[10px] tracking-[0.18em] text-white/40">{c.nav[group]}</p>
            {NAV.filter((item) => item.group === group).map((item) => {
              const href = `/admin/${item.key}`;
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={item.key}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition ${active ? 'bg-white/12 text-white' : 'text-white/70 hover:bg-white/8 hover:text-white'}`}
                >
                  <Icon name={item.icon} className="size-[18px] flex-none" />
                  <span className="min-w-0 flex-1 truncate">{c.nav[item.key]}</span>
                  {item.key === 'verifications' && pendingVerifications > 0 && (
                    <small className="rounded-full bg-blue px-1.5 font-mono text-[10px] text-white">{pendingVerifications}</small>
                  )}
                  {((item.key === 'kyc' && pendingKyc > 0) || (item.key === 'payouts' && openPayouts > 0)) && (
                    <small className="rounded-full bg-blue px-1.5 font-mono text-[10px] text-white">{item.key === 'kyc' ? pendingKyc : openPayouts}</small>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-white/10 p-3">
        <Link href="/" className="flex h-9 items-center gap-2 rounded-lg px-3 text-[12px] text-white/70 hover:bg-white/8 hover:text-white">
          <Icon name="external" className="size-4" />
          {c.nav.backToSite}
        </Link>
        <p className="truncate px-3 pt-2 text-[11px] text-white/50" title={email}>
          {email}
        </p>
      </div>
    </aside>
  );

  return (
    <div className="min-h-dvh bg-[#f7f8fc]">
      <div className="fixed inset-y-0 left-0 z-30 hidden w-[232px] lg:block">{sidebar(false)}</div>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-label={c.nav.close} className="absolute inset-0 bg-ink/40" onClick={() => setDrawer(false)} tabIndex={-1} />
          <div className="relative h-full w-fit">{sidebar(true)}</div>
        </div>
      )}
      <div className="min-w-0 lg:pl-[232px]">
        <header className="fixed inset-x-0 top-0 z-20 border-b border-line bg-white/95 backdrop-blur lg:left-[232px]">
          <div className="flex h-16 items-center gap-2 px-4 md:px-8">
            <button type="button" className="icon-btn lg:hidden" onClick={() => setDrawer(true)} aria-label={c.nav.open}>
              <Icon name="menu" />
            </button>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{c.nav.home}</span>
            <LanguageToggle />
            <AdministratorsButton />
            <form action="/api/admin/auth/logout" method="post">
              <button type="submit" className="btn-ghost" aria-label={t.admin.signOut} title={t.admin.signOut}>
                <Icon name="logout" className="size-3.5" />
                <span className="hidden sm:inline">{t.admin.signOut}</span>
              </button>
            </form>
          </div>
        </header>
        <div className="h-16" aria-hidden="true" />
        <main className="mx-auto max-w-[1240px] px-4 py-6 md:px-8 md:py-8">{children}</main>
        <footer className="mx-auto max-w-[1240px] px-4 pb-8 font-mono text-[10px] tracking-[0.12em] text-muted md:px-8">{c.footer}</footer>
      </div>
    </div>
  );
}

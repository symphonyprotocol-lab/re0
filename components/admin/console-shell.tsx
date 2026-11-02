'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/client';
import { Icon, type IconName } from '@/components/ui/icons';

type NavKey = 'overview' | 'users' | 'verifications' | 'purchases' | 'rees' | 'models' | 'audit' | 'kyc' | 'payouts' | 'payout-history';

const NAV: { key: NavKey; icon: IconName; group: 'platform' | 'trust' | 'governance' }[] = [
  { key: 'overview', icon: 'dashboard', group: 'platform' },
  { key: 'models', icon: 'layers', group: 'platform' },
  { key: 'users', icon: 'user', group: 'platform' },
  { key: 'verifications', icon: 'shield', group: 'platform' },
  { key: 'kyc', icon: 'user', group: 'trust' },
  { key: 'purchases', icon: 'sparkle', group: 'trust' },
  { key: 'payouts', icon: 'check', group: 'trust' },
  { key: 'payout-history', icon: 'clock', group: 'trust' },
  { key: 'rees', icon: 'ree', group: 'governance' },
  { key: 'audit', icon: 'list', group: 'governance' },
];

interface ConsoleShellState {
  collapsed: boolean;
  toggleCollapsed: () => void;
  openDrawer: () => void;
}

const ConsoleShellContext = createContext<ConsoleShellState>({ collapsed: false, toggleCollapsed: () => {}, openDrawer: () => {} });

/** The rail's folded state and the drawer, for the top bar each page renders (`ConsoleTopbar`). */
export function useConsoleShell(): ConsoleShellState {
  return useContext(ConsoleShellContext);
}

/**
 * The console frame (prototype suite.js `adminShell`): a fixed sidebar with
 * the console's pages grouped as in the prototype, and a drawer on phones.
 * The fixed top bar -- breadcrumbs, tabs, language, administrators and
 * sign-out -- is `ConsoleTopbar`, which every page renders first, as the
 * workspace's pages render `Topbar`. On desktop the sidebar folds to a 68px
 * icon rail; the folded state shares the workspace's `re0_sidebar` cookie
 * (the prototype keeps one `sidebarCollapsed` for both).
 */
export function ConsoleShell({
  email,
  pendingVerifications,
  pendingKyc = 0,
  openPayouts = 0,
  initialCollapsed = false,
  children,
}: {
  email: string;
  initialCollapsed?: boolean;
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
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);
  const toggleCollapsed = () => {
    setCollapsed((value) => {
      document.cookie = `re0_sidebar=${value ? 'open' : 'collapsed'}; path=/; max-age=31536000; samesite=lax`;
      return !value;
    });
  };

  const sidebar = (mobile: boolean) => {
    // The phone drawer is never folded.
    const folded = collapsed && !mobile;
    return (
      <aside id={mobile ? undefined : 'console-sidebar'} className={`flex h-full flex-col border-r border-line bg-[#0b1433] text-white ${mobile ? 'w-[264px] max-w-[85vw] shadow-2xl' : 'w-full'}`} aria-label={c.nav.label}>
        <div className={`flex h-16 flex-none items-center gap-2 ${folded ? 'justify-center px-0' : 'px-5'}`}>
          <span className="inline-flex size-7 flex-none items-center justify-center rounded-lg bg-blue text-white">
            <Icon name="shield" className="size-4" />
          </span>
          {!folded && <span className="font-extrabold">{t.common.brand}</span>}
          {!folded && <span className="font-mono text-[10px] tracking-[0.18em] text-white/50">CONSOLE</span>}
          {mobile && (
            <button type="button" className="icon-btn ml-auto text-white/70 hover:bg-white/10 hover:text-white" onClick={() => setDrawer(false)} aria-label={c.nav.close}>
              <Icon name="close" />
            </button>
          )}
        </div>
        <nav className={`flex-1 overflow-y-auto pb-4 ${folded ? 'px-2' : 'px-3'}`}>
          {(['platform', 'trust', 'governance'] as const).map((group) => (
            <div key={group}>
              {folded ? (
                <hr className="mx-2 my-3 border-white/10" />
              ) : (
                <p className="px-3 pt-4 pb-2 font-mono text-[10px] tracking-[0.18em] text-white/40">{c.nav[group]}</p>
              )}
              {NAV.filter((item) => item.group === group).map((item) => {
                const href = `/admin/${item.key}`;
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link
                    key={item.key}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    title={folded ? c.nav[item.key] : undefined}
                    className={`relative flex h-10 items-center gap-3 rounded-lg text-[13px] font-medium transition ${folded ? 'justify-center px-0' : 'px-3'} ${active ? 'bg-white/12 text-white' : 'text-white/70 hover:bg-white/8 hover:text-white'}`}
                  >
                    <Icon name={item.icon} className="size-[18px] flex-none" />
                    {folded ? (
                      <span className="sr-only">{c.nav[item.key]}</span>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{c.nav[item.key]}</span>
                    )}
                    {badge(item.key) > 0 &&
                      (folded ? (
                        <i className="absolute top-1.5 right-1.5 size-2 rounded-full bg-blue" aria-hidden="true" />
                      ) : (
                        <small className="rounded-full bg-blue px-1.5 font-mono text-[10px] text-white">{badge(item.key)}</small>
                      ))}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className={`border-t border-white/10 ${folded ? 'px-2 py-3' : 'p-3'}`}>
          <Link
            href="/"
            title={folded ? c.nav.backToSite : undefined}
            className={`flex h-9 items-center gap-2 rounded-lg text-[12px] text-white/70 hover:bg-white/8 hover:text-white ${folded ? 'justify-center px-0' : 'px-3'}`}
          >
            <Icon name="external" className="size-4 flex-none" />
            {folded ? <span className="sr-only">{c.nav.backToSite}</span> : c.nav.backToSite}
          </Link>
          {!folded && (
            <p className="truncate px-3 pt-2 text-[11px] text-white/50" title={email}>
              {email}
            </p>
          )}
        </div>
      </aside>
    );
  };

  const badge = (key: NavKey) => (key === 'verifications' ? pendingVerifications : key === 'kyc' ? pendingKyc : key === 'payouts' ? openPayouts : 0);

  return (
    <ConsoleShellContext.Provider value={{ collapsed, toggleCollapsed, openDrawer: () => setDrawer(true) }}>
      <div className="min-h-dvh bg-[#f7f8fc]" style={{ ['--console-sidebar' as string]: collapsed ? '68px' : '232px' }}>
        <div className="fixed inset-y-0 left-0 z-30 hidden w-[var(--console-sidebar)] transition-[width] lg:block">{sidebar(false)}</div>
        {drawer && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <button type="button" aria-label={c.nav.close} className="absolute inset-0 bg-ink/40" onClick={() => setDrawer(false)} tabIndex={-1} />
            <div className="relative h-full w-fit">{sidebar(true)}</div>
          </div>
        )}
        <div className="min-w-0 transition-[padding] lg:pl-[var(--console-sidebar)]">
          {/* The page's ConsoleTopbar comes first in <main> and brings its own spacer. */}
          <main className="mx-auto max-w-[1240px] px-4 py-6 md:px-8 md:py-8">{children}</main>
          <footer className="mx-auto max-w-[1240px] px-4 pb-8 font-mono text-[10px] tracking-[0.12em] text-muted md:px-8">{c.footer}</footer>
        </div>
      </div>
    </ConsoleShellContext.Provider>
  );
}

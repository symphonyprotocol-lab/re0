'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/client';
import { formatNumber } from '@/i18n/format';
import { Icon, type IconName } from '@/components/ui/icons';
import { UserAvatar } from '@/components/ui/ree-avatar';

interface ShellState {
  collapsed: boolean;
  toggleCollapsed: () => void;
  openDrawer: () => void;
}

const ShellContext = createContext<ShellState>({ collapsed: false, toggleCollapsed: () => undefined, openDrawer: () => undefined });

export function useShell(): ShellState {
  return useContext(ShellContext);
}

export interface ShellUser {
  name: string;
  avatar: string | null;
  balance: number;
  reeCount: number;
}

/**
 * The workspace frame (prototype navigation.css): a fixed sidebar that folds
 * to a 68px icon rail on desktop and becomes a drawer on phones. The folded
 * state lives in a cookie so the server renders it without a flash.
 */
export function AppShell({ user, initialCollapsed, children }: { user: ShellUser; initialCollapsed: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawer, setDrawer] = useState(false);
  const pathname = usePathname();
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
  return (
    <ShellContext.Provider value={{ collapsed, toggleCollapsed, openDrawer: () => setDrawer(true) }}>
      <div className="min-h-dvh" style={{ ['--sidebar' as string]: collapsed ? '68px' : '224px' }}>
        <Sidebar user={user} collapsed={collapsed} className="fixed inset-y-0 left-0 z-30 hidden w-[var(--sidebar)] md:flex" />
        {drawer && (
          <div className="fixed inset-0 z-50 md:hidden">
            <button type="button" aria-label="close" className="absolute inset-0 bg-ink/30" onClick={() => setDrawer(false)} tabIndex={-1} />
            <Sidebar user={user} collapsed={false} className="relative flex h-full w-[264px] max-w-[85vw] shadow-2xl" onClose={() => setDrawer(false)} />
          </div>
        )}
        <div className="min-w-0 md:pl-[var(--sidebar)]">{children}</div>
      </div>
    </ShellContext.Provider>
  );
}

function NavItem({ href, icon, label, active, collapsed, badge }: { href: string; icon: IconName; label: string; active: boolean; collapsed: boolean; badge?: number }) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={`group flex h-10 items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition ${
        active ? 'bg-soft text-blue' : 'text-[#3b4361] hover:bg-wash hover:text-ink'
      } ${collapsed ? 'justify-center px-0' : ''}`}
    >
      <Icon name={icon} className="size-[18px] flex-none" />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && badge !== undefined && <span className="font-mono text-[10px] text-muted">{badge}</span>}
      {collapsed && <span className="sr-only">{label}</span>}
    </Link>
  );
}

function Sidebar({ user, collapsed, className, onClose }: { user: ShellUser; collapsed: boolean; className: string; onClose?: () => void }) {
  const { t, locale } = useI18n();
  const pathname = usePathname();
  return (
    <aside className={`${className} flex-col border-r border-line bg-[#fbfaff]`} aria-label={t.common.nav.main}>
      <div className={`flex h-16 flex-none items-center gap-2 px-4 ${collapsed ? 'justify-center px-0' : ''}`}>
        <Link href="/dashboard" className="flex items-center gap-2 font-extrabold tracking-tight">
          <span className="inline-flex size-8 items-center justify-center rounded-lg bg-blue text-white">
            <Icon name="ree" className="size-5" />
          </span>
          {!collapsed && <span className="text-[17px]">{t.common.brand}</span>}
        </Link>
        {onClose && (
          <button type="button" className="icon-btn ml-auto" onClick={onClose} aria-label={t.common.nav.closeMenu}>
            <Icon name="close" />
          </button>
        )}
      </div>
      <nav className={`flex flex-col gap-1 px-3 ${collapsed ? 'px-2' : ''}`}>
        <NavItem href="/dashboard" icon="dashboard" label={t.common.nav.dashboard} active={pathname === '/dashboard'} collapsed={collapsed} />
        <NavItem href="/rees" icon="ree" label={t.common.nav.rees} active={pathname.startsWith('/rees')} collapsed={collapsed} badge={user.reeCount} />
      </nav>
      <div className="flex-1" />
      <div className={`flex flex-col gap-2 border-t border-line p-3 ${collapsed ? 'items-center px-2' : ''}`}>
        {!collapsed && (
          <Link href="/settings?tab=billing" className="block rounded-xl border border-line bg-white px-3 py-2.5 hover:border-[#c4cce0]">
            <span className="flex items-center justify-between text-[11px] font-semibold text-muted">
              {t.common.account.free}
              <span className="text-blue">{t.common.account.upgrade}</span>
            </span>
            <span className="mt-1 flex items-baseline gap-1">
              <strong className="font-mono text-[17px] text-ink">{formatNumber(user.balance, locale)}</strong>
              <span className="text-[10px] text-muted">{t.common.units.credits}</span>
            </span>
            <span className="text-[10px] text-muted">{t.common.account.balance}</span>
          </Link>
        )}
        <div className={`flex items-center gap-2 ${collapsed ? 'flex-col' : ''}`}>
          <Link href="/settings?tab=account" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1 hover:bg-wash" title={t.common.account.settings}>
            <UserAvatar avatar={user.avatar} name={user.name} />
            {!collapsed && <span className="min-w-0 truncate text-[13px] font-semibold">{user.name}</span>}
          </Link>
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="icon-btn" aria-label={t.common.account.signOut} title={t.common.account.signOut}>
              <Icon name="logout" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

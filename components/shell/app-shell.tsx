'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { PlanUsage } from '@/lib/domain/billing';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon, type IconName } from '@/components/ui/icons';
import { UserAvatar } from '@/components/ui/ree-avatar';
import { HistoryProvider, SidebarConversations } from '@/components/conversations/sidebar-history';
import type { HistoryItem } from '@/lib/services/conversations';

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
  plan: PlanUsage;
  reeCount: number;
  /** Step 4: the sidebar's pinned and recent conversations. */
  history: HistoryItem[];
  /** Unread in-app notices (step 5): a red dot on the account link, which then opens the notices. */
  unreadNotices: number;
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
      <HistoryProvider>
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
      </HistoryProvider>
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
        <NavItem href="/dashboard" icon="dashboard" label={t.common.nav.dashboard} active={pathname === '/dashboard' || pathname.startsWith('/workspace/')} collapsed={collapsed} />
        <NavItem href="/explore" icon="compass" label={t.discover.nav} active={pathname === '/explore' || pathname.startsWith('/r/')} collapsed={collapsed} />
        <NavItem href="/rees" icon="ree" label={t.common.nav.rees} active={pathname.startsWith('/rees') || pathname === '/videos'} collapsed={collapsed} badge={user.reeCount} />
      </nav>
      <SidebarConversations history={user.history} collapsed={collapsed} />
      <div className={`flex flex-col gap-2 border-t border-line p-3 ${collapsed ? 'items-center px-2' : ''}`}>
        <PlanMeter user={user} collapsed={collapsed} />
        <div className={`flex items-center gap-2 ${collapsed ? 'flex-col' : ''}`}>
          <Link
            href={user.unreadNotices > 0 ? '/settings?tab=notices' : '/settings?tab=account'}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-1 hover:bg-wash"
            aria-label={user.unreadNotices > 0 ? undefined : t.common.account.openSettings}
            title={user.unreadNotices > 0 ? fill(t.notices.unreadCount, { n: user.unreadNotices }) : t.common.account.settings}
          >
            <span className="relative inline-flex flex-none">
              <UserAvatar avatar={user.avatar} name={user.name} />
              {user.unreadNotices > 0 && (
                <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[#fbfaff] bg-red">
                  <span className="sr-only">{fill(t.notices.unreadCount, { n: user.unreadNotices })}</span>
                </span>
              )}
            </span>
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold">{user.name}</span>
                <span className="block truncate text-[11px] text-muted">{t.common.account.subtitle}</span>
              </span>
            )}
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

/**
 * The sidebar's usage card (prototype usage.js `sidebar`): with a Plan, this
 * period's credits used out of 100,000 and a meter that turns red from 90%;
 * without one, the balance and the way to subscribe. Folded, an icon whose
 * title carries the same summary.
 */
function PlanMeter({ user, collapsed }: { user: ShellUser; collapsed: boolean }) {
  const { t, locale } = useI18n();
  const a = t.common.account;
  const plan = user.plan;
  const n = (value: number) => formatNumber(value, locale);
  const membership = plan.active ? a.member : a.free;
  const status = plan.active ? (plan.cancelAtPeriodEnd ? a.ending : a.active) : a.upgrade;
  const summary = plan.active
    ? fill(a.summaryPlan, { used: n(plan.used), allowance: n(plan.allowance), remaining: n(plan.remaining) })
    : fill(a.summaryFree, { total: n(user.balance) });
  if (collapsed) {
    return (
      <Link
        href="/settings?tab=billing"
        title={`${membership} · ${status}\n${summary}`}
        aria-label={`${membership} · ${status} · ${summary}`}
        className={`inline-flex size-10 items-center justify-center rounded-lg border ${plan.warn ? 'border-[#f1d4d4] bg-[#fff3f3] text-red' : 'border-line bg-white text-blue'} hover:border-[#c4cce0]`}
      >
        <Icon name="sparkle" className="size-[18px]" />
      </Link>
    );
  }
  return (
    <Link
      href="/settings?tab=billing"
      aria-label={`${membership} · ${status} · ${summary}`}
      className={`block rounded-xl border bg-white px-3 py-2.5 hover:border-[#c4cce0] ${plan.warn ? 'border-[#f1d4d4]' : 'border-line'}`}
    >
      <span className="flex items-center justify-between gap-2 text-[11px] font-semibold">
        <span className={plan.active ? 'text-blue' : 'text-muted'}>{membership}</span>
        <span className={plan.active ? (plan.cancelAtPeriodEnd ? 'text-orange' : 'text-green') : 'text-blue'}>{status}</span>
      </span>
      {plan.active ? (
        <>
          <span className="mt-1.5 flex items-baseline justify-between gap-2 text-[10px] text-muted">
            {a.usedOfAllowance}
            <small className="text-[10px]">{t.common.units.credits}</small>
          </span>
          <span className="mt-0.5 flex items-baseline gap-1">
            <small className="text-[10px] text-muted">{a.used}</small>
            <strong className={`font-mono text-[16px] ${plan.warn ? 'text-red' : 'text-ink'}`}>{n(plan.used)}</strong>
            <span className="font-mono text-[10px] text-muted">/ {n(plan.allowance)}</span>
          </span>
          <span
            role="meter"
            aria-label={a.meter}
            aria-valuemin={0}
            aria-valuemax={plan.allowance}
            aria-valuenow={plan.used}
            aria-valuetext={summary}
            className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-[#edf0f6]"
          >
            <i className={`block h-full rounded-full ${plan.warn ? 'bg-red' : 'bg-blue'}`} style={{ width: `${plan.percent}%` }} />
          </span>
          <span className="mt-1.5 flex items-center justify-between text-[10px] text-muted">
            {fill(a.remaining, { n: n(plan.remaining) })}
            <Icon name="arrow" className="size-3" />
          </span>
        </>
      ) : (
        <>
          <span className="mt-1.5 flex items-baseline justify-between gap-2 text-[10px] text-muted">
            {a.balance}
            <small className="text-[10px]">{t.common.units.credits}</small>
          </span>
          <span className="mt-0.5 flex items-baseline gap-1">
            <small className="text-[10px] text-muted">{a.balanceShort}</small>
            <strong className="font-mono text-[17px] text-ink">{n(user.balance)}</strong>
          </span>
          <span className="flex items-center justify-between text-[10px] text-muted">
            {a.noAllowance}
            <Icon name="arrow" className="size-3" />
          </span>
        </>
      )}
    </Link>
  );
}

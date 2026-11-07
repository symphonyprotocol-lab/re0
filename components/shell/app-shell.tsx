'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { PlanUsage } from '@/lib/domain/billing';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { BrandMark, BrandName } from '@/components/ui/brand-mark';
import { Icon, type IconName } from '@/components/ui/icons';
import { UserAvatar } from '@/components/ui/ree-avatar';
import { HistoryProvider, SidebarConversations } from '@/components/conversations/sidebar-history';
import type { HistoryItem } from '@/lib/services/conversations';
import { WorkspaceMain } from '@/components/shell/workspace-main';
import './shell.css';

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

const PHONE = '(max-width: 760px)';

/**
 * The workspace frame (prototype app.js `shell`, conversations.js `sidebar`,
 * styles in ./shell.css): a fixed 252px sidebar that folds to a 68px icon
 * rail on desktop and slides in as a drawer on phones, and the main column
 * the fixed top bar sits over. The folded state lives in a cookie so the
 * server renders it without a flash.
 */
export function AppShell({ user, initialCollapsed, children }: { user: ShellUser; initialCollapsed: boolean; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [phone, setPhone] = useState(false);
  const pathname = usePathname();
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const sync = () => setPhone(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  /* The open drawer closes on Escape and on a tap beside it (prototype app.js); that tap only closes it, it does not also press what lies under the dimmed page. */
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setDrawer(false);
    const swallow = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element;
      if (target.closest('#sidebar') || target.closest('.mobile-menu')) return;
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', swallow, { capture: true }), 500);
      setDrawer(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
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
        <Sidebar user={user} collapsed={collapsed} phone={phone} open={drawer} hidden={phone && !drawer} onClose={() => setDrawer(false)} />
        <WorkspaceMain collapsed={collapsed}>{children}</WorkspaceMain>
      </HistoryProvider>
    </ShellContext.Provider>
  );
}

function NavItem({ href, icon, label, active, count }: { href: string; icon: IconName; label: string; active: boolean; count?: number }) {
  return (
    <Link href={href} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined} aria-label={label} title={label}>
      <Icon name={icon} className="" />
      <span>{label}</span>
      {count !== undefined && <span className="nav-count">{count}</span>}
    </Link>
  );
}

function Sidebar({ user, collapsed, phone, open, hidden, onClose }: { user: ShellUser; collapsed: boolean; phone: boolean; open: boolean; hidden: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const nav = t.common.nav;
  return (
    <aside
      id="sidebar"
      className={`sidebar sidebar-chat${collapsed ? ' is-collapsed' : ''}${open ? ' mobile-open' : ''}`}
      aria-label={nav.main}
      inert={hidden}
    >
      <Link href="/" className="wordmark" aria-label={nav.home}>
        <BrandMark />
        <BrandName />
      </Link>
      <button type="button" className="icon-btn sidebar-close" onClick={onClose} aria-label={nav.closeMenu} title={nav.closeMenu}>
        <Icon name="close" className="" />
      </button>
      {/* The fold only applies on desktop: the phone drawer always shows the history. The aside carries the side padding. */}
      <SidebarConversations history={user.history} collapsed={collapsed && !phone} className="" />
      <nav className="nav chat-product-nav" aria-label={nav.workspace}>
        <NavItem href="/explore" icon="compass" label={t.discover.nav} active={pathname === '/explore' || pathname.startsWith('/r/')} />
        <NavItem href="/rees" icon="ree" label={nav.rees} active={pathname.startsWith('/rees') || pathname.startsWith('/workspace') || pathname === '/videos'} count={user.reeCount} />
      </nav>
      <div className="chat-sidebar-footer sidebar-account-footer">
        <PlanMeter user={user} />
        <div className="user-row">
          <Link
            href={user.unreadNotices > 0 ? '/settings?tab=notices' : '/settings?tab=account'}
            className="user-settings-link"
            aria-label={user.unreadNotices > 0 ? undefined : t.common.account.openSettings}
            title={user.unreadNotices > 0 ? fill(t.notices.unreadCount, { n: user.unreadNotices }) : t.common.account.settings}
          >
            <span className="avatar">
              <UserAvatar avatar={user.avatar} name={user.name} className="size-full" />
              {user.unreadNotices > 0 && (
                <span className="notice-dot">
                  <span className="sr-only">{fill(t.notices.unreadCount, { n: user.unreadNotices })}</span>
                </span>
              )}
            </span>
            <div className="grow">
              <strong>{user.name}</strong>
              <p>{t.common.account.subtitle}</p>
            </div>
          </Link>
          <form action="/api/auth/logout" method="post" className="contents">
            <button type="submit" className="icon-btn" aria-label={t.common.account.signOut} title={t.common.account.signOut}>
              <Icon name="logout" className="" />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

/**
 * The sidebar's usage card (prototype usage.js `sidebar`): with a Plan, this
 * period's credits used and a meter that turns amber from
 * 90%; without one, the balance. Folded, only its icon shows, and the title
 * carries the same summary.
 */
function PlanMeter({ user }: { user: ShellUser }) {
  const { t, locale } = useI18n();
  const a = t.common.account;
  const plan = user.plan;
  const n = (value: number) => formatNumber(value, locale);
  const membership = plan.active ? a.member : a.free;
  const status = plan.active ? (plan.cancelAtPeriodEnd ? a.ending : a.active) : a.upgrade;
  const summary = plan.active
    ? fill(a.summaryPlan, { used: n(plan.used), allowance: n(plan.allowance), remaining: n(plan.remaining) })
    : fill(a.summaryFree, { total: n(user.balance) });
  return (
    <Link
      href="/settings?tab=balance"
      className={`sidebar-usage ${plan.active ? 'is-member' : 'is-free'}${plan.warn ? ' is-low' : ''}`}
      aria-label={`${membership} · ${status} · ${summary}`}
      title={`${membership} · ${status}\n${summary}`}
    >
      <span className="sidebar-usage-icon">
        <Icon name="sparkle" className="" />
      </span>
      <div className="sidebar-usage-head">
        <strong>{membership}</strong>
        <span className={plan.active && plan.cancelAtPeriodEnd ? 'ending' : undefined}>{status}</span>
      </div>
      {plan.active ? (
        <>
          <div className="sr-only">
            {a.usedOfAllowance} {t.common.units.credits}
          </div>
          <div className="sidebar-usage-amount">
            <small>{a.used}</small>
            <strong>{n(plan.used)}</strong>
            <span>/ {n(plan.allowance)}</span>
          </div>
          <div
            className="sidebar-usage-meter"
            role="meter"
            aria-label={a.meter}
            aria-valuemin={0}
            aria-valuemax={plan.allowance}
            aria-valuenow={plan.used}
            aria-valuetext={summary}
          >
            <i style={{ width: `${plan.percent}%` }} />
          </div>
          <div className="sidebar-usage-foot">
            <span>{fill(a.remaining, { n: n(plan.remaining) })}</span>
          </div>
        </>
      ) : (
        <>
          <div className="sr-only">
            {a.balance} {t.common.units.credits}
          </div>
          <div className="sidebar-usage-amount">
            <small>{a.balanceShort}</small>
            <strong>{n(user.balance)}</strong>
          </div>
          <div className="sidebar-usage-foot">
            <span>{a.noAllowance}</span>
          </div>
        </>
      )}
    </Link>
  );
}

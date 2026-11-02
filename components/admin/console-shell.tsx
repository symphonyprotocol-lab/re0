'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '@/i18n/client';
import { formatNumber } from '@/i18n/format';
import { CI, type ConsoleIconName } from '@/components/admin/console-icon';
import './console.css';

type NavKey = 'overview' | 'users' | 'verifications' | 'purchases' | 'rees' | 'models' | 'audit' | 'kyc' | 'payouts' | 'payout-history';
export type ConsoleEnvironment = 'production' | 'preview' | 'development';

/* Prototype suite.js `adminNav`: order, icons, and the group labels before the 5th and 9th entries. */
const NAV: { key: NavKey; icon: ConsoleIconName }[] = [
  { key: 'overview', icon: 'layers' },
  { key: 'models', icon: 'code' },
  { key: 'users', icon: 'users' },
  { key: 'verifications', icon: 'shield' },
  { key: 'kyc', icon: 'shield' },
  { key: 'purchases', icon: 'wallet' },
  { key: 'payouts', icon: 'check' },
  { key: 'payout-history', icon: 'clock' },
  { key: 'rees', icon: 'dot' },
  { key: 'audit', icon: 'file' },
];

interface ConsoleShellState {
  collapsed: boolean;
  environment: ConsoleEnvironment;
  toggleCollapsed: () => void;
  openDrawer: () => void;
}

const ConsoleShellContext = createContext<ConsoleShellState>({ collapsed: false, environment: 'production', toggleCollapsed: () => {}, openDrawer: () => {} });

/** The rail's folded state and the drawer, for the top bar each page renders (`ConsoleTopbar`). */
export function useConsoleShell(): ConsoleShellState {
  return useContext(ConsoleShellContext);
}

/** The RE0 mark beside the name (prototype `wordmark()`, icon.svg). */
export function ConsoleWordmark({ label }: { label: string }) {
  return (
    <Link className="wordmark" href="/" aria-label={label}>
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="10.6667" fill="#127ee3" />
        <g fill="#ffffff" stroke="#ffffff" strokeWidth="1" strokeLinejoin="round">
          <path d="M17.25 8.91 A 7.2 7.2 0 1 0 23.2 16" fill="none" strokeWidth="3" />
          <circle cx="17.25" cy="8.91" r="1.5" stroke="none" />
          <path d="M23.2 11.4 L 25.75 16 L 20.65 16 Z" />
          <circle cx="16" cy="16" r="2.5" stroke="none" />
        </g>
      </svg>
      <span>RE0</span>
    </Link>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : (words[0] ?? 'AD').slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The console frame (prototype suite.js `adminShell`, suite.css
 * `.console-*`, navigation.css): the sidebar with the console's pages in the
 * prototype's groups, the environment, the way back to the site and the
 * signed-in administrator with sign-out; on phones it opens as a drawer from
 * the top bar's menu button. On desktop it folds to an icon rail; the folded
 * state shares the workspace's `re0_sidebar` cookie (the prototype keeps one
 * `sidebarCollapsed` for both). Each page renders its fixed top bar and its
 * content through `ConsolePage`, inside `.console-main`.
 */
export function ConsoleShell({
  name,
  email,
  environment,
  pendingVerifications,
  openPayouts = 0,
  initialCollapsed = false,
  children,
}: {
  name: string;
  email: string;
  environment: ConsoleEnvironment;
  initialCollapsed?: boolean;
  pendingVerifications: number;
  openPayouts?: number;
  children: ReactNode;
}) {
  const { t, locale } = useI18n();
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
  const badge = (key: NavKey) => (key === 'verifications' ? pendingVerifications : key === 'payouts' ? openPayouts : null);

  return (
    <ConsoleShellContext.Provider value={{ collapsed, environment, toggleCollapsed, openDrawer: () => setDrawer(true) }}>
      <div className="console-app">
        <aside className={`console-sidebar ${collapsed ? 'is-collapsed' : ''} ${drawer ? 'mobile-open' : ''}`} id="sidebar">
          <div className="console-brand">
            <ConsoleWordmark label={t.common.brand} />
            <span>CONSOLE</span>
          </div>
          <button type="button" className="icon-btn sidebar-close" aria-label={c.nav.close} title={c.nav.close} onClick={() => setDrawer(false)}>
            <CI name="close" />
          </button>
          <div className="console-workspace">
            <span>
              <CI name="shield" />
            </span>
            <div>
              <strong>{c.nav.workspace}</strong>
              <small>{c.nav.environment[environment]}</small>
            </div>
          </div>
          <p className="nav-label">{c.nav.platform}</p>
          <nav aria-label={c.nav.label}>
            {NAV.map((item, index) => {
              const href = `/admin/${item.key}`;
              const active = pathname === href || pathname.startsWith(`${href}/`);
              const count = badge(item.key);
              return (
                <Fragment key={item.key}>
                  {index === 4 && <p className="nav-label">{c.nav.trust}</p>}
                  {index === 8 && <p className="nav-label">{c.nav.governance}</p>}
                  <Link href={href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined}>
                    <CI name={item.icon} />
                    <span>{c.nav[item.key]}</span>
                    {count !== null && <small>{formatNumber(count, locale)}</small>}
                  </Link>
                </Fragment>
              );
            })}
          </nav>
          <div className="console-sidebar-bottom">
            <div className="console-status">
              <i className="dot" />
              {c.nav.session}
            </div>
            <Link href="/" className="console-back">
              <CI name="external" />
              {c.nav.backToSite}
            </Link>
            <div className="console-user">
              <span className="avatar">{initials(name)}</span>
              <div>
                <strong>{name}</strong>
                <small>{email}</small>
              </div>
              <form action="/api/admin/auth/logout" method="post" style={{ display: 'contents' }}>
                <button type="submit" className="icon-btn" aria-label={c.nav.signOut} title={c.nav.signOut}>
                  <CI name="logout" />
                </button>
              </form>
            </div>
          </div>
        </aside>
        <div className={`console-main ${collapsed ? 'sidebar-collapsed' : ''}`}>{children}</div>
      </div>
    </ConsoleShellContext.Provider>
  );
}

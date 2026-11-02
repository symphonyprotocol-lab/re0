'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';
import { LanguageToggle } from '@/components/ui/language-toggle';
import { AdministratorsButton } from '@/components/admin/administrators-dialog';
import { useConsoleShell } from '@/components/admin/console-shell';

export interface Crumb {
  label: string;
  href?: string;
}

export interface ConsoleTab {
  label: string;
  href: string;
  active: boolean;
}

/**
 * The console's fixed top bar (prototype suite.js `consoleHeader` /
 * `adminShell`, navigation.css), which every console page renders first,
 * as the workspace's pages render `Topbar`: the menu or rail toggle, the
 * breadcrumbs -- the way back, by clicking a parent's name -- then page
 * actions, language, administrators and sign-out. An optional second row
 * (prototype `.context-nav-row`) holds a page's tabs as links, or other
 * controls such as a source's previous / next; it scrolls sideways on a
 * phone with the active tab kept in view. The bar brings its own in-flow
 * spacer, one or two rows tall, so content always starts below it. On a
 * phone only the last two crumbs show: the way back and the current page.
 */
export function ConsoleTopbar({
  crumbs,
  tabs,
  tabsLabel,
  secondRow,
  actions,
}: {
  crumbs: Crumb[];
  tabs?: ConsoleTab[];
  tabsLabel?: string;
  secondRow?: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const c = t.console;
  const { collapsed, toggleCollapsed, openDrawer } = useConsoleShell();
  const hasRow = Boolean(tabs?.length || secondRow);
  const last = crumbs.length - 1;
  return (
    <>
      <header data-console-topbar className="fixed inset-x-0 top-0 z-20 border-b border-line bg-white/95 backdrop-blur transition-[left] lg:left-[var(--console-sidebar)]">
        <div className="flex h-16 items-center gap-2 px-4 md:px-8">
          <button type="button" className="icon-btn flex-none lg:hidden" onClick={openDrawer} aria-label={c.nav.open}>
            <Icon name="menu" />
          </button>
          <button
            type="button"
            className="icon-btn hidden flex-none lg:inline-flex"
            onClick={toggleCollapsed}
            aria-controls="console-sidebar"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t.common.nav.expand : t.common.nav.collapse}
            title={collapsed ? t.common.nav.expand : t.common.nav.collapse}
          >
            <Icon name="panel" />
          </button>
          <nav aria-label={c.nav.breadcrumb} className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] sm:gap-2 sm:text-[13px]">
            {crumbs.map((crumb, index) => (
              <span
                key={`${crumb.label}-${index}`}
                className={`flex min-w-0 items-center gap-1.5 sm:gap-2 ${index < last - 1 ? 'hidden sm:flex' : ''} ${
                  index < last ? 'max-w-[45%] flex-none sm:max-w-[200px] sm:flex-[0_2_auto]' : ''
                }`}
              >
                {index > 0 && <Icon name="chevronRight" className={`size-3 flex-none text-[#a3a9bb] ${index === last - 1 ? 'hidden sm:block' : ''}`} />}
                {crumb.href && index < last ? (
                  <Link href={crumb.href} className="truncate text-muted hover:text-blue" title={crumb.label}>
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="truncate font-semibold" aria-current={index === last ? 'page' : undefined} title={crumb.label}>
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
          <div className="flex flex-none items-center gap-1.5 sm:gap-2">
            {actions}
            <LanguageToggle />
            <AdministratorsButton />
            <form action="/api/admin/auth/logout" method="post">
              <button type="submit" className="btn-ghost" aria-label={t.admin.signOut} title={t.admin.signOut}>
                <Icon name="logout" className="size-3.5" />
                <span className="hidden sm:inline">{t.admin.signOut}</span>
              </button>
            </form>
          </div>
        </div>
        {hasRow && (
          <div className="flex h-11 items-stretch gap-1 overflow-x-auto overscroll-x-contain border-t border-[#eceff6] px-2 [scrollbar-width:none] md:px-6 [&::-webkit-scrollbar]:hidden">
            {tabs?.length ? (
              <nav aria-label={tabsLabel} className="flex items-stretch gap-1">
                {tabs.map((tab) => (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    aria-current={tab.active ? 'page' : undefined}
                    ref={(node) => {
                      if (node && tab.active) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    }}
                    className={`flex flex-none items-center border-b-2 px-3 text-[13px] font-medium whitespace-nowrap ${
                      tab.active ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'
                    }`}
                  >
                    {tab.label}
                  </Link>
                ))}
              </nav>
            ) : (
              secondRow
            )}
          </div>
        )}
      </header>
      <div aria-hidden="true" className={hasRow ? 'h-[108px]' : 'h-16'} />
    </>
  );
}

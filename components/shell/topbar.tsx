'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { Fragment, type ReactNode } from 'react';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';
import { useShell } from '@/components/shell/app-shell';

export interface Crumb {
  label: string;
  href?: string;
}

export interface ContextTab {
  label: string;
  href: string;
  active: boolean;
  icon?: Parameters<typeof Icon>[0]['name'];
}

/**
 * The fixed top bar every workspace page renders first (prototype app.js
 * `shell` / `workspaceHeader`, styles in ./shell.css): the menu and
 * fold buttons, breadcrumbs (the way back up), page actions, and an optional context row -- a Ree's tabs, the settings tabs,
 * or the wizard's steps -- that scrolls sideways on a phone. It also renders
 * its own in-flow spacer, so content always starts below it. On a phone the
 * crumbs shrink to fit, and with three or more the first one is left out.
 *
 * `mobileBack` is a Ree's pages on a phone (prototype `.ree-workspace-shell`):
 * the first row is only ← back and the Ree's name, and
 * `rowActions` (the public page link, a source's previous / next) sit at the
 * end of the context row at every width.
 */
export function Topbar({
  crumbs,
  tabs,
  tabsLabel,
  secondRow,
  actions,
  rowActions,
  mobileBack,
}: {
  crumbs: Crumb[];
  tabs?: ContextTab[];
  tabsLabel?: string;
  secondRow?: ReactNode;
  actions?: ReactNode;
  rowActions?: ReactNode;
  mobileBack?: { href: string; label: string; title: string };
}) {
  const { t } = useI18n();
  const { collapsed, toggleCollapsed, openDrawer, activitiesPending } = useShell();
  const nav = t.common.nav;
  const hasRow = Boolean(tabs?.length || secondRow);
  return (
    <>
      <header data-topbar className={`topbar${mobileBack ? ' ree-workspace-shell' : ''}`}>
        <div className="topbar-main">
          <div className="topbar-location">
            <button
              type="button"
              className="icon-btn mobile-menu"
              onClick={openDrawer}
              aria-label={activitiesPending ? `${nav.openMenu} · ${nav.activitiesPending}` : nav.openMenu}
              title={nav.openMenu}
            >
              <Icon name="menu" className="" />
              {activitiesPending && <i className="nav-dot" aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="icon-btn sidebar-collapse"
              onClick={toggleCollapsed}
              aria-controls="sidebar"
              aria-expanded={!collapsed}
              aria-label={collapsed ? nav.expand : nav.collapse}
              title={collapsed ? nav.expand : nav.collapse}
            >
              <Icon name={collapsed ? 'panelOpen' : 'panelClose'} className="" />
            </button>
            {mobileBack && (
              <div className="ree-mobile-location">
                <Link href={mobileBack.href} className="ree-mobile-back" aria-label={mobileBack.title} title={mobileBack.title}>
                  <Icon name="arrowLeft" className="" />
                </Link>
                <span title={mobileBack.label}>{mobileBack.label}</span>
              </div>
            )}
            <nav className="header-breadcrumbs" aria-label={nav.breadcrumb}>
              {crumbs.map((crumb, index) => {
                const last = index === crumbs.length - 1;
                return (
                  <Fragment key={`${crumb.label}-${index}`}>
                    {index > 0 && <Icon name="chevronRight" className="" />}
                    {crumb.href && !last ? (
                      <Link href={crumb.href} title={crumb.label}>
                        {crumb.label}
                      </Link>
                    ) : (
                      <span aria-current={last ? 'page' : undefined} title={crumb.label}>
                        {crumb.label}
                      </span>
                    )}
                  </Fragment>
                );
              })}
            </nav>
          </div>
          <div className="topbar-right">
            {/* No language or 返回官网 here (v6): the language is in the sidebar's last line, the site is the shell itself. */}
            {actions && <div className="flex items-center gap-2">{actions}</div>}
          </div>
        </div>
        {hasRow && (
          <div className="context-nav-row">
            {tabs ? (
              <nav aria-label={tabsLabel} className="header-tabs">
                {tabs.map((tab) => (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    icon={tab.icon}
                    className={tab.active ? 'active' : undefined}
                    aria-current={tab.active ? 'page' : undefined}
                    ref={(node) => {
                      if (node && tab.active) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    }}
                  >
                    {tab.label}
                  </Link>
                ))}
              </nav>
            ) : (
              secondRow
            )}
            {rowActions && <div className="context-nav-actions">{rowActions}</div>}
          </div>
        )}
      </header>
      <div aria-hidden="true" className="topbar-spacer" />
    </>
  );
}

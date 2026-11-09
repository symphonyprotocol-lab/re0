'use client';

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { Children, Fragment, type ReactNode } from 'react';
import { useI18n } from '@/i18n/client';
import { LanguageToggle } from '@/components/ui/language-toggle';
import { CI } from '@/components/admin/console-icon';
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
 * `adminShell`, navigation.css `.console-topbar`): the phone menu and the rail
 * toggle, the breadcrumbs -- the way back, by clicking a parent's name -- then
 * page actions, the environment and language. An optional
 * second row (`.context-nav-row`) holds a page's tabs as links, or other
 * controls; it scrolls sideways on a phone with the active tab kept in view.
 * Rendered as the first child of `ConsolePage`, which puts it beside the
 * page's `main`, where the prototype's fixed positioning expects it.
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
  const { collapsed, environment, toggleCollapsed, openDrawer } = useConsoleShell();
  const last = crumbs.length - 1;
  const toggleLabel = collapsed ? t.common.nav.expand : t.common.nav.collapse;
  return (
    <header className="console-topbar">
      <div className="topbar-main">
        <div className="topbar-location">
          <button type="button" className="icon-btn mobile-menu" onClick={openDrawer} aria-label={c.nav.open} title={c.nav.open}>
            <CI name="menu" />
          </button>
          <button
            type="button"
            className="icon-btn sidebar-collapse"
            onClick={toggleCollapsed}
            aria-controls="sidebar"
            aria-expanded={!collapsed}
            aria-label={toggleLabel}
            title={toggleLabel}
          >
            <CI name={collapsed ? 'panel-open' : 'panel-close'} />
          </button>
          <nav className="header-breadcrumbs" aria-label={c.nav.breadcrumb}>
            {crumbs.map((crumb, index) => (
              <Fragment key={`${crumb.label}-${index}`}>
                {index > 0 && <CI name="chevron" />}
                {crumb.href && index < last ? (
                  <Link href={crumb.href} title={crumb.label}>
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current={index === last ? 'page' : undefined} title={crumb.label}>
                    {crumb.label}
                  </span>
                )}
              </Fragment>
            ))}
          </nav>
        </div>
        <div className={`flex console-header-tools ${actions ? 'has-page-actions' : ''}`}>
          {actions}
          <span className="console-environment">
            <i className="dot" /> {c.nav.environmentBadge[environment]}
          </span>
          <LanguageToggle className="btn ghost sm" icon={false} />
        </div>
      </div>
      {tabs?.length ? (
        <div className="context-nav-row">
          <nav className="header-tabs console-detail-tabs" aria-label={tabsLabel}>
            {tabs.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                className={tab.active ? 'active' : ''}
                aria-current={tab.active ? 'page' : undefined}
                ref={(node) => {
                  if (node && tab.active) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                }}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
        </div>
      ) : secondRow ? (
        <div className="context-nav-row">{secondRow}</div>
      ) : null}
    </header>
  );
}

/**
 * A console page: its `ConsoleTopbar` (the first child) beside the page's
 * `main.console-content` (the rest), which ends with the console's foot line
 * (prototype `.console-foot`).
 */
export function ConsolePage({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [topbar, ...content] = Children.toArray(children);
  return (
    <>
      {topbar}
      <main id="main" tabIndex={-1} className="console-content">
        {content}
        <div className="console-foot">
          <span>{t.console.footer}</span>
          <Link href="/admin/audit" className="btn ghost sm">
            {t.console.nav.auditLink}
          </Link>
        </div>
      </main>
    </>
  );
}

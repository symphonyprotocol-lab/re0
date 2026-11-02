'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
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
 * The fixed top bar every workspace page renders first: breadcrumbs (the way
 * back up, prototype "顶部面包屑"), page actions, and an optional second row
 * -- a Ree's tabs, the settings tabs, or the wizard's steps -- that scrolls
 * sideways on a phone. It also renders its own in-flow spacer, so content
 * always starts below it.
 */
export function Topbar({ crumbs, tabs, tabsLabel, secondRow, actions }: { crumbs: Crumb[]; tabs?: ContextTab[]; tabsLabel?: string; secondRow?: ReactNode; actions?: ReactNode }) {
  const { t, locale } = useI18n();
  const { collapsed, toggleCollapsed, openDrawer } = useShell();
  const router = useRouter();
  const hasRow = Boolean(tabs?.length || secondRow);
  const switchLanguage = async () => {
    const lang = locale === 'zh' ? 'en' : 'zh';
    await fetch('/api/account', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lang }) });
    router.refresh();
  };
  return (
    <>
      <header className="fixed inset-x-0 top-0 z-20 border-b border-[#e0e5f0] bg-[#faf9fff5] backdrop-blur-md md:left-[var(--sidebar)]">
        <div className="flex h-16 items-center gap-3 px-4 md:px-8">
          <button type="button" className="icon-btn md:hidden" onClick={openDrawer} aria-label={t.common.nav.openMenu}>
            <Icon name="menu" />
          </button>
          <button type="button" className="icon-btn hidden md:inline-flex" onClick={toggleCollapsed} aria-label={collapsed ? t.common.nav.expand : t.common.nav.collapse}>
            <Icon name="panel" />
          </button>
          <nav aria-label="breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
            {crumbs.map((crumb, index) => (
              <span key={`${crumb.label}-${index}`} className={`flex min-w-0 items-center gap-2 ${index < crumbs.length - 1 ? 'hidden sm:flex' : ''}`}>
                {index > 0 && <Icon name="chevronRight" className="hidden size-3 flex-none text-[#a3a9bb] sm:block" />}
                {crumb.href && index < crumbs.length - 1 ? (
                  <Link href={crumb.href} className="truncate text-muted hover:text-blue">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="truncate font-semibold" aria-current={index === crumbs.length - 1 ? 'page' : undefined}>
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
          </nav>
          <div className="flex flex-none items-center gap-2">
            {actions}
            <button type="button" className="btn-ghost" onClick={switchLanguage} aria-label={t.common.language.label}>
              <Icon name="globe" />
              <span className="hidden sm:inline">{t.common.language.short}</span>
            </button>
          </div>
        </div>
        {hasRow && (
          <div className="flex h-11 items-stretch gap-1 overflow-x-auto border-t border-[#eceff6] px-2 [scrollbar-width:none] md:px-6">
            {tabs ? (
              <nav aria-label={tabsLabel} className="flex items-stretch gap-1">
                {tabs.map((tab) => (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    aria-current={tab.active ? 'page' : undefined}
                    ref={(node) => {
                      if (node && tab.active) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    }}
                    className={`flex flex-none items-center gap-1.5 border-b-2 px-3 text-[13px] font-medium whitespace-nowrap ${
                      tab.active ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'
                    }`}
                  >
                    {tab.icon && <Icon name={tab.icon} className="size-[15px]" />}
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

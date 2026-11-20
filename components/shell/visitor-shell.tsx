'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { ShellProvider, useMediaQuery } from '@/components/shell/app-shell';
import { RouteMotion } from '@/components/shell/workspace-main';
import { SignInLink } from '@/components/site/site-nav';
import { BrandMark, BrandName } from '@/components/ui/brand-mark';
import { Icon, type IconName } from '@/components/ui/icons';
import { LanguageMenu } from '@/components/ui/language-menu';
import { useI18n } from '@/i18n/client';
import { stripLocale } from '@/i18n/paths';
import './shell.css';
import './columns.css';

/**
 * A visitor's frame for 首页, Rees and public Rees (v5, assumption A4): the
 * same three columns as the workspace, with a shorter navigation (首页,
 * Rees, 价格, 了解 RE0), sign-in and the language in the sidebar. On a
 * phone the sidebar is hidden; the column head carries the brand and the
 * way to Rees, and the bar along the bottom is the sign-in (v6: only there,
 * so each entry shows once).
 */
export function VisitorShell({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const nav = t.common.nav;
  const pathname = stripLocale(usePathname());
  /* The same 68px icon rail as the workspace between phones and 1024px (v6). */
  const rail = useMediaQuery('(min-width: 761px) and (max-width: 1023px)');
  const items: [string, IconName, string, boolean][] = [
    ['/', 'home', nav.homeFeed, pathname === '/'],
    ['/explore', 'compass', nav.discover, pathname === '/explore' || pathname.startsWith('/r/')],
    ['/pricing', 'wallet', nav.pricing, pathname === '/pricing'],
    ['/about', 'info', nav.about, pathname === '/about'],
  ];
  return (
    <ShellProvider value={{ collapsed: rail, toggleCollapsed: () => undefined, openDrawer: () => undefined, activitiesPending: false, signedIn: false }}>
      <div className="xshell is-visitor">
        <aside id="sidebar" className={`sidebar sidebar-chat${rail ? ' is-collapsed' : ''}`} aria-label={nav.main}>
          <Link href="/" className="wordmark" aria-label={nav.home}>
            <BrandMark />
            <BrandName />
          </Link>
          <nav className="nav chat-product-nav" aria-label={nav.main}>
            {items.map(([href, icon, label, active]) => (
              <Link key={href} href={href} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined} aria-label={label} title={label}>
                <Icon name={icon} className="" />
                <span>{label}</span>
              </Link>
            ))}
          </nav>
          <div className="xnav-foot">
            {/* Sign-in only: creating a Ree is the right column's card (v6, one place for each). */}
            <div className="xnav-visitor">
              <SignInLink label={t.site.nav.signIn} className="btn w-full justify-center" />
            </div>
            <div className="xnav-links">
              <Link href="/legal/privacy">{t.site.visitor.privacy}</Link>
              <Link href="/legal/terms">{t.site.visitor.terms}</Link>
              <LanguageMenu className="btn-ghost shell-language" />
            </div>
          </div>
        </aside>
        <div className="app-main">
          <RouteMotion className="site-route-content">{children}</RouteMotion>
        </div>
        <div className="xsignup" role="region" aria-label={t.site.visitor.barLabel}>
          <div>
            <strong>{t.site.visitor.barTitle}</strong>
            <br />
            <span className="xsignup-note">{t.site.visitor.barBody}</span>
          </div>
          <div className="flex gap-2">
            <SignInLink label={t.site.nav.signIn} className="btn light" />
            <Link href="/login" className="btn outline">
              {t.site.visitor.signUp}
            </Link>
          </div>
        </div>
      </div>
    </ShellProvider>
  );
}

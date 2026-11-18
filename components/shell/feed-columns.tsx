'use client';

import type { ReactNode } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { useShell } from '@/components/shell/app-shell';
import { useI18n } from '@/i18n/client';
import { BrandMark, BrandName } from '@/components/ui/brand-mark';
import { Icon } from '@/components/ui/icons';
import './columns.css';

/**
 * The centre and right columns of the three-column frame (v5): a sticky
 * head with the page's title (and a way back, and tabs), the page itself,
 * and the right column -- search, suggestions -- which folds away below
 * 1100px. On a phone the head gains the brand and the menu that opens the
 * navigation drawer. Used by the feed-like pages; the creator tools keep
 * their full-width pages and top bar.
 */
export function FeedColumns({ title, back, tabs, rail, heading = true, children }: {
  title: ReactNode;
  /** The title is the page's h1; false when the page has its own (a visitor's 首页, whose introduction carries it). */
  heading?: boolean;
  /** Where "←" goes; none for a top-level page. */
  back?: string;
  /** The head's second row, usually `.cl-tabs`. */
  tabs?: ReactNode;
  rail?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { openDrawer, activitiesPending, signedIn } = useShell();
  return (
    <div className="xmain-grid">
      <div className="xcol">
        <div className="xtop">
          <Link href="/" className="wordmark" aria-label={t.common.nav.home}>
            <BrandMark />
            <BrandName />
          </Link>
          {signedIn ? (
            <button type="button" className="icon-btn mobile-menu" onClick={openDrawer} aria-label={t.common.nav.openMenu} title={t.common.nav.openMenu}>
              <Icon name="menu" className="" />
              {activitiesPending && <i className="nav-dot" aria-hidden="true" />}
            </button>
          ) : (
            <span className="flex items-center gap-1">
              <Link href="/explore" className="icon-btn" aria-label={t.common.nav.discover} title={t.common.nav.discover}>
                <Icon name="compass" className="" />
              </Link>
              <Link href="/login" className="btn btn-sm">
                {t.site.nav.signIn}
              </Link>
            </span>
          )}
        </div>
        <header className="xcol-head">
          <div className="xcol-title">
            {back && (
              <Link href={back} className="icon-btn" aria-label={t.common.actions.back} title={t.common.actions.back}>
                <Icon name="arrowLeft" className="" />
              </Link>
            )}
            {heading ? <h1 className="min-w-0 truncate">{title}</h1> : <p className="min-w-0 truncate">{title}</p>}
          </div>
          {tabs}
        </header>
        {children}
      </div>
      {rail && <aside className="xrail">{rail}</aside>}
    </div>
  );
}

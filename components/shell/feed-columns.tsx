'use client';

import type { ReactNode } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { MobileTop } from '@/components/shell/mobile-top';
import { useI18n } from '@/i18n/client';
import { Icon } from '@/components/ui/icons';
import './columns.css';
import '@/components/ui/tabs.css';

/**
 * The centre and right columns of the three-column frame (v5): a sticky
 * head with the page's title (and a way back, and tabs), the page itself,
 * and the right column -- search, suggestions -- which folds away below
 * 1100px. On a phone the head gains the brand and the menu that opens the
 * navigation drawer (`MobileTop`, the same line `Topbar` starts with). Used
 * by the feed-like pages; the creator tools keep their full-width pages and
 * top bar.
 */
export function FeedColumns({ title, back, tabs, rail, heading = true, wide = false, children }: {
  title: ReactNode;
  /** The title is the page's h1; false when the page has its own (a visitor's 首页, whose introduction carries it). */
  heading?: boolean;
  /** Where "←" goes; none for a top-level page. */
  back?: string;
  /** The head's second row, usually `.cl-tabs`. */
  tabs?: ReactNode;
  rail?: ReactNode;
  /** One column the width of the centre and right ones together (v6): 价格, 了解 RE0, the legal pages, checkout. */
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className={wide ? 'xmain-grid is-wide' : 'xmain-grid'}>
      <div className="xcol">
        <MobileTop />
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

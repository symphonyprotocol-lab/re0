'use client';

import type { ReactNode } from 'react';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { FeedColumns } from '@/components/shell/feed-columns';
import { useI18n } from '@/i18n/client';
import './content-page.css';

/**
 * A site page in the shell (v6): 价格, 了解 RE0, the legal pages, checkout.
 * One wide column under the column head, then the site's small print -- what
 * the old site footer said: the copyright, that Paddle is the merchant of
 * record, the legal pages and the console's sign-in.
 */
export function ContentPage({ title, heading = true, children }: { title: string; heading?: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const f = t.site.footer;
  return (
    <FeedColumns title={title} heading={heading} wide>
      <div className="xpage">
        {children}
        <footer className="xp-footer">
          <span>© 2026 RE0. {f.care}</span>
          <span>{f.paddle}</span>
          <Link href="/legal/terms">{f.terms}</Link>
          <Link href="/legal/privacy">{f.privacy}</Link>
          <Link href="/admin/login">{f.admin}</Link>
        </footer>
      </div>
    </FeedColumns>
  );
}

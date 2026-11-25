import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReactNode } from 'react';
import { BrandMark, BrandName } from '@/components/ui/brand-mark';
import './share.css';

/**
 * The share page's own frame: no site header or footer and no workspace
 * sidebar -- the Ree is the page. A slim bar with the RE0 mark (and, on the
 * landing, its ask button) and 「由 RE0 提供」 at the foot.
 *
 * `wide` is the landing page (design A, 2026-11-25): full-width bands on
 * flat grounds, closing on a dark foot that holds `footer` (the last ask and
 * the creator) above the mark and 由 RE0 提供. The not-found card keeps the
 * narrow column with one faint line under it.
 */
export function ShareFrame({ powered, wide = false, action, footer, children }: { powered: string; wide?: boolean; action?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  if (wide) {
    return (
      <div className="share-page flex min-h-dvh flex-col">
        <header className="share-top">
          <div className="share-wrap flex items-center justify-between gap-3">
            <Link href="/" className="share-brand" aria-label="RE0">
              <BrandMark size={28} />
              <BrandName />
            </Link>
            {action}
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="share-foot">
          <div className="share-wrap">
            {footer}
            <div className="share-legal">
              <Link href="/" className="share-brand" aria-label="RE0">
                <BrandMark size={24} />
                <BrandName />
              </Link>
              <Link href="/" className="share-legal-link">
                {powered}
              </Link>
            </div>
          </div>
        </footer>
      </div>
    );
  }
  return (
    <div className="share-page flex min-h-dvh flex-col bg-wash">
      <header className="mx-auto flex w-full max-w-[760px] items-center justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        <Link href="/" className="share-brand" aria-label="RE0">
          <BrandMark size={24} />
          <BrandName />
        </Link>
        {action}
      </header>
      <main className="mx-auto w-full max-w-[760px] flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-8">
        {children}
        <p className="mt-8 text-center text-[11px] text-[#a3a9bb]">
          <Link href="/" className="hover:text-blue">
            {powered}
          </Link>
        </p>
      </main>
    </div>
  );
}

import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReactNode } from 'react';
import { BrandMark, BrandName } from '@/components/ui/brand-mark';

/**
 * The share page's own frame: no site header or footer and no workspace
 * sidebar -- the Ree is the page. A slim bar with the RE0 mark (and, on the
 * landing, its ask button), and one faint 「由 RE0 提供」 line at the foot.
 * `wide` is the landing page; the not-found card keeps the narrow column.
 */
export function ShareFrame({ powered, wide = false, action, children }: { powered: string; wide?: boolean; action?: ReactNode; children: ReactNode }) {
  const column = wide ? 'max-w-[1120px]' : 'max-w-[760px]';
  return (
    <div className="flex min-h-dvh flex-col bg-[radial-gradient(1200px_480px_at_50%_-120px,#e3efff_0%,transparent_70%)]">
      <header className={`mx-auto flex w-full ${column} items-center justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6`}>
        <Link href="/" className="inline-flex items-center gap-2 text-[15px] font-bold tracking-tight" aria-label="RE0">
          <BrandMark size={24} />
          <BrandName />
        </Link>
        {action}
      </header>
      <main className={`mx-auto w-full ${column} flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-8`}>
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

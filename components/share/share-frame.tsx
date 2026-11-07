import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReactNode } from 'react';

/**
 * The share page's own frame: no site header or footer and no workspace
 * sidebar -- the Ree is the page. Only one faint 「由 RE0 提供」 line under it.
 */
export function ShareFrame({ powered, children }: { powered: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[radial-gradient(1200px_480px_at_50%_-120px,#e3efff_0%,transparent_70%)]">
      <main className="mx-auto w-full max-w-[760px] flex-1 px-4 pt-6 pb-10 sm:px-6 sm:pt-10">
        {children}
        <p className="mt-6 text-center text-[11px] text-[#a3a9bb]">
          <Link href="/" className="hover:text-blue">
            {powered}
          </Link>
        </p>
      </main>
    </div>
  );
}

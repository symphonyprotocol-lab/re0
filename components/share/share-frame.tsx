import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import type { ReactNode } from 'react';
import { LanguageToggle } from '@/components/ui/language-toggle';

/** The RE0 mark (prototype icon.svg), as the site header draws it. */
function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="size-[28px]">
      <rect width="32" height="32" rx="10.6667" fill="#127ee3" />
      <g fill="#ffffff" stroke="#ffffff" strokeWidth="1" strokeLinejoin="round">
        <path d="M17.25 8.91 A 7.2 7.2 0 1 0 23.2 16" fill="none" strokeWidth="3" />
        <circle cx="17.25" cy="8.91" r="1.5" stroke="none" />
        <path d="M23.2 11.4 L 25.75 16 L 20.65 16 Z" />
        <circle cx="16" cy="16" r="2.5" stroke="none" />
      </g>
    </svg>
  );
}

/**
 * The share page's own frame: no site navigation and no workspace sidebar,
 * only the mark, the language and the way in -- the Ree is the page.
 */
export function ShareFrame({ signedIn, home, action, children }: { signedIn: boolean; home: string; action: { href: string; label: string }; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[radial-gradient(1200px_480px_at_50%_-120px,#e3efff_0%,transparent_70%)]">
      <header className="mx-auto flex w-full max-w-[760px] items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-[19px] font-[750] tracking-[-0.6px]" aria-label={home}>
          <BrandMark />
          <span>RE0</span>
        </Link>
        <div className="flex items-center gap-1">
          <LanguageToggle signedIn={signedIn} icon={false} />
          <Link href={action.href} className="btn-secondary btn-sm">
            {action.label}
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}

import Link from 'next/link';
import { LocaleSwitcher } from '@/components/site/locale-switcher';
import { MobileNav } from '@/components/site/mobile-nav';
import { HeaderShell } from '@/components/site/header-shell';
import { RepoLink } from '@/components/site/repo-link';
import { WorkspaceAvatar } from '@/components/dashboard/workspace-avatar';
import { Wordmark } from '@/components/site/wordmark';
import { LogOutIcon } from '@/components/ui/icons';
import { WORKSPACE_INITIAL } from '@/lib/dashboard/snippets';
import { getMessages } from '@/lib/i18n/server';

/**
 * Dashboard chrome header.
 *
 * The same shell, column and layout as `SiteHeader`, so the two stay one piece
 * of chrome: the capsule tracks the same 1200px column, picks up the same
 * dark-at-rest, light-once-scrolled behaviour, and gathers the destinations
 * against the right edge ahead of the GitHub mark. The only difference is the
 * action itself, which here is the workspace pill plus a sign-out button
 * instead of the sign-in button.
 *
 * The capsule is 64px in a 24px gutter, so the header box is 88px tall and the
 * workspace rail's sticky offset is measured from that.
 */
export async function DashboardHeader({
  workspaceName,
  workspaceInitial = WORKSPACE_INITIAL,
}: {
  workspaceName: string;
  workspaceInitial?: string;
}) {
  const t = await getMessages();

  const nav = [
    { href: '/pricing', label: t.nav.pricing },
    { href: '/playground', label: t.nav.playground },
  ];

  return (
    <HeaderShell width="max-w-[1200px]">
      <Wordmark />

      <div className="flex items-center gap-3">
        <nav className="hidden items-center gap-8 pr-3 md:flex">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-body text-muted transition-colors hover:text-ink"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <MobileNav items={nav} label={t.nav.menu} />
        <RepoLink label={t.nav.github} />
        <LocaleSwitcher />
        <Link
          href="/dashboard/settings"
          className="inline-flex h-10 max-w-[180px] items-center gap-2 rounded-md border border-line pr-3 pl-1.5 text-caption text-ink transition-colors hover:bg-subtle"
        >
          <WorkspaceAvatar initial={workspaceInitial} />
          <span className="truncate">{workspaceName}</span>
        </Link>
        {/* POST so the sign-out carries an Origin to check. architecture.md 15.3 */}
        <form method="post" action="/api/auth/logout" className="flex">
          <button
            type="submit"
            aria-label={t.dashboard.shell.signOut}
            title={t.dashboard.shell.signOut}
            className="flex size-9 items-center justify-center rounded-full border border-line text-muted transition-colors hover:text-ink"
          >
            <LogOutIcon size={15} />
          </button>
        </form>
      </div>
    </HeaderShell>
  );
}

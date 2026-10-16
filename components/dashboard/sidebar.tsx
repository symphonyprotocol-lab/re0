'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { WorkspaceAvatar } from '@/components/dashboard/workspace-avatar';
import {
  ArrowUpRightIcon,
  CircleDollarSignIcon,
  DatabaseIcon,
  FileTextIcon,
  KeyIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SpinnerIcon,
} from '@/components/ui/icons';
import { WORKSPACE_INITIAL } from '@/lib/dashboard/snippets';
import { useI18n } from '@/lib/i18n/client';

/** Workspace rail -- design source frame `E4GWD`, aside `itqF4`. */
export function DashboardSidebar({
  workspaceName,
  workspaceInitial = WORKSPACE_INITIAL,
  planName,
  usage,
}: {
  workspaceName: string;
  workspaceInitial?: string;
  planName: string;
  /** This period's metered calls against the plan allowance, from the ledger. */
  usage: { used: number; limit: number };
}) {
  const { locale, t } = useI18n();
  const pathname = usePathname();
  const number = new Intl.NumberFormat(locale);

  const nav = [
    { href: '/dashboard', label: t.dashboard.nav.overview, Icon: LayoutDashboardIcon },
    { href: '/dashboard/libraries', label: t.dashboard.nav.libraries, Icon: DatabaseIcon },
    { href: '/dashboard/api-keys', label: t.dashboard.nav.apiKeys, Icon: KeyIcon },
    { href: '/dashboard/requests', label: t.dashboard.nav.requests, Icon: FileTextIcon },
    { href: '/dashboard/revenue', label: t.dashboard.nav.revenue, Icon: CircleDollarSignIcon },
    { href: '/dashboard/policies', label: t.dashboard.nav.policies, Icon: ShieldCheckIcon },
    { href: '/dashboard/settings', label: t.dashboard.nav.settings, Icon: SettingsIcon },
  ];
  const percent = Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100));

  return (
    <aside className="flex w-full shrink-0 flex-col gap-4 rounded-lg border border-line bg-card/92 p-4 lg:sticky lg:top-[112px] lg:w-[210px]">
      <div className="flex items-center gap-2.5 border-b border-line px-2 pt-2 pb-2.5">
        <WorkspaceAvatar size="md" initial={workspaceInitial} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] text-ink">{workspaceName}</span>
          <span className="text-[10px] text-muted">{planName}</span>
        </span>
      </div>

      <nav className="flex flex-col gap-[3px]">
        <p className="px-2 pb-1.5 text-[10px] font-medium tracking-[0.09em] text-muted">
          {t.dashboard.nav.section}
        </p>
        {nav.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex h-9 items-center gap-[9px] rounded-md px-3 text-caption transition-colors ${
                active ? 'bg-brandsoft text-brandink' : 'text-muted hover:bg-subtle'
              }`}
            >
              <Icon size={15} />
              {label}
              <NavPending />
            </Link>
          );
        })}
      </nav>

      <div className="rounded-md border border-line bg-subtle p-3.5">
        <p className="text-[10px] text-muted">
          {t.dashboard.shell.monthlyCalls}
        </p>
        <p className="mt-1 text-[13px] text-ink">
          {number.format(usage.used)} / {number.format(usage.limit)}
        </p>
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-mutedbg">
          <div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
        </div>
        <Link
          href="/pricing"
          className="mt-2.5 flex items-center justify-between text-[11px] text-brandink transition-colors hover:text-brandink"
        >
          {t.dashboard.shell.upgrade}
          <ArrowUpRightIcon size={13} />
        </Link>
      </div>
    </aside>
  );
}


/**
 * A spinner at the end of the rail item whose page is on its way. Next.js
 * reports the pending navigation per link, so only the clicked item shows it;
 * the content column swaps to its own loading state at the same time.
 */
function NavPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <SpinnerIcon size={13} className="ml-auto shrink-0 text-brandink motion-safe:animate-spin" />
  );
}

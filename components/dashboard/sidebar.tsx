'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { WorkspaceAvatar } from '@/components/dashboard/workspace-avatar';
import {
  ArrowUpRightIcon,
  BotIcon,
  CircleDollarSignIcon,
  DatabaseIcon,
  FileTextIcon,
  GlobeIcon,
  KeyIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  SettingsIcon,
  SparklesIcon,
  ShieldCheckIcon,
  SpinnerIcon,
  SquareTerminalIcon,
} from '@/components/ui/icons';
import { WORKSPACE_INITIAL } from '@/lib/dashboard/snippets';
import { surfaceEnabled } from '@/lib/domain/surfaces';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

type NavItem = {
  href: string;
  label: string;
  Icon: typeof LayoutDashboardIcon;
  badge?: number;
};

/**
 * Workspace rail -- design source frame `E4GWD`, aside `itqF4`, regrouped
 * for the Agent workbench (agent-first-proposal.md 4.4):
 *
 *   Agent        对话、待确认的操作、A2A 任务
 *   资产          全部资产、未归入频道的资产
 *   频道          我的频道、订阅收入与出账
 *   Agent Card   我的用户卡与频道卡、API Key
 *   设置          访问规则、调用记录、容量与购买、设置
 *
 * Entries wait for their pages: 待答列表 and 评论管理 (频道), the whole 订阅
 * group and 导出 arrive with P3a, and offline surfaces (lib/domain/surfaces.ts)
 * keep no entry.
 */
export function DashboardSidebar({
  workspaceName,
  workspaceInitial = WORKSPACE_INITIAL,
  planName,
  usage,
  leadsNew = 0,
  pendingActions = 0,
}: {
  workspaceName: string;
  workspaceInitial?: string;
  planName: string;
  /**
   * This period's calls the plan allowance paid for, against that allowance;
   * and the call packs' balance against all they ever granted (0 before the
   * first pack, which hides the line).
   */
  usage: { used: number; limit: number; packRemaining?: number; packGranted?: number };
  /** Unhandled showcase leads across the workspace (lib/application/showcase/leads.ts). */
  leadsNew?: number;
  /** Pending actions waiting for the owner (agent-first-proposal.md 5.2). */
  pendingActions?: number;
}) {
  const { locale, t } = useI18n();
  const pathname = usePathname();
  const search = useSearchParams();
  const number = new Intl.NumberFormat(locale);
  const n = t.dashboard.nav;

  const groups: { label: string; items: NavItem[] }[] = [
    {
      label: n.groups.agent,
      items: [
        { href: '/dashboard', label: n.conversation, Icon: MessagesSquareIcon },
        { href: '/dashboard/actions', label: n.actions, Icon: ListChecksIcon, badge: pendingActions },
        { href: '/dashboard/a2a', label: n.a2aTasks, Icon: SquareTerminalIcon },
      ],
    },
    {
      label: n.groups.assets,
      items: [
        { href: '/dashboard/assets', label: n.allAssets, Icon: DatabaseIcon },
        { href: '/dashboard/assets?filter=unfiled', label: n.unfiledAssets, Icon: DatabaseIcon },
      ],
    },
    {
      label: n.groups.channels,
      items: [
        { href: '/dashboard/channels', label: n.myChannels, Icon: GlobeIcon },
        { href: '/dashboard/revenue', label: n.channelRevenue, Icon: CircleDollarSignIcon },
      ],
    },
    {
      label: n.groups.agentCard,
      items: [
        { href: '/dashboard/agent-cards', label: n.agentCards, Icon: BotIcon },
        { href: '/dashboard/api-keys', label: n.apiKeys, Icon: KeyIcon },
      ],
    },
    {
      label: n.groups.settings,
      items: [
        { href: '/dashboard/policies', label: n.policies, Icon: ShieldCheckIcon },
        { href: '/dashboard/requests', label: n.requests, Icon: FileTextIcon },
        { href: '/dashboard/usage', label: n.capacity, Icon: LayoutDashboardIcon },
        /* Offline surfaces (lib/domain/surfaces.ts) keep no entry in the rail. */
        ...(surfaceEnabled('widget') ? [{ href: '/dashboard/widget', label: n.widget, Icon: GlobeIcon }] : []),
        ...(surfaceEnabled('showcase')
          ? [{ href: '/dashboard/showcases', label: n.showcases, Icon: SparklesIcon, badge: leadsNew }]
          : []),
        { href: '/dashboard/settings', label: n.settings, Icon: SettingsIcon },
      ],
    },
  ];
  const isActive = (href: string) => {
    const [path, query] = href.split('?');
    if (pathname !== path) return false;
    return query ? search.toString() === query : search.get('filter') === null;
  };
  const percent = Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100));
  const packGranted = usage.packGranted ?? 0;
  const packRemaining = usage.packRemaining ?? 0;
  const packPercent = packGranted > 0 ? Math.min(100, Math.round((packRemaining / packGranted) * 100)) : 0;

  return (
    <aside className="flex w-full shrink-0 flex-col gap-4 rounded-lg border border-line bg-card/92 p-4 lg:sticky lg:top-[112px] lg:w-[210px]">
      <div className="flex items-center gap-2.5 border-b border-line px-2 pt-2 pb-2.5">
        <WorkspaceAvatar size="md" initial={workspaceInitial} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] text-ink">{workspaceName}</span>
          <span className="text-[10px] text-muted">{planName}</span>
        </span>
      </div>

      <nav className="flex flex-col gap-3">
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col gap-[3px]">
            <p className="px-2 pb-1 text-[10px] font-medium tracking-[0.09em] text-muted">{group.label}</p>
            {group.items.map(({ href, label, Icon, badge }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-8 items-center gap-[9px] rounded-md px-3 text-caption transition-colors ${
                    active ? 'bg-brandsoft text-brandink' : 'text-muted hover:bg-subtle'
                  }`}
                >
                  <Icon size={15} />
                  {label}
                  {badge ? (
                    <span className="ml-auto rounded-full bg-brand px-1.5 py-0.5 text-[10px] leading-none font-medium text-onbrand">
                      {number.format(badge)}
                    </span>
                  ) : null}
                  <NavPending />
                </Link>
              );
            })}
          </div>
        ))}
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
        {/* Call packs are spent once the allowance runs out (lib/application/plans/quota.ts); shown from the first one bought. */}
        {packGranted > 0 ? (
          <>
            <p className="mt-3 flex items-baseline justify-between gap-2 text-[10px] text-muted">
              {t.dashboard.shell.callPacks}
              <span className="text-[11px] text-ink">
                {fill(t.dashboard.shell.callPacksLeft, { n: number.format(packRemaining) })}
              </span>
            </p>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-mutedbg">
              <div className="h-full rounded-full bg-brand/45" style={{ width: `${packPercent}%` }} />
            </div>
          </>
        ) : null}
        <Link
          href="/pricing"
          className="mt-2.5 flex items-center justify-between text-[11px] text-brandink transition-colors hover:text-brandink"
        >
          {t.dashboard.shell.buyCalls}
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

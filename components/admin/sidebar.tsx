'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactElement } from 'react';
import {
  ArrowUpRightIcon,
  CircleDollarSignIcon,
  DatabaseIcon,
  FilterIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  Re0Mark,
  ReceiptIcon,
  RefreshIcon,
  ScaleIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  SlidersIcon,
  SparklesIcon,
  UsersIcon,
} from '@/components/ui/icons';
import type { AdminCapability } from '@/lib/domain/admin';
import { useI18n } from '@/lib/i18n/client';

/**
 * Console rail -- design source frame `oxEhj`, aside.
 *
 * The console gets a dark, always-visible rail rather than the dashboard's
 * card: it is a different surface with a different audience, and the design
 * draws it grouped by concern (general, operations, commerce, system) so an
 * operator can tell a review action from a billing one at a glance.
 *
 * The design source is desktop only. Below `lg` the rail folds into a
 * horizontal strip rather than a full-height column, so a narrow window does
 * not have to scroll past the whole navigation to reach the page.
 *
 * Items the signed-in role cannot reach are not rendered. The routes enforce
 * this too (`requireAdminCapability`); hiding them here is so an operator is
 * not offered a door that bounces them back.
 */
export function AdminSidebar({
  pendingReviews,
  openRefreshes,
  capabilities,
}: {
  pendingReviews: number;
  /** Platform refreshes queued or running, on the queue item. */
  openRefreshes: number;
  capabilities: readonly AdminCapability[];
}) {
  const { t } = useI18n();
  const nav = t.admin.nav;
  const pathname = usePathname();

  interface NavItem {
    href: string;
    label: string;
    Icon: (props: { size?: number; className?: string }) => ReactElement;
    badge?: number;
    /** Absent means every administrator may see it. */
    needs?: AdminCapability;
  }

  const allGroups: { label: string; items: NavItem[] }[] = [
    {
      label: nav.general,
      // The overview is every administrator's landing page; its panels are
      // filtered by capability rather than the whole screen.
      items: [{ href: '/admin/overview', label: nav.overview, Icon: LayoutDashboardIcon }],
    },
    {
      label: nav.business,
      items: [
        { href: '/admin/users', label: nav.users, Icon: UsersIcon, needs: 'users' },
        {
          href: '/admin/libraries',
          label: nav.libraries,
          Icon: DatabaseIcon,
          badge: pendingReviews,
          needs: 'libraries',
        },
        {
          href: '/admin/platform-libraries',
          label: nav.platformLibraries,
          Icon: GlobeIcon,
          needs: 'platformLibraries',
        },
        {
          href: '/admin/refresh-queue',
          label: nav.refreshQueue,
          Icon: RefreshIcon,
          badge: openRefreshes,
          needs: 'platformLibraries',
        },
        /*
         * Ownership sits with the libraries it decides, not under system:
         * requirement.md 5.3 gives a dispute to whoever runs the catalogue,
         * and its own capability keeps a reviewer out (lib/domain/admin.ts).
         */
        { href: '/admin/claims', label: nav.claims, Icon: ScaleIcon, needs: 'claims' },
      ],
    },
    {
      label: nav.commerce,
      items: [
        { href: '/admin/plans', label: nav.plans, Icon: SlidersIcon, needs: 'plans' },
        { href: '/admin/billing', label: nav.billing, Icon: ReceiptIcon, needs: 'billing' },
        {
          href: '/admin/settlements',
          label: nav.settlements,
          Icon: CircleDollarSignIcon,
          needs: 'billing',
        },
        /* Model and retrieval configuration have their own capability; a plan is a price. */
        { href: '/admin/models', label: nav.models, Icon: SparklesIcon, needs: 'models' },
        { href: '/admin/retrieval', label: nav.retrieval, Icon: FilterIcon, needs: 'models' },
      ],
    },
    {
      label: nav.system,
      items: [
        {
          href: '/admin/administrators',
          label: nav.administrators,
          Icon: ShieldCheckIcon,
          needs: 'administrators',
        },
        { href: '/admin/audit', label: nav.audit, Icon: ScrollTextIcon, needs: 'audit' },
      ],
    },
  ];

  const groups = allGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.needs || capabilities.includes(item.needs)),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <aside className="flex w-full shrink-0 flex-col gap-3 bg-console px-3.5 py-3 lg:sticky lg:top-0 lg:h-screen lg:w-[226px] lg:gap-5 lg:overflow-y-auto lg:py-5">
      <Link
        href="/admin/overview"
        className="flex items-center gap-2.5 px-2 lg:border-b-2 lg:border-white/10 lg:pb-4"
      >
        <span
          aria-hidden
          className="flex size-[27px] shrink-0 items-center justify-center rounded-md bg-white/10 text-mint"
        >
          <Re0Mark size={24} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[15px] leading-[1.2] font-bold tracking-[-0.03em] text-white">
            re0
          </span>
          <span className="text-[10px] tracking-[-0.023em] text-consolemuted">
            {t.admin.shell.subtitle}
          </span>
        </span>
      </Link>

      <nav className="flex gap-1 overflow-x-auto lg:flex-1 lg:flex-col lg:gap-4 lg:overflow-x-visible">
        {groups.map((group) => (
          <div key={group.label} className="flex shrink-0 gap-1 lg:flex-col lg:gap-[3px]">
            <p className="hidden px-2.5 pb-1 text-[10px] font-bold tracking-[0.09em] text-consolemuted lg:block">
              {group.label}
            </p>
            {group.items.map(({ href, label, Icon, badge }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex h-[37px] shrink-0 items-center gap-2.5 rounded-[7px] px-2.5 text-[13px] tracking-[-0.023em] whitespace-nowrap transition-colors ${
                    active
                      ? 'border-l-2 border-mint bg-mint/12 text-white'
                      : 'text-consoletext hover:bg-white/6 hover:text-white'
                  }`}
                >
                  <Icon size={15} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {badge ? (
                    <span className="inline-flex min-w-[19px] items-center justify-center rounded-full bg-amber px-[5px] py-0.5 text-[10px] font-bold text-white">
                      {badge}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="hidden flex-col gap-1 rounded-[8px] border-2 border-white/8 bg-white/4 px-3 py-3.5 lg:flex">
        <span className="flex items-center gap-2">
          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-[#4bdb9c]" />
          <span className="text-[11px] font-semibold tracking-[-0.023em] text-[#d7e7e8]">
            {t.admin.shell.statusTitle}
          </span>
        </span>
        <span className="pl-[15px] text-[10px] tracking-[-0.023em] text-consolemuted">
          {t.admin.shell.statusChecked}
        </span>
      </div>

      <Link
        href="/"
        className="hidden h-9 items-center gap-2 rounded-[7px] px-2.5 text-[11px] tracking-[-0.023em] text-[#8ba4a8] transition-colors hover:bg-white/6 hover:text-white lg:flex"
      >
        <ArrowUpRightIcon size={13} />
        {t.admin.shell.backToSite}
      </Link>
    </aside>
  );
}

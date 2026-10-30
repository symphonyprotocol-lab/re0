import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DashboardHeader } from '@/components/dashboard/header';
import { NavigationProgress } from '@/components/dashboard/navigation-progress';
import { DashboardSidebar } from '@/components/dashboard/sidebar';
import { listActions } from '@/lib/application/agent';
import { countNewLeads } from '@/lib/application/showcase';
import { surfaceEnabled } from '@/lib/domain/surfaces';
import { workspaceUsage } from '@/lib/http/dashboard';
import { requireSession } from '@/lib/http/session';
import { LocaleProvider } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import { translations } from '@/lib/i18n/server';

/** Signed-in only; `robots.ts` keeps crawlers out and the page says so itself for any link that reaches one. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Dashboard shell -- design source frame `E4GWD`.
 *
 * Header and workspace rail are chrome shared by every dashboard screen, so
 * they live here; each page renders only the content column. The column is the
 * marketing page's 1200px one, so the capsule and the body line up with the
 * site the visitor just came from.
 *
 * This is also the real authorization boundary. `middleware.ts` only glances at
 * the cookie; here the session is resolved against the primary database, so a
 * revoked session or a suspended account cannot render a dashboard
 * (architecture.md 5.2, requirement.md 3.2).
 *
 * Light-committed product surface. See app/layout.tsx for why this lives here.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const [{ workspace }, { locale, t }] = await Promise.all([
    requireSession('/dashboard'),
    translations(),
  ]);
  // The rail's quota is the same ledger figure the overview prints (usage.ts).
  const [overview, leadsNew, pendingActions] = await Promise.all([
    workspaceUsage(workspace.id),
    /* Unhandled showcase leads, for the rail's badge; a failed count is no badge, not a failed page. */
    surfaceEnabled('showcase') ? countNewLeads(workspace.id).catch(() => 0) : 0,
    /* Pending actions waiting for the owner (agent-first-proposal.md 5.2); same rule for a failed count. */
    listActions(workspace.id, { pendingOnly: true, limit: 200 }).then((rows) => rows.length).catch(() => 0),
  ]);

  return (
    <LocaleProvider locale={locale} messages={t}>
      <div className="product-surface dashboard-wash flex min-h-screen flex-col">
        <NavigationProgress />
        <DashboardHeader workspaceName={workspace.name} workspaceInitial={workspace.initial} />
        <div className="flex-1">
          <div className="mx-auto flex w-full max-w-[1200px] flex-col items-start gap-7 px-5 pt-[34px] pb-16 lg:flex-row">
            <DashboardSidebar
              workspaceName={workspace.name}
              workspaceInitial={workspace.initial}
              planName={fill(t.dashboard.shell.planLine, { plan: workspace.planName })}
              usage={{
                used: overview.planCallsThisPeriod,
                limit: overview.planAllowance,
                packRemaining: overview.addonBalanceRemaining,
                packGranted: overview.addonGranted,
              }}
              leadsNew={leadsNew}
              pendingActions={pendingActions}
            />
            <main className="w-full min-w-0 flex-1">{children}</main>
          </div>
        </div>
      </div>
    </LocaleProvider>
  );
}

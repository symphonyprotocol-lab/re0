import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DashboardColumns } from '@/components/dashboard/columns';
import { DashboardHeader } from '@/components/dashboard/header';
import { NavigationProgress } from '@/components/dashboard/navigation-progress';
import { DashboardSidebar } from '@/components/dashboard/sidebar';
import { listActions } from '@/lib/application/agent';
import { unreadNotifications } from '@/lib/application/notifications';
import { countOpenQuestions } from '@/lib/application/questions';
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
 * they live here; each page renders only the content column. A focused page
 * -- the article and episode editor -- keeps the header and drops the rail
 * (components/dashboard/columns.tsx). The column is the marketing page's
 * 1200px one, so the capsule and the body line up with the site the visitor
 * just came from.
 *
 * This is also the real authorization boundary. `middleware.ts` only glances at
 * the cookie; here the session is resolved against the primary database, so a
 * revoked session or a suspended account cannot render a dashboard
 * (architecture.md 5.2, requirement.md 3.2).
 *
 * Light-committed product surface. See app/layout.tsx for why this lives here.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const [{ workspace, user }, { locale, t }] = await Promise.all([
    requireSession('/dashboard'),
    translations(),
  ]);
  // The rail's quota is the same ledger figure the overview prints (usage.ts).
  const [overview, leadsNew, pendingActions, openQuestions, unreadNotices] = await Promise.all([
    workspaceUsage(workspace.id),
    /* Unhandled showcase leads, for the rail's badge; a failed count is no badge, not a failed page. */
    surfaceEnabled('showcase') ? countNewLeads(workspace.id).catch(() => 0) : 0,
    /* Pending actions waiting for the owner (agent-first-proposal.md 5.2); same rule for a failed count. */
    listActions(workspace.id, { pendingOnly: true, limit: 200 }).then((rows) => rows.length).catch(() => 0),
    /* The creator's pending questions and the user's unread notifications (proposal 6.5-6.8); same rule. */
    countOpenQuestions(workspace.id).catch(() => 0),
    unreadNotifications(user.id).catch(() => 0),
  ]);

  return (
    <LocaleProvider locale={locale} messages={t}>
      <div className="product-surface dashboard-wash flex min-h-screen flex-col">
        <NavigationProgress />
        <DashboardHeader workspaceName={workspace.name} workspaceInitial={workspace.initial} />
        <div className="flex-1">
          <DashboardColumns
            sidebar={
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
                openQuestions={openQuestions}
                unreadNotifications={unreadNotices}
              />
            }
          >
            {children}
          </DashboardColumns>
        </div>
      </div>
    </LocaleProvider>
  );
}

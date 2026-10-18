import type { ReactNode } from 'react';
import { AdminHeader } from '@/components/admin/header';
import { AdminSidebar } from '@/components/admin/sidebar';
import { listUserLibraries, platformLibrarySummary } from '@/lib/application/administration';
import { pendingExpertApplications } from '@/lib/application/expert-libraries';
import { requireAdmin } from '@/lib/http/admin';
import { LocaleProvider } from '@/lib/i18n/client';
import { translations } from '@/lib/i18n/server';

/**
 * Console shell -- design source frame `oxEhj`.
 *
 * Dark rail on the left, a search-and-identity header above the work column,
 * and a fluid content column: chrome every console screen shares, so each page
 * renders only its own stack. The column keeps the design's rail-to-content
 * proportion rather than the marketing site's old 918px cap (now 1080px too) -- the console's tables
 * are wide, and the design source is drawn at three quarters of desktop scale.
 *
 * This is also the authorization boundary. The console is a separate authority
 * from the dashboard -- separate entrance, separate identity, mandatory
 * two-factor -- and a signed-in product user must not reach it
 * (requirement.md 3.2), so `requireAdmin` resolves an admin session and nothing
 * else, and fails closed.
 */
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const [session, { locale, t }] = await Promise.all([requireAdmin(), translations()]);
  /*
   * The rail's badge is the same count the review tab shows. It used to come
   * from the fixture, which meant the rail claimed work was waiting over a
   * screen that said there was none.
   */
  const [{ counts }, refreshes, pendingExpert] = await Promise.all([
    session.capabilities.includes('libraries')
      ? listUserLibraries({ limit: 0 })
      : { counts: { pending: 0 } },
    session.capabilities.includes('platformLibraries')
      ? platformLibrarySummary()
      : { queuedRefreshes: 0 },
    session.capabilities.includes('expertLibraries') ? pendingExpertApplications() : 0,
  ]);

  return (
    <LocaleProvider locale={locale} messages={t}>
      <div className="console-wash flex min-h-screen flex-col lg:flex-row">
        <AdminSidebar
          pendingReviews={counts.pending}
          openRefreshes={refreshes.queuedRefreshes}
          pendingExpert={pendingExpert}
          capabilities={session.capabilities}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <AdminHeader username={session.username} roles={session.roles} />
          <main className="mx-auto w-full max-w-[1080px] flex-1 px-[30px] pt-[30px] pb-[70px]">
            {children}
          </main>
        </div>
      </div>
    </LocaleProvider>
  );
}

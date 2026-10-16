'use client';

import { PANEL } from '@/components/dashboard/ui';
import { useI18n } from '@/lib/i18n/client';

/**
 * What the content column shows while a dashboard page is on its way --
 * the Suspense fallback Next.js renders for every route under /dashboard, so
 * a click on the rail answers at once instead of leaving the previous screen
 * in place until the next one has finished its queries.
 *
 * The shape is the overview's: a header, a row of figures, two cards. It is
 * close enough to every page that the swap does not jump, and it is drawn
 * with the same panel so it reads as the page arriving rather than a spinner
 * over it. Under reduced motion the blocks hold still; the status text
 * carries the state there.
 */
export default function DashboardLoading() {
  const { t } = useI18n();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t.dashboard.shell.loading}
      className="flex flex-col gap-[18px] motion-safe:animate-pulse"
    >
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-2.5">
          <Bar className="h-3 w-40" />
          <Bar className="h-7 w-28" />
          <Bar className="h-3 w-64" />
        </div>
        <Bar className="h-10 w-32 rounded-md" />
      </div>

      <section className={`${PANEL} grid grid-cols-2 gap-y-5 p-5 md:grid-cols-5 md:gap-y-0`}>
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2.5 pr-[18px]">
            <Bar className="h-3 w-16" />
            <Bar className="h-6 w-20" />
            <Bar className="h-3 w-24" />
          </div>
        ))}
      </section>

      <section className="grid gap-[18px] lg:grid-cols-2">
        {Array.from({ length: 2 }, (_, index) => (
          <article key={index} className={`${PANEL} flex flex-col gap-3 p-[30px]`}>
            <Bar className="h-3 w-20" />
            <Bar className="h-7 w-32" />
            <Bar className="h-3 w-48" />
            <Bar className="mt-3 h-3 w-16" />
          </article>
        ))}
      </section>
    </div>
  );
}

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block rounded bg-mutedbg ${className}`} />;
}

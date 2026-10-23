'use client';

import { PANEL } from '@/components/dashboard/ui';
import { useI18n } from '@/lib/i18n/client';

/**
 * What the content column shows while a dashboard page is on its way: the
 * Suspense fallback of the route's `loading.tsx`, so a click answers at once
 * instead of leaving the previous screen in place until the next one has
 * finished its queries.
 *
 * Two shapes. `overview` is a workspace screen -- a header, a row of
 * figures, two cards -- and is what every top-level page swaps through.
 * `detail` is a page under a library -- a back chip, a title with badges, a
 * status banner, a tab row, a panel -- for the library, its files, a
 * document and the import wizard. Each is drawn with the same panel as the
 * page it stands in for, so the swap reads as the page arriving rather than a
 * spinner over it. Under reduced motion the blocks hold still; the status
 * text carries the state there.
 */
export function PageSkeleton({ variant }: { variant: 'overview' | 'detail' }) {
  const { t } = useI18n();
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t.dashboard.shell.loading}
      className="flex flex-col gap-[18px] motion-safe:animate-pulse"
    >
      {variant === 'overview' ? <Overview /> : <Detail />}
    </div>
  );
}

function Overview() {
  return (
    <>
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
    </>
  );
}

function Detail() {
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex flex-col gap-2.5">
          <Bar className="h-7 w-36 rounded-md" />
          <Bar className="mt-1 h-7 w-48" />
          <div className="flex gap-2">
            <Bar className="h-4 w-28" />
            <Bar className="h-4 w-12 rounded-full" />
            <Bar className="h-4 w-12 rounded-full" />
          </div>
        </div>
        <div className="flex gap-2">
          <Bar className="h-[35px] w-24 rounded-md" />
          <Bar className="h-[35px] w-24 rounded-md" />
        </div>
      </div>

      <section className={`${PANEL} flex items-start gap-4 px-[19px] py-4`}>
        <Bar className="size-9 shrink-0 rounded-md" />
        <div className="flex flex-1 flex-col gap-2">
          <Bar className="h-3.5 w-32" />
          <Bar className="h-3 w-2/3" />
        </div>
      </section>

      <div className="flex gap-6 border-b border-line pb-3">
        {Array.from({ length: 5 }, (_, index) => (
          <Bar key={index} className="h-3.5 w-16" />
        ))}
      </div>

      <section className={`${PANEL} flex flex-col gap-3 p-6`}>
        <Bar className="h-4 w-40" />
        <Bar className="h-3 w-3/4" />
        <Bar className="mt-2 h-3 w-1/2" />
        <Bar className="h-3 w-2/3" />
        <Bar className="h-3 w-1/3" />
      </section>
    </>
  );
}

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`block rounded bg-mutedbg ${className}`} />;
}

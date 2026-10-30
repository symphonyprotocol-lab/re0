'use client';

import { useSelectedLayoutSegments } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Whether a dashboard route is a focused one: a page that takes the whole
 * column and goes without the workspace rail. Today that is the editor of
 * an article or an episode (`assets/{id}/edit`), whose split view needs the
 * width. The segments are the ones below `app/dashboard`.
 */
export function isFocusedRoute(segments: readonly string[]): boolean {
  return segments.length === 3 && segments[0] === 'assets' && segments[2] === 'edit';
}

/**
 * The dashboard's column: the workspace rail and the page beside it, or the
 * page alone on a focused route. The layout renders the rail once and hands
 * it in; this only decides whether to show it, since a layout is not told
 * which page it is wrapping.
 */
export function DashboardColumns({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  const focused = isFocusedRoute(useSelectedLayoutSegments());
  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col items-start gap-7 px-5 pt-[34px] pb-16 lg:flex-row">
      {focused ? null : sidebar}
      <main className="w-full min-w-0 flex-1">{children}</main>
    </div>
  );
}

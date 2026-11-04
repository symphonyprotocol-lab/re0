'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { observeRouteMotion } from '@/lib/client/route-motion';
import './workspace-motion.css';

/** Animate committed routes in place: keep forms, selections, and the fixed header mounted. */
export function WorkspaceMain({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  return <RouteMotion className={`app-main${collapsed ? ' sidebar-collapsed' : ''}`}>{children}</RouteMotion>;
}

/** Shared content boundary for the product workspace and administrator console. */
export function RouteMotion({ className, children }: { className: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useLayoutEffect(() => {
    if (!root.current) return;
    return observeRouteMotion(root.current, window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, [pathname, search]);

  return <div ref={root} className={className}>{children}</div>;
}

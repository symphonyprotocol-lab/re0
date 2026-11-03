'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The Ree list's page (prototype admin-ree.js `page` / `afterRender`):
 * `.admin-ree-page`, and the table's `--admin-ree-table-height`, sized so the
 * table scrolls inside the window above its pages, recomputed when the
 * filter or the heading changes size and when the window resizes.
 */
export function ReeListPage({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const resize = () => {
      const wrap = root.querySelector<HTMLElement>('.table-wrap');
      const pager = root.querySelector<HTMLElement>('.admin-ree-pagination');
      if (!wrap || !pager) return;
      const top = wrap.getBoundingClientRect().top + window.scrollY;
      const height = Math.max(180, Math.min(760, window.innerHeight - top - pager.getBoundingClientRect().height - 24));
      root.style.setProperty('--admin-ree-table-height', `${height}px`);
    };
    const observer = new ResizeObserver(resize);
    for (const element of root.querySelectorAll('.admin-ree-filter, .page-head')) observer.observe(element);
    window.addEventListener('resize', resize);
    resize();
    const frame = requestAnimationFrame(resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <div ref={ref} className="admin-ree-page">
      {children}
    </div>
  );
}

'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

/**
 * A thin bar across the top of the viewport while a dashboard navigation is
 * on its way, so every click that leaves the page answers at once -- not
 * only the rail's, whose items carry their own spinner, but an asset row,
 * a back link, a tab of pages, a pager.
 *
 * It starts on the click itself: a capturing listener on the document sees
 * every same-origin link that leads somewhere else (not a new tab, not a
 * download, not a hash on the same page, not a modified click), and code
 * that navigates with `router.push` calls `startNavigationProgress`. It
 * finishes when the URL the router renders changes. A navigation that never
 * lands (an error page that keeps the URL, an aborted push) is let go after
 * `GIVE_UP_MS`, so the bar is never stuck. Under reduced motion it holds
 * still at a fixed width instead of creeping.
 */

const START_EVENT = 'dashboard:navigation-start';
const GIVE_UP_MS = 12_000;

/** For a navigation that does not come from a link click: `router.push`, a redirect after a dialog. */
export function startNavigationProgress(): void {
  window.dispatchEvent(new Event(START_EVENT));
}

function leavesPage(anchor: HTMLAnchorElement, event: MouseEvent): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (anchor.target && anchor.target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
  const next = new URL(anchor.href, window.location.href);
  if (next.origin !== window.location.origin) return false;
  /* The same page with only the hash changed is a scroll, not a navigation. */
  return next.pathname !== window.location.pathname || next.search !== window.location.search;
}

function Bar() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const giveUp = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Start on a click, or on an explicit start. */
  useEffect(() => {
    const start = () => {
      setPhase('running');
      if (giveUp.current) clearTimeout(giveUp.current);
      giveUp.current = setTimeout(() => setPhase('idle'), GIVE_UP_MS);
    };
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (anchor instanceof HTMLAnchorElement && leavesPage(anchor, event)) start();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener(START_EVENT, start);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener(START_EVENT, start);
      if (giveUp.current) clearTimeout(giveUp.current);
    };
  }, []);

  /* Finish when the rendered URL changes: fill the bar, then fade it out. */
  useEffect(() => {
    setPhase((current) => (current === 'running' ? 'done' : current));
  }, [pathname, search]);
  useEffect(() => {
    if (phase !== 'done') return;
    if (giveUp.current) clearTimeout(giveUp.current);
    const hide = setTimeout(() => setPhase('idle'), 260);
    return () => clearTimeout(hide);
  }, [phase]);

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-x-0 top-0 z-[100] h-[3px] transition-opacity duration-200 ${
        phase === 'idle' ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div
        className={`h-full bg-brand shadow-[0_0_8px_var(--color-brand)] ${
          phase === 'running'
            ? 'w-[30%] motion-safe:animate-[nav-progress_8s_cubic-bezier(0.1,0.7,0.2,1)_forwards]'
            : phase === 'done'
              ? 'w-full transition-[width] duration-200 ease-out'
              : 'w-0'
        }`}
      />
    </div>
  );
}

export function NavigationProgress() {
  /* `useSearchParams` needs a boundary of its own, or it opts the whole layout out of static rendering. */
  return (
    <Suspense fallback={null}>
      <Bar />
    </Suspense>
  );
}

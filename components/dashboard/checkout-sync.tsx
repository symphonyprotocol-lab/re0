'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { SpinnerIcon } from '@/components/ui/icons';

/** How long the page keeps asking before it leaves the buyer to refresh by hand. */
const SYNC_WINDOW_MS = 60_000;
const SYNC_INTERVAL_MS = 2_000;

/**
 * Rendered beside the "payment complete" notice that Paddle's success URL
 * lands on. The provider redirects the browser the moment the checkout
 * closes, and the webhook that changes the plan arrives up to a few seconds
 * later -- in production the two were half a second apart -- so the first
 * render of the settings page is stale by construction.
 *
 * `fingerprint` is whatever the webhook would change: the plan version, the
 * add-on balance, the newest billing document. The page is re-rendered every
 * couple of seconds until the server sends a different fingerprint, at which
 * point the `checkout` parameter is dropped so the notice goes away and the
 * polling with it. After a minute it gives up quietly; the notice still
 * tells the buyer to refresh.
 *
 * The fingerprint includes the newest document's status and the pack totals,
 * not only the document's id: a transaction mirrored as `billed` (open) turns
 * `paid` on a later event, which the id alone does not show.
 */
export function CheckoutSync({ fingerprint }: { fingerprint: string }) {
  const router = useRouter();
  const initial = useRef(fingerprint);
  const [gaveUp, setGaveUp] = useState(false);
  const changed = fingerprint !== initial.current;

  useEffect(() => {
    if (changed) {
      router.replace('/dashboard/settings#plan', { scroll: false });
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt >= SYNC_WINDOW_MS) {
        clearInterval(timer);
        setGaveUp(true);
        return;
      }
      router.refresh();
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [changed, router]);

  if (gaveUp || changed) return null;
  /* Static ring under reduced motion; the notice carries the state there. */
  return <SpinnerIcon size={12} className="ml-1.5 inline-block align-[-2px] motion-safe:animate-spin" />;
}

/**
 * The settings page pulls itself again whenever its tab comes back into view.
 * A checkout that was finished in another tab, or a webhook slower than the
 * minute `CheckoutSync` waits, then shows the moment the buyer looks, without
 * a manual reload. At most once every few seconds, so switching back and forth
 * does not hammer the server.
 */
export function RefreshOnReturn() {
  const router = useRouter();
  useEffect(() => {
    let last = 0;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last < 5_000) return;
      last = now;
      router.refresh();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [router]);
  return null;
}

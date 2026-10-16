'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { SpinnerIcon } from '@/components/ui/icons';

/** How long the page keeps asking before it leaves the buyer to refresh by hand. */
const SYNC_WINDOW_MS = 30_000;
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
 * polling with it. After half a minute it gives up quietly; the notice still
 * tells the buyer to refresh.
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

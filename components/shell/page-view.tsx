'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';

/** Never reported: the console and its sign-in (the server refuses them too). */
const SKIPPED = /^\/admin(\/|$)/;

/* The path a not-found page last rendered at (`NotFoundMark`). */
let missing: string | null = null;

/**
 * Rendered by the not-found pages: their path is no page of the site, so the
 * beacon reports nothing for it -- a mistyped link, an old `/posts/…` or a
 * deleted Ree is not a view of the page kind its path looks like. A child's
 * effects run before its layout's, so the mark is set before `PageView`'s
 * effect for the same path reads it.
 */
export function NotFoundMark() {
  const pathname = usePathname();
  useEffect(() => {
    missing = pathname;
  }, [pathname]);
  return null;
}

/**
 * Mounted once by the root layout: the site-wide page-view beacon
 * (`POST /api/track/view`, console 「流量」), once when a page opens and once
 * per client-side move to a new route. The first report carries
 * `document.referrer` and the URL's utm values; a client-side move reports
 * the page it came from as its referrer, which the server reads as
 * navigation inside the site. A first visit is answered `cookie` (the
 * visitor cookie was just set) and sent again with it. A not-found page
 * (`NotFoundMark`) is not reported.
 */
export function PageView() {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname || previous.current === pathname) return;
    const from = previous.current;
    previous.current = pathname;
    if (SKIPPED.test(pathname) || missing === pathname) return;
    const query = new URLSearchParams(window.location.search);
    const body = JSON.stringify({
      path: pathname,
      referrer: from === null ? document.referrer : `${window.location.origin}${from}`,
      utm_source: query.get('utm_source'),
      utm_medium: query.get('utm_medium'),
      utm_campaign: query.get('utm_campaign'),
    });
    const beacon = () =>
      fetch('/api/track/view', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body }).then((response) =>
        response.ok ? (response.json() as Promise<{ result?: string }>) : null,
      );
    void beacon()
      .then((reply) => (reply?.result === 'cookie' ? beacon() : null))
      .catch(() => undefined);
  }, [pathname]);
  return null;
}

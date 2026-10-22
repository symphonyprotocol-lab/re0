'use client';

import { useEffect, type CSSProperties, type ReactNode } from 'react';

/**
 * Counting on a showcase page, with nothing kept about the visitor: one
 * view per browser per half hour (a timestamp in sessionStorage, nothing
 * else), and a mark per CTA click. Both are beacons the page does not wait
 * for; a blocked or failed request costs the owner a count, never the
 * visitor anything.
 */
function beacon(slug: string, event: 'view' | 'cta_click'): void {
  try {
    void fetch(`/s/${encodeURIComponent(slug)}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* nothing to do */
  }
}

const VIEW_WINDOW_MS = 30 * 60 * 1000;

export function ShowcaseBeacon({ slug }: { slug: string }) {
  useEffect(() => {
    const key = `re0-showcase-view:${slug}`;
    try {
      const last = Number(sessionStorage.getItem(key) ?? 0);
      if (Date.now() - last < VIEW_WINDOW_MS) return;
      sessionStorage.setItem(key, String(Date.now()));
    } catch {
      /* private mode: count the view anyway */
    }
    beacon(slug, 'view');
  }, [slug]);
  return null;
}

export function TrackedLink({
  slug,
  href,
  className,
  style,
  children,
}: {
  slug: string;
  href: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener nofollow"
      className={className}
      style={style}
      onClick={() => beacon(slug, 'cta_click')}
    >
      {children}
    </a>
  );
}

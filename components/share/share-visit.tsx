'use client';

import { useEffect, useRef } from 'react';

/** Rendered by `/s/[slug]`: one visit beacon per page load (the server ignores repeats within 30 minutes). */
export function ShareVisit({ slug }: { slug: string }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void fetch(`/api/share/${encodeURIComponent(slug)}/visit`, { method: 'POST', keepalive: true }).catch(() => undefined);
  }, [slug]);
  return null;
}

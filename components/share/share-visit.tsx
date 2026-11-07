'use client';

import { useEffect, useRef } from 'react';

/**
 * Rendered by `/s/[slug]`: the visit beacon, once per page load. A first
 * visit is answered `cookie` (the visitor cookie was just set) and sent
 * again with it; the server keeps one visit per visitor every half hour.
 */
export function ShareVisit({ slug }: { slug: string }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const beacon = () => fetch(`/api/share/${encodeURIComponent(slug)}/visit`, { method: 'POST', keepalive: true }).then((response) => (response.ok ? (response.json() as Promise<{ result?: string }>) : null));
    void beacon()
      .then((body) => (body?.result === 'cookie' ? beacon() : null))
      .catch(() => undefined);
  }, [slug]);
  return null;
}

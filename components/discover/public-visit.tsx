'use client';

import { useEffect } from 'react';

/** The explore path the last public page returns to; read once by `/explore` (prototype discovery.js `hashchange` from `/d/`). */
let returnTo: string | null = null;

/** Rendered by `/r/[slug]`: going back to `from` puts the results head in view again. */
export function PublicVisit({ from }: { from: string }) {
  useEffect(() => {
    returnTo = from;
  }, [from]);
  return null;
}

/** Whether `/explore` at `path` is the way back from a public page; true only once. */
export function takePublicReturn(path: string): boolean {
  const back = returnTo === path;
  returnTo = null;
  return back;
}

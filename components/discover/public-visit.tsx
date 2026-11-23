'use client';

import { useEffect, useState } from 'react';
import { exploreBackPath } from '@/components/discover/explore-pages';

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

/*
 * Where a public Ree page's ← goes (GSC review 2026-11, A2). It used to
 * ride in the link as `?from=/explore?q=…`, so every search and category
 * minted another crawlable copy of every Ree page, passed on from one Ree to
 * the next. Now links are the bare `/r/{slug}`; the explore list it was
 * opened from is kept in this tab's sessionStorage, per Ree, and handed on
 * when that page opens another Ree. Server HTML always says `/explore`.
 */
const STORE = 're0:ree-return';
/** Rees remembered at once; the oldest go first. */
const KEPT = 50;

type Returns = Record<string, string>;

function read(): Returns {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(STORE) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Returns) : {};
  } catch {
    return {};
  }
}

/** Remember that `/r/{slug}` was opened from the explore list at `path` (only explore lists count; anything else forgets). */
export function rememberExploreReturn(slug: string, path: string | null | undefined): void {
  const key = slug.toLowerCase();
  const back = exploreBackPath(path);
  const all = read();
  delete all[key];
  if (back !== '/explore') all[key] = back;
  const entries = Object.entries(all).slice(-KEPT);
  try {
    window.sessionStorage.setItem(STORE, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* Storage unavailable (private mode, quota): ← goes to /explore. */
  }
}

/**
 * The explore list `/r/{slug}` goes back to: `/explore` on the server and in
 * the first render, then what this tab remembers. An old link's `?from=` is
 * still honoured once, and dropped from the address.
 */
export function useExploreReturn(slug: string, enabled = true): string {
  const [back, setBack] = useState('/explore');
  useEffect(() => {
    if (!enabled) return;
    const url = new URL(window.location.href);
    const legacy = url.searchParams.get('from');
    if (legacy !== null) {
      rememberExploreReturn(slug, legacy);
      url.searchParams.delete('from');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
    setBack(read()[slug.toLowerCase()] ?? '/explore');
  }, [slug, enabled]);
  return back;
}

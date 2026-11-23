'use client';

import { useEffect, useRef, useState } from 'react';

/** How far below the viewport the next page starts loading. */
const PRELOAD_MARGIN = '800px 0px';

/**
 * Loads the next page of a list as its sentinel (an element under the list)
 * nears the viewport. `active` is whether a page may load now: there is a
 * next one, none is in flight and the last one did not fail. A fresh
 * observer each time it turns true reports at once if the sentinel is still
 * in reach (a tall screen), so the list fills it. Without
 * IntersectionObserver, `observing` is false and the caller shows a "load
 * more" button instead.
 */
export function useLoadOnScroll<T extends Element>(load: () => unknown, active: boolean) {
  const sentinel = useRef<T>(null);
  const [observing, setObserving] = useState(true);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setObserving(false);
      return;
    }
    const target = sentinel.current;
    if (!target || !active) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load();
    }, { rootMargin: PRELOAD_MARGIN });
    observer.observe(target);
    return () => observer.disconnect();
  }, [active, load]);
  return { sentinel, observing };
}

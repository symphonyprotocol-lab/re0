'use client';

import { useEffect, useRef } from 'react';

/**
 * Whether a click on this link leaves the page in a way an unsaved form
 * would lose: a plain left click on a same-origin link to another address
 * (not a new tab, not a download, not just a `#hash` on this page).
 */
export function leavesPage(
  anchor: { href: string; target: string; hasAttribute(name: string): boolean },
  click: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  here: { origin: string; pathname: string; search: string },
): boolean {
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if ((anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return false;
  let next: URL;
  try {
    next = new URL(anchor.href, here.origin);
  } catch {
    return false;
  }
  if (next.origin !== here.origin) return true;
  return next.pathname !== here.pathname || next.search !== here.search;
}

/**
 * Warns before unsaved edits are lost (review C14): reloading or closing
 * the tab gets the browser's own prompt, and following a link inside the
 * app asks `message` first -- the click is stopped before Next.js's
 * `<Link>` sees it when the answer is no.
 */
export function useUnsavedChanges(dirty: boolean, message: string): void {
  const text = useRef(message);
  text.current = message;
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || event.defaultPrevented || !leavesPage(anchor, event, window.location)) return;
      if (window.confirm(text.current)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', click, true);
    };
  }, [dirty]);
}

'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import type { Locale } from '@/i18n/locale';
import { splitLocale } from '@/i18n/paths';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/lib/http/cookies';

/** The language the server renders a path in: a language URL's own, else the visitor's. */
export function renderedLocale(pathname: string, preferred: Locale): Locale {
  return splitLocale(pathname)?.locale ?? preferred;
}

/**
 * Both languages share one root layout, and a client-side navigation keeps
 * it -- `<html lang>` and the messages with it. So a navigation into a page
 * the server renders in the other language (`/en/...` from a Chinese page,
 * or the workspace in the visitor's own language from `/en/...`) becomes a
 * full load here, whatever started it:
 *
 * - a click on any same-origin link, caught before Next's Link sees it;
 * - Back and Forward, caught before the router restores a cached page;
 * - anything else (a router call, a server action's redirect), as soon as
 *   the new path commits.
 *
 * It also keeps the language cookie on the signed-in account's language
 * (`account`), which outranks it: the middleware, which cannot read the
 * account, sends plain public URLs by the cookie.
 */
export function LocaleBoundary({ locale, preferred, account }: { locale: Locale; preferred: Locale; account: Locale | null }) {
  const pathname = usePathname();
  /* The listeners are registered once, ahead of the router's own popstate listener; they read the current values here. */
  const current = useRef({ locale, preferred });
  current.current = { locale, preferred };

  useEffect(() => {
    const crosses = (path: string) => renderedLocale(path, current.current.preferred) !== current.current.locale;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== '_self') || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin || !crosses(url.pathname)) return;
      event.preventDefault();
      event.stopPropagation();
      window.location.assign(url.href);
    };
    const onPopState = (event: PopStateEvent) => {
      if (!crosses(window.location.pathname)) return;
      event.stopImmediatePropagation();
      window.location.reload();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  useEffect(() => {
    /* Once per URL: should the server ever disagree, the page stays as it is rather than reloading forever. */
    const key = 're0-locale-reload';
    try {
      if (renderedLocale(pathname, preferred) === locale) return sessionStorage.removeItem(key);
      if (sessionStorage.getItem(key) === window.location.href) return;
      sessionStorage.setItem(key, window.location.href);
    } catch {
      return;
    }
    window.location.reload();
  }, [pathname, preferred, locale]);

  useEffect(() => {
    const cookie = document.cookie.split('; ').find((part) => part.startsWith(`${LOCALE_COOKIE}=`))?.slice(LOCALE_COOKIE.length + 1);
    if (account && cookie !== account) document.cookie = `${LOCALE_COOKIE}=${account}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
  }, [account]);

  return null;
}

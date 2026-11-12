'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { isLocalizedPath, localizeHref, stripLocale } from './paths';
import type { Messages } from './index';
import type { Locale } from './locale';

/**
 * `locale` is the page's language; `preferred` the visitor's own, which
 * differs only on a language URL (`/en/...`) in the other language.
 */
const I18nContext = createContext<{ locale: Locale; preferred: Locale; t: Messages } | null>(null);

export function I18nProvider({ locale, preferred = locale, t, children }: { locale: Locale; preferred?: Locale; t: Messages; children: ReactNode }) {
  return <I18nContext.Provider value={{ locale, preferred, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): { locale: Locale; preferred: Locale; t: Messages } {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}

/**
 * Where a link goes from this page (i18n/paths.ts): a public page in this
 * page's language, anything else as it is. `reload` when the destination
 * renders in another language than this page -- one URL for both
 * languages, read in the visitor's own -- because a client-side navigation
 * keeps the root layout, and with it `<html lang>` and these messages.
 */
export function useLocaleHref(): (href: string) => { href: string; reload: boolean } {
  const { locale, preferred } = useI18n();
  return useCallback((href: string) => {
    const localized = localizeHref(locale, href);
    const internal = href.startsWith('/') && !href.startsWith('//');
    return { href: localized, reload: internal && preferred !== locale && !isLocalizedPath(stripLocale(localized.split(/[?#]/)[0]!)) };
  }, [locale, preferred]);
}

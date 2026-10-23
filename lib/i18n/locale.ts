/**
 * Locale rules, as pure functions. No Next.js, no cookies, no request object.
 *
 * The product ships in two languages and picks between them without touching
 * the URL: a visitor's browser decides the first render, an explicit choice is
 * remembered in a cookie, and every path keeps a single canonical form.
 */

export type Locale = 'zh' | 'en';

export const LOCALES: readonly Locale[] = ['zh', 'en'];

/**
 * Where a browser that asks for neither Chinese nor English lands.
 *
 * English is the wider fallback: a reader whose Chrome is set to French is
 * better served by English than by a language they did not ask for at all.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/** Readable by scripts on purpose -- the switcher sets it from the browser. */
export const LOCALE_COOKIE = 'r0_locale';

/** A year: long enough that a chosen language survives, short enough to lapse. */
export const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** `lang` attribute for `<html>`; distinct from the cookie value. */
export const HTML_LANG: Record<Locale, string> = { zh: 'zh-CN', en: 'en' };

/** `og:locale`, which wants the underscore form. */
export const OG_LOCALE: Record<Locale, string> = { zh: 'zh_CN', en: 'en_US' };

/** How each language names itself, for the switcher. */
export const LOCALE_LABEL: Record<Locale, string> = { zh: '中文', en: 'English' };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && LOCALES.includes(value as Locale);
}

interface Ranked {
  tag: string;
  quality: number;
}

/**
 * Picks a locale from an `Accept-Language` header.
 *
 * Ranges are honoured in quality order rather than header order, `*` is
 * ignored, and a range only matches on its primary subtag -- `zh-Hant-TW` and
 * `zh-CN` both resolve to Chinese, because we do not ship a script split.
 * Anything unparseable degrades to `DEFAULT_LOCALE` rather than throwing.
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const ranked: Ranked[] = [];
  for (const part of acceptLanguage.split(',')) {
    const [rawTag, ...parameters] = part.trim().split(';');
    const tag = (rawTag ?? '').trim().toLowerCase();
    if (!tag || tag === '*') continue;

    let quality = 1;
    for (const parameter of parameters) {
      const [key, value] = parameter.trim().split('=');
      if (key?.trim().toLowerCase() !== 'q') continue;
      const parsed = Number.parseFloat(value ?? '');
      quality = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0;
    }
    if (quality > 0) ranked.push({ tag, quality });
  }

  // Sort is stable in every runtime we target, so equal weights keep header order.
  ranked.sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    const primary = tag.split('-')[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}

/**
 * The locale for a request: an explicit choice first, the browser's own
 * preference second.
 */
export function resolveLocale(input: {
  cookie: string | null | undefined;
  acceptLanguage: string | null | undefined;
}): Locale {
  return isLocale(input.cookie) ? input.cookie : negotiateLocale(input.acceptLanguage);
}

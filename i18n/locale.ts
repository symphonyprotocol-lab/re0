/**
 * Which language a request is in: the signed-in user's `lang`, otherwise the
 * language cookie, otherwise the browser's Accept-Language; Chinese by default.
 */
export type Locale = 'zh' | 'en';
export const LOCALES: readonly Locale[] = ['zh', 'en'];
/** Each language's own name, as the language menu lists it (never translated). */
export const LOCALE_NAMES: Record<Locale, string> = { zh: '中文', en: 'English' };
/** `<html lang>` and other BCP 47 tags for each language. */
export const HTML_LANG: Record<Locale, string> = { zh: 'zh-CN', en: 'en' };

export function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en';
}

export function localeFromAcceptLanguage(header: string | null): Locale {
  if (!header) return 'zh';
  const first = header.split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('en') ? 'en' : 'zh';
}

export function localeFromRequest(
  cookie: (name: string) => { value: string } | undefined,
  acceptLanguage: string | null,
): Locale {
  const fromCookie = cookie('re0_lang')?.value;
  return isLocale(fromCookie) ? fromCookie : localeFromAcceptLanguage(acceptLanguage);
}

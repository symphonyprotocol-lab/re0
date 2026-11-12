import { cookies, headers } from 'next/headers';
import { currentUser } from '@/lib/http/session';
import { messages, type Messages } from './index';
import { isLocale, localeFromAcceptLanguage, type Locale } from './locale';
import { LOCALE_HEADER } from './paths';

/**
 * The request's language: a language URL's (`/en/...`, set by the
 * middleware and never by the client), else the visitor's preference.
 */
export async function requestLocale(): Promise<Locale> {
  const fromUrl = (await headers()).get(LOCALE_HEADER);
  return isLocale(fromUrl) ? fromUrl : preferredLocale();
}

/** The visitor's own language, whatever the URL: the user's setting, the language cookie, the browser. */
export async function preferredLocale(): Promise<Locale> {
  const user = await currentUser().catch(() => null);
  if (user && isLocale(user.lang)) return user.lang;
  const jar = await cookies();
  const cookie = jar.get('re0_lang')?.value;
  if (isLocale(cookie)) return cookie;
  return localeFromAcceptLanguage((await headers()).get('accept-language'));
}

export async function serverMessages(): Promise<{ locale: Locale; t: Messages }> {
  const locale = await requestLocale();
  return { locale, t: messages(locale) };
}

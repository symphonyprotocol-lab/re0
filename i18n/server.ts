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
  return isLocale(fromUrl) ? fromUrl : (await localePreference()).preferred;
}

/**
 * The visitor's own language, whatever the URL: the signed-in user's
 * setting (`account`), the language cookie, the browser.
 */
export async function localePreference(): Promise<{ preferred: Locale; account: Locale | null }> {
  const user = await currentUser().catch(() => null);
  if (user && isLocale(user.lang)) return { preferred: user.lang, account: user.lang };
  const jar = await cookies();
  const cookie = jar.get('re0_lang')?.value;
  if (isLocale(cookie)) return { preferred: cookie, account: null };
  return { preferred: localeFromAcceptLanguage((await headers()).get('accept-language')), account: null };
}

export async function serverMessages(): Promise<{ locale: Locale; t: Messages }> {
  const locale = await requestLocale();
  return { locale, t: messages(locale) };
}

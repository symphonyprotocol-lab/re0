import { cookies, headers } from 'next/headers';
import { currentUser } from '@/lib/http/session';
import { messages, type Messages } from './index';
import { isLocale, localeFromAcceptLanguage, type Locale } from './locale';

/** The request's language: the user's setting, the language cookie, the browser. */
export async function requestLocale(): Promise<Locale> {
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

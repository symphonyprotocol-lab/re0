import { NextResponse, type NextRequest } from 'next/server';
import { isLocale } from '@/i18n/locale';
import { LOCALE_COOKIE, LOCALE_COOKIE_OPTIONS } from '@/lib/http/cookies';
import { body } from '@/lib/http/respond';

/** The language switch for visitors who are not signed in (signed-in users save it on the account). */
export async function POST(request: NextRequest) {
  const lang = (await body(request)).lang;
  if (!isLocale(lang)) return NextResponse.json({ error: 'lang' }, { status: 422 });
  const response = NextResponse.json({ lang });
  response.cookies.set(LOCALE_COOKIE, lang, LOCALE_COOKIE_OPTIONS);
  return response;
}

import { NextResponse, type NextRequest } from 'next/server';
import { DISPLAY_NAME_MAX } from '@/lib/constants';
import { profileChanges } from '@/lib/domain/account';
import { LOCALE_COOKIE } from '@/lib/http/cookies';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { isLocale } from '@/i18n/locale';
import { balanceOf } from '@/lib/services/credits';
import { db, schema } from '@/lib/infra/db';
import { eq } from 'drizzle-orm';

function shown(user: typeof schema.user.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    title: user.title,
    description: user.description,
    website: user.website,
    socialContacts: user.socialContacts,
    avatarBlob: user.avatarBlob,
    lang: user.lang,
    provider: user.provider,
    providerHandle: user.providerHandle,
    lastLoginAt: user.lastLoginAt,
  };
}

export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json({ account: shown(user), balance: await balanceOf(db(), user.id) });
}

/** Profile, avatar (an owned upload or null for the default) and language. */
export async function PATCH(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  const details = profileChanges(input);
  if ('error' in details) return fail(details.error, 422);
  const changes: Partial<typeof schema.user.$inferInsert> = { ...details.changes };
  if ('name' in input) {
    const name = String(input.name ?? '').trim();
    if (!name || Array.from(name).length > DISPLAY_NAME_MAX) return fail('name', 422);
    changes.name = name;
  }
  if ('avatarBlob' in input) {
    const avatar = input.avatarBlob;
    // OAuth photos are external URLs. Keeping the current photo is valid;
    // replacing it still requires this user's uploaded avatar pathname.
    if (avatar !== user.avatarBlob && avatar !== null && !(typeof avatar === 'string' && avatar.startsWith(`avatars/${user.id}/`))) return fail('avatar', 422);
    changes.avatarBlob = avatar as string | null;
  }
  if ('lang' in input) {
    if (!isLocale(input.lang)) return fail('lang', 422);
    changes.lang = input.lang;
  }
  const [updated] = Object.keys(changes).length
    ? await db().update(schema.user).set(changes).where(eq(schema.user.id, user.id)).returning()
    : [user];
  const response = NextResponse.json({ account: shown(updated!) });
  if (changes.lang) response.cookies.set(LOCALE_COOKIE, changes.lang, { path: '/', maxAge: 365 * 24 * 3600, sameSite: 'lax' });
  return response;
}

import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { listNotices, markNoticesRead } from '@/lib/services/notices';
import { isUuid } from '@/lib/domain/list';

/** The user's notices, newest first, 20 a page, with the unread count the sidebar dot reads. */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json(await listNotices(user.id, Number(request.nextUrl.searchParams.get('page')) || 1));
}

/** `{ ids }` or `{ all: true }`: marks notices read. */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  if (input.all === true) return json({ read: await markNoticesRead(user.id, 'all') });
  const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === 'string' && isUuid(id)) : null;
  if (!ids) return fail('ids', 422);
  return json({ read: await markNoticesRead(user.id, ids.slice(0, 100)) });
}

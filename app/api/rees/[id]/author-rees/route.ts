import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { currentUser } from '@/lib/http/session';
import { publicAuthorOthers } from '@/lib/services/public-rees';
import { favoriteReeIds } from '@/lib/services/ree-favorites';

type Context = { params: Promise<{ id: string }> };

/**
 * `GET ?page=<n>` → `{items, total, page, pages, favoriteIds?}`: one page of
 * 同一创作者的更多 Ree on a public Ree's page, the page past the last pulled
 * back to it. The page's pager fetches this instead of linking `?ap=<n>`,
 * so crawlers (robots.txt keeps them off `/api/`) see no pages to follow.
 * Open to visitors, counted as browsing; signed in, `favoriteIds` marks the
 * Rees on the page the viewer has saved. 404 for a Ree that is not public.
 */
export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  const raw = request.nextUrl.searchParams.get('page') ?? '1';
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) return fail('invalid_page', 400);
  const user = await currentUser();
  const limited = await rateLimited('browse', { userId: user?.id ?? null, headers: request.headers });
  if (limited) return limited;
  const list = await publicAuthorOthers(id, Number(raw));
  if (!list) return fail('not_found', 404);
  const favoriteIds = user ? await favoriteReeIds(user.id, list.items.map((item) => item.id)) : undefined;
  return json({ ...list, favoriteIds });
}

import type { NextRequest } from 'next/server';
import { parseExploreBatch, parseExploreQuery } from '@/lib/domain/explore';
import { clientIp } from '@/lib/http/conversations';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { currentUser } from '@/lib/http/session';
import { allowSearch, explore, ExploreCursorError } from '@/lib/services/explore';
import { favoriteReeIds } from '@/lib/services/ree-favorites';

/**
 * `GET /api/explore?q&category&sort=active|answers|free&size=24|48|96&cursor`
 * → `{mode, items, total, nextCursor, favoriteIds?}`: one batch of `/explore`'s
 * infinitely scrolled list, the next starting at `nextCursor` (null at the
 * end; a question's results come in one batch). Open to visitors; free, so a
 * search with a question is counted per IP and per account, browsing per
 * account or IP (429 past either limit). Signed in, `favoriteIds` marks the
 * batch's Rees the viewer has saved.
 */
export async function GET(request: NextRequest) {
  const query = parseExploreQuery(request.nextUrl.searchParams);
  const batch = parseExploreBatch(request.nextUrl.searchParams);
  const user = await currentUser();
  if (query.q && !batch.cursor) {
    if (!(await allowSearch({ ip: clientIp(request.headers), userId: user?.id ?? null }))) return fail('rate_limited', 429);
  } else {
    const limited = await rateLimited('browse', { userId: user?.id ?? null, headers: request.headers });
    if (limited) return limited;
  }
  try {
    const result = await explore(query, batch);
    const favoriteIds = user ? await favoriteReeIds(user.id, result.items.map((ree) => ree.id)) : undefined;
    return json({ ...result, favoriteIds });
  } catch (error) {
    if (error instanceof ExploreCursorError) return fail('invalid_cursor');
    throw error;
  }
}

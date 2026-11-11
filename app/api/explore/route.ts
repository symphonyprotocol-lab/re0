import type { NextRequest } from 'next/server';
import { parseExploreQuery } from '@/lib/domain/explore';
import { clientIp } from '@/lib/http/conversations';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { currentUser } from '@/lib/http/session';
import { allowSearch, explore } from '@/lib/services/explore';

/**
 * `GET /api/explore?q&category&sort=active|answers|free&size=24|48|96&page`
 * → `{mode, items, total, page, size}`. Open to visitors; free, so a search
 * with a question is counted per IP and per account, browsing per account or
 * IP (429 past either limit).
 */
export async function GET(request: NextRequest) {
  const query = parseExploreQuery(request.nextUrl.searchParams);
  const user = await currentUser();
  if (query.q) {
    if (!(await allowSearch({ ip: clientIp(request.headers), userId: user?.id ?? null }))) return fail('rate_limited', 429);
  } else {
    const limited = await rateLimited('browse', { userId: user?.id ?? null, headers: request.headers });
    if (limited) return limited;
  }
  return json(await explore(query));
}

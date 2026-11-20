import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { privateReeOptions } from '@/lib/services/private-posts';

/**
 * `GET ?q=` → `{items}`: Rees the viewer may ask privately (public ones and
 * their own, with ready knowledge) matching `q`, with what each answer costs
 * them -- the private composer's "选 Ree" and the thread's "加 Ree".
 * `?ids=a,b` resolves the Rees a link preselects instead (`?compose=private&rees=`).
 * `?scope=post`: the public Rees taking posts that "请 Ree 回答" may ask.
 */
export async function GET(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('browse', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const params = request.nextUrl.searchParams;
  const ids = params.get('ids');
  const scope = params.get('scope') === 'post' ? 'post' : 'private';
  return json({ items: await privateReeOptions(user.id, ids !== null ? { ids: ids.split(',').slice(0, 10), scope } : { q: params.get('q'), scope }) });
}

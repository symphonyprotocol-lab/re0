import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { setPostSaved } from '@/lib/services/posts';

type Context = { params: Promise<{ id: string }> };

/** `{on}`: "收藏" a visible post → `{saved}`. */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const on = (await body(request)).on !== false;
  return (await setPostSaved(user.id, (await params).id, on)) ? json({ saved: on }) : fail('not_found', 404);
}

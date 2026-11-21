import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { reporterKey } from '@/lib/http/reporter';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { reportPost } from '@/lib/services/posts';

type Context = { params: Promise<{ id: string }> };

/**
 * "举报" a post's question, signed in or not: one report per account, or
 * per visitor network (IPv6 by /48) whatever cookie is sent. Enough
 * distinct reporters take the post down until an administrator looks.
 */
export async function POST(request: NextRequest, { params }: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const user = await currentUser();
  const limited = await rateLimited('postAction', { userId: user?.id ?? null, headers: request.headers });
  if (limited) return limited;
  const reporter = await reporterKey(request, user?.id ?? null);
  if (!reporter) return fail('no_client_address', 400);
  return (await reportPost((await params).id, reporter)) ? json({ reported: true }) : fail('not_found', 404);
}

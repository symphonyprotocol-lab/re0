import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { reporterKey } from '@/lib/http/reporter';
import { rateLimited } from '@/lib/http/rate-limit';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { reportAnswer } from '@/lib/services/posts';

type Context = { params: Promise<{ answerId: string }> };

/**
 * "举报" a post's answer, signed in or not (the public Q&A's rule): one
 * report per account; a visitor counts once per network -- the address,
 * IPv6 by /48, as an HMAC -- whatever cookie they send. A request without
 * an address is refused.
 */
export async function POST(request: NextRequest, { params }: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const user = await currentUser();
  const limited = await rateLimited('postAction', { userId: user?.id ?? null, headers: request.headers });
  if (limited) return limited;
  const reporter = await reporterKey(request, user?.id ?? null);
  if (!reporter) return fail('no_client_address', 400);
  return (await reportAnswer((await params).answerId, reporter)) ? json({ reported: true }) : fail('not_found', 404);
}

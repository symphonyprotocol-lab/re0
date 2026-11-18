import type { NextRequest } from 'next/server';
import { ipBucket } from '@/lib/domain/anonymous-chat';
import { clientIp } from '@/lib/http/conversations';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { quotaKeyHash } from '@/lib/services/anonymous-chat';
import { reportAnswer } from '@/lib/services/posts';

type Context = { params: Promise<{ answerId: string }> };

/**
 * "举报" a post's answer, signed in or not (the public Q&A's rule): one
 * report per account; a visitor counts once per network -- the address,
 * IPv6 by /64, as an HMAC -- whatever cookie they send. A request without
 * an address is refused.
 */
export async function POST(request: NextRequest, { params }: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const user = await currentUser();
  const limited = await rateLimited('postAction', { userId: user?.id ?? null, headers: request.headers });
  if (limited) return limited;
  let reporter: string;
  if (user) {
    reporter = `user:${user.id}`;
  } else {
    const ip = clientIp(request.headers);
    if (!ip) return fail('no_client_address', 400);
    reporter = `anon-ip:${await quotaKeyHash('ip', ipBucket(ip))}`;
  }
  return (await reportAnswer((await params).answerId, reporter)) ? json({ reported: true }) : fail('not_found', 404);
}

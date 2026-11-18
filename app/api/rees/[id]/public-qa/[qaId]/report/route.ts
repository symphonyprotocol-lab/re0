import type { NextRequest } from 'next/server';
import { ipBucket } from '@/lib/domain/anonymous-chat';
import { clientIp } from '@/lib/http/conversations';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { quotaKeyHash } from '@/lib/services/anonymous-chat';
import { reportPublicQa } from '@/lib/services/public-qa';

type Context = { params: Promise<{ id: string; qaId: string }> };

/**
 * "举报" a public answer, signed in or not. One report per account; a
 * visitor counts once per network -- the address, IPv6 by /64, the key
 * anonymous chat counts by, stored as an HMAC -- whatever cookie they
 * send, so a script cannot become several reporters and hide an answer
 * alone. A request without an address is refused. Enough distinct
 * reporters hide the answer.
 */
export async function POST(request: NextRequest, { params }: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const user = await currentUser();
  const limited = await rateLimited('publicQa', { userId: user?.id ?? null, headers: request.headers });
  if (limited) return limited;
  let reporter: string;
  if (user) {
    reporter = `user:${user.id}`;
  } else {
    const ip = clientIp(request.headers);
    if (!ip) return fail('no_client_address', 400);
    reporter = `anon-ip:${await quotaKeyHash('ip', ipBucket(ip))}`;
  }
  const { id, qaId } = await params;
  return (await reportPublicQa(id, qaId, reporter)) ? json({ reported: true }) : fail('not_found', 404);
}

import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { ANONYMOUS_ID_COOKIE, ANONYMOUS_ID_MAX_AGE_SECONDS, validAnonymousId } from '@/lib/domain/anonymous-chat';
import { isSecureDeployment } from '@/lib/http/cookies';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { quotaKeyHash } from '@/lib/services/anonymous-chat';
import { reportPublicQa } from '@/lib/services/public-qa';

type Context = { params: Promise<{ id: string; qaId: string }> };

/**
 * "举报" a public answer, signed in or not. One report per account, or per
 * anonymous id cookie (stored as an HMAC) for a visitor, issued here when
 * the browser has none. Enough distinct reports hide the answer.
 */
export async function POST(request: NextRequest, { params }: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const user = await currentUser();
  const limited = await rateLimited('publicQa', { userId: user?.id ?? null, headers: request.headers });
  if (limited) return limited;
  let reporter: string;
  let issued: string | null = null;
  if (user) {
    reporter = `user:${user.id}`;
  } else {
    const current = request.cookies.get(ANONYMOUS_ID_COOKIE)?.value;
    const anonymousId = validAnonymousId(current) ? current : (issued = randomUUID());
    reporter = `anon:${await quotaKeyHash('id', anonymousId)}`;
  }
  const { id, qaId } = await params;
  const response = (await reportPublicQa(id, qaId, reporter)) ? json({ reported: true }) : fail('not_found', 404);
  if (issued) response.headers.append('set-cookie', `${ANONYMOUS_ID_COOKIE}=${issued}; Path=/; Max-Age=${ANONYMOUS_ID_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${isSecureDeployment() ? '; Secure' : ''}`);
  return response;
}

import type { NextRequest } from 'next/server';
import { clientIp } from '@/lib/http/conversations';
import { fail, json } from '@/lib/http/respond';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { keepVisitor, visitorOf } from '@/lib/http/share';
import { recordShareVisit } from '@/lib/services/share';

type Context = { params: Promise<{ slug: string }> };

/**
 * `POST /api/share/[slug]/visit` → `{result}`: the share page's beacon,
 * sent when `/s/[slug]` opens. Open to visitors; same-origin only, so
 * another site cannot inflate the count. A browser without the visitor
 * cookie gets one and `{result: 'cookie'}`, and the page sends the beacon
 * once more. A private or unknown Ree is 404; past the IP limit, 429.
 */
export async function POST(request: NextRequest, context: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const visitor = visitorOf(request);
  const [user, { slug }] = await Promise.all([currentUser(), context.params]);
  const result = await recordShareVisit({ slug, visitorId: visitor.id, freshVisitor: visitor.fresh, userId: user?.id ?? null, ip: clientIp(request.headers) });
  if (result === 'not_found') return fail('not_found', 404);
  if (result === 'limited') return fail('rate_limited', 429);
  return keepVisitor(json({ result }), visitor);
}

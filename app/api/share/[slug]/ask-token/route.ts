import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { sameOrigin } from '@/lib/http/session';
import { freeReeForAnonymous, shareAskToken } from '@/lib/services/anonymous-chat';
import { publicReeBySlug } from '@/lib/services/public-rees';

type Context = { params: Promise<{ slug: string }> };

/**
 * `POST /api/share/[slug]/ask-token` → `{token}`: a fresh question token for
 * a share page left open past its 12 hours (anonymous-chat.ts
 * `shareAskToken`). It gives exactly what loading `/s/[slug]` gives -- a
 * token for that page's Ree, only when a visitor may ask it there (public,
 * published, free) -- so asking stays bound to the share page. Same-origin
 * only; a private, paid or unknown Ree is 404.
 */
export async function POST(request: NextRequest, context: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const limited = await rateLimited('browse', { userId: null, headers: request.headers });
  if (limited) return limited;
  const ree = await publicReeBySlug((await context.params).slug);
  const free = ree ? await freeReeForAnonymous(ree.id) : null;
  if (!free) return fail('not_found', 404);
  return json({ token: await shareAskToken(free.id) });
}

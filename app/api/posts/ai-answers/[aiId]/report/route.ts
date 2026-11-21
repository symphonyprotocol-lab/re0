import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { reporterKey } from '@/lib/http/reporter';
import { rateLimited } from '@/lib/http/rate-limit';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { reportAiAnswer } from '@/lib/services/ai-answers';

type Context = { params: Promise<{ aiId: string }> };

/**
 * "举报" an AI general answer anyone reads (a public post's, passed
 * review), signed in or not -- the rule of a Ree's answer: one report per
 * account; a visitor counts once per network (the address, IPv6 by /48, as
 * an HMAC). A request without an address is refused. Enough reporters take
 * it down (ai-answers.ts `reportAiAnswer`).
 */
export async function POST(request: NextRequest, { params }: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const user = await currentUser();
  const limited = await rateLimited('postAction', { userId: user?.id ?? null, headers: request.headers });
  if (limited) return limited;
  const reporter = await reporterKey(request, user?.id ?? null);
  if (!reporter) return fail('no_client_address', 400);
  return (await reportAiAnswer((await params).aiId, reporter)) ? json({ reported: true }) : fail('not_found', 404);
}

import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { reporterKey } from '@/lib/http/reporter';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { reportFollowup } from '@/lib/services/post-followups';

type Context = { params: Promise<{ followupId: string }> };

/** "举报" a follow-up (追问), signed in or not, once per reporter: enough distinct reporters hide it, and its answers, for everyone but its asker. */
export async function POST(request: NextRequest, { params }: Context) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const user = await currentUser();
  const limited = await rateLimited('postAction', { userId: user?.id ?? null, headers: request.headers });
  if (limited) return limited;
  const reporter = await reporterKey(request, user?.id ?? null);
  if (!reporter) return fail('no_client_address', 400);
  return (await reportFollowup((await params).followupId, reporter)) ? json({ reported: true }) : fail('not_found', 404);
}

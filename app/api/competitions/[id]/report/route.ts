import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { reporterKey } from '@/lib/http/reporter';
import { currentUser, sameOrigin } from '@/lib/http/session';
import { reportCompetition } from '@/lib/services/competitions';

/** "举报" a competition, signed in or not: one report per account or visitor network; the console reviews them. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const user = await currentUser();
  const limited = await rateLimited('postAction', { userId: user?.id ?? null, headers: request.headers });
  if (limited) return limited;
  const reporter = await reporterKey(request, user?.id ?? null);
  if (!reporter) return fail('no_client_address', 400);
  return (await reportCompetition((await params).id, reporter)) ? json({ reported: true }) : fail('not_found', 404);
}

import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { setAnswerUnhelpful } from '@/lib/services/private-posts';

type Context = { params: Promise<{ answerId: string }> };

/** `{on}`: "没帮助" on an answer of the viewer's own private post → `{unhelpful, unvoted, helpful, voted}`; 404 for any other answer. */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const on = (await body(request)).on !== false;
  const result = await setAnswerUnhelpful(user.id, (await params).answerId, on);
  return result ? json(result) : fail('not_found', 404);
}

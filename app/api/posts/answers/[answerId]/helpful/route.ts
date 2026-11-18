import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { setAnswerHelpful } from '@/lib/services/posts';

type Context = { params: Promise<{ answerId: string }> };

/** `{on}`: "有帮助" on a post's answer, signed in only → `{helpful, voted}`. */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const on = (await body(request)).on !== false;
  const result = await setAnswerHelpful(user.id, (await params).answerId, on);
  return result ? json(result) : fail('not_found', 404);
}

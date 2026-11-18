import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { setHelpful } from '@/lib/services/public-qa';

type Context = { params: Promise<{ id: string; qaId: string }> };

/** `{on}`: "有帮助" on a public answer, signed in only → `{helpful, voted}`. */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('publicQa', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const { id, qaId } = await params;
  const on = (await body(request)).on !== false;
  const result = await setHelpful(user.id, id, qaId, on);
  return result ? json(result) : fail('not_found', 404);
}

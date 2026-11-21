import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { voteAiAnswer } from '@/lib/services/ai-answers';

type Context = { params: Promise<{ aiId: string }> };

/**
 * 有帮助 / 没帮助 on the caller's own AI answer: `{vote: 'helpful' |
 * 'unhelpful' | null}` → `{vote}`. Only its asker; it counts toward no Ree.
 */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const input = await body(request);
  const vote = input.vote === 'helpful' || input.vote === 'unhelpful' ? input.vote : null;
  const result = await voteAiAnswer(user.id, (await params).aiId, vote);
  return result ? json(result) : fail('not_found', 404);
}

import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { summarizePost } from '@/lib/services/posts';

export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/**
 * "圆桌总结" of the author's own post, for everyone to read: holds
 * POST_SUMMARY_FEE, settles it when written, gives it back on failure.
 * 402 with the balance; 409 `already_summarized` / `summary_running`; 422
 * `not_enough_answers`; 502 `summary_failed`.
 */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const result = await summarizePost(user.id, (await params).id, user.lang);
  if (typeof result === 'object') return json(result, 402);
  switch (result) {
    case 'done':
      return json({ done: true });
    case 'not_found':
      return fail('not_found', 404);
    case 'not_enough_answers':
      return fail('not_enough_answers', 422);
    case 'already':
      return fail('already_summarized', 409);
    case 'running':
      return fail('summary_running', 409);
    default:
      return fail('summary_failed', 502);
  }
}

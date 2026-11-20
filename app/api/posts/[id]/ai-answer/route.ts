import { after, type NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { retryAiAnswer, runAiAnswer } from '@/lib/services/ai-answers';

export const maxDuration = 120;

type Context = { params: Promise<{ id: string }> };

/**
 * "生成 AI 回答 · 20 credits": the caller's AI answer to this post's first
 * round (or to `{followupId}`, their follow-up), skipped for a short balance,
 * generated once by hand → `{ok}`; it is written after the response (the
 * post page polls). 402 with the balance still short; 409 `already` once
 * generated (once only) and `answered` once a Ree has answered the round;
 * 404 when there is none of theirs.
 */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const input = await body(request);
  const followupId = typeof input.followupId === 'string' ? input.followupId : null;
  const result = await retryAiAnswer(user.id, (await params).id, followupId);
  if (result.ok) {
    after(() => runAiAnswer(result.id).catch((error: unknown) => console.error(`ai answer ${result.id} not written: ${error instanceof Error ? error.message : 'unknown'}`)));
    return json({ ok: true });
  }
  if (result.error === 'insufficient') return json({ error: 'insufficient_credits', balance: result.balance, needed: result.needed }, 402);
  if (result.error === 'already' || result.error === 'answered') return fail(result.error, 409);
  return fail('not_found', 404);
}

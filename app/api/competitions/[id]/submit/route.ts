import { after, type NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { reviewCompetition, submitCompetition } from '@/lib/services/competitions';

export const maxDuration = 120;

/**
 * 提交发布: the deposit held, the review started after the response (the
 * cron retries it) → `{ok}`. 402 with `{balance, needed}` when the deposit
 * cannot be held; 409 `locked` once submitted; 400 for what the draft
 * still lacks (questions, a deadline 1–60 days ahead); 403 for a host Q1
 * does not let host yet, or one with two competitions running.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const { id } = await params;
  const result = await submitCompetition(user.id, id);
  if (result.ok) {
    after(() => reviewCompetition(id).catch((error: unknown) => console.error(`competition ${id} review: ${error instanceof Error ? error.message : 'unknown'}`)));
    return json({ ok: true });
  }
  if (result.error === 'insufficient') return json({ error: 'insufficient_credits', balance: result.balance, needed: result.needed }, 402);
  if (result.error === 'not_found') return fail('not_found', 404);
  if (result.error === 'locked') return fail('locked', 409);
  if (result.error === 'too_many_active' || result.error === 'host_too_new' || result.error === 'host_needs_ree') return fail(result.error, 403);
  return fail(result.error, 400);
}

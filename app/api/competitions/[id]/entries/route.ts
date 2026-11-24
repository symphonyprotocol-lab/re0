import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { enterCompetition } from '@/lib/services/competitions';

/**
 * 提交我的 Ree `{reeId}` → 201 `{entryId}`. Nothing is charged now; an
 * entrant who pays is checked for the balance (402 `{balance, needed}`).
 * 409 for `closed`, `already`, `full`, `per_user_limit`; 403 for the host's
 * own competition or a Ree not theirs, public and ready.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const input = await body(request);
  const result = await enterCompetition(user.id, (await params).id, typeof input.reeId === 'string' ? input.reeId : '');
  if (result.ok) return json({ entryId: result.entryId }, 201);
  if (result.error === 'insufficient') return json({ error: 'insufficient_credits', balance: result.balance, needed: result.needed }, 402);
  if (result.error === 'not_found') return fail('not_found', 404);
  if (result.error === 'daily_limit') return fail(result.error, 429);
  if (result.error === 'own_competition' || result.error === 'not_your_ree' || result.error === 'ree_not_ready') return fail(result.error, 403);
  return fail(result.error, 409);
}

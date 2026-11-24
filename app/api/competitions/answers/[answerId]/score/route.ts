import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { setHostScore } from '@/lib/services/competitions';

/** 改分 `{score, note}` (0–10, a reason 1–500): the host's, during review; logged → `{score}`. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ answerId: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  const result = await setHostScore(user.id, (await params).answerId, { score: input.score, note: input.note });
  if (result.ok) return json({ score: result.score });
  if (result.error === 'not_found') return fail('not_found', 404);
  if (result.error === 'rate_limited') return fail('rate_limited', 429);
  if (result.error === 'locked' || result.error === 'not_answered') return fail(result.error, 409);
  return fail(result.error, 400);
}

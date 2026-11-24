import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { trialJudge } from '@/lib/services/competitions';

export const maxDuration = 120;

/** 试评 `{questionId, answer}` on a draft → `{score, runs, charged}`, one judge fee; 402 when it cannot be held, 502 `judge_failed` (fee given back). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const input = await body(request);
  const result = await trialJudge(user.id, (await params).id, { questionId: input.questionId, answer: input.answer });
  if (result.ok) return json({ score: result.score, runs: result.runs, charged: result.charged });
  if (result.error === 'insufficient') return json({ error: 'insufficient_credits', balance: result.balance, needed: result.needed }, 402);
  if (result.error === 'not_found') return fail('not_found', 404);
  if (result.error === 'locked') return fail('locked', 409);
  if (result.error === 'judge_failed') return fail('judge_failed', 502);
  return fail(result.error, 400);
}

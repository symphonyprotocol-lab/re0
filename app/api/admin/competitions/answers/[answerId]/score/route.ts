import type { NextRequest } from 'next/server';
import { adminParams } from '@/lib/http/admin-params';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { adminSetScore } from '@/lib/services/competitions';

/** Q7: an administrator's score correction `{score, note}`, in review or after the results (ranks recomputed, movers told). Logged. */
export async function POST(request: NextRequest, context: { params: Promise<{ answerId: string }> }) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const params = await adminParams(context.params);
  if (params instanceof Response) return params;
  const input = await body(request);
  const result = await adminSetScore(administrator.id, params.answerId, { score: input.score, note: input.note });
  if (result.ok) return json({ score: result.score });
  if (result.error === 'not_found') return fail('not_found', 404);
  if (result.error === 'locked' || result.error === 'not_answered') return fail(result.error, 409);
  return fail(result.error, 400);
}

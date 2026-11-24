import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { setQuestions } from '@/lib/services/competitions';

/** 出题 `{questions: [{question, detail, referenceAnswer, rubric, weight}]}`: the whole set, 1–20, while a draft → `{count}`. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const result = await setQuestions(user.id, (await params).id, (await body(request)).questions);
  if (result.ok) return json({ count: result.count });
  if (result.error === 'not_found') return fail('not_found', 404);
  if (result.error === 'locked') return fail('locked', 409);
  return fail(result.error, 400, result.field ? { field: result.field } : {});
}

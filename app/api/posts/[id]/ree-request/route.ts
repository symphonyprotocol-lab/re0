import { after, type NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser } from '@/lib/http/session';
import { answerPaid, requestReeAnswer } from '@/lib/services/posts';

export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/**
 * "请 Ree 回答": `{reeId}` asks one public Ree to answer the first round of
 * the caller's own public post no Ree answered → `{id, state}`. `answering`:
 * a free Ree, its base fee held, writing after the response; `awaiting`: a
 * paid Ree (or a balance short of the base fee) shown as a request card to
 * agree to. 409 `busy` (another Ree is answering or waits), `already` (this
 * Ree was asked here), `answered` (a Ree has answered); 422 `unavailable`
 * (not a public Ree taking posts with ready knowledge); 404 otherwise.
 */
export async function POST(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const input = await body(request);
  const result = await requestReeAnswer(user.id, (await params).id, String(input.reeId ?? ''));
  if (result.ok) {
    if (result.state === 'answering') after(() => answerPaid(result.id).catch((error: unknown) => console.error(`requested answer ${result.id} not written: ${error instanceof Error ? error.message : 'unknown'}`)));
    return json({ id: result.id, state: result.state }, 201);
  }
  if (result.error === 'unavailable') return fail('unavailable', 422);
  if (result.error === 'not_found') return fail('not_found', 404);
  return fail(result.error, 409);
}

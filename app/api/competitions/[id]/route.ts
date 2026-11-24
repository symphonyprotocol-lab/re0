import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser, currentUser } from '@/lib/http/session';
import { getCompetition, hostCompetition, slugOf, updateCompetition } from '@/lib/services/competitions';

type Context = { params: Promise<{ id: string }> };

/** `GET` → the competition as this viewer may read it; its host also gets `{manage}`, references and rubrics included. 404 otherwise. */
export async function GET(_request: NextRequest, { params }: Context) {
  const { id } = await params;
  const viewer = await currentUser();
  const slug = await slugOf(id);
  const page = slug ? await getCompetition(slug, viewer?.id) : null;
  if (!page || page.id !== id) return fail('not_found', 404);
  const manage = viewer && page.isHost ? await hostCompetition(viewer.id, id) : null;
  return json({ competition: page, ...(manage ? { manage } : {}) });
}

/** The host's edit: a draft's settings; an open one's description, `deadlineAt` earlier, or `closeNow` (Q6). 409 `locked` past that. */
export async function PATCH(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  const result = await updateCompetition(user.id, (await params).id, await body(request));
  if (result.ok) return json({ ok: true });
  if (result.error === 'not_found') return fail('not_found', 404);
  if (result.error === 'locked' || result.error === 'channel_fixed' || result.error === 'deadline_later') return fail(result.error, 409, result.field ? { field: result.field } : {});
  return fail(result.error, 400, result.field ? { field: result.field } : {});
}

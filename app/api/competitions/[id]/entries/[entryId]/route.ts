import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { rateLimited } from '@/lib/http/rate-limit';
import { apiUser, currentUser } from '@/lib/http/session';
import { entrySheet, slugOf, withdrawEntry } from '@/lib/services/competitions';

type Context = { params: Promise<{ id: string; entryId: string }> };

/** One Ree's answers: anyone once published; before that its entrant alone, without scores. 404 otherwise. */
export async function GET(_request: NextRequest, { params }: Context) {
  const { id, entryId } = await params;
  const viewer = await currentUser();
  const slug = await slugOf(id);
  const sheet = slug ? await entrySheet(slug, entryId, viewer?.id) : null;
  return sheet ? json(sheet) : fail('not_found', 404);
}

/** 撤回 before the deadline: nothing was charged. 404 when it is not the caller's entry or entries have closed. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const limited = await rateLimited('postAction', { userId: user.id, headers: request.headers });
  if (limited) return limited;
  return (await withdrawEntry(user.id, (await params).entryId)) ? json({ ok: true }) : fail('not_found', 404);
}

import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser, currentUser } from '@/lib/http/session';
import { ownerAct, publicQaById, type OwnerAction } from '@/lib/services/public-qa';

type Context = { params: Promise<{ id: string; qaId: string }> };

/** One shown public answer in full ("展开全文"). */
export async function GET(_request: NextRequest, { params }: Context) {
  const { id, qaId } = await params;
  const viewer = await currentUser();
  const item = await publicQaById(id, qaId, viewer?.id);
  return item ? json({ item }) : fail('not_found', 404);
}

const ACTIONS: readonly OwnerAction[] = ['hide', 'pin', 'unpin'];

/** `{action: 'hide' | 'pin' | 'unpin'}`: the Ree's owner hides one answer for good or pins it first. */
export async function PATCH(request: NextRequest, { params }: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, qaId } = await params;
  const action = (await body(request)).action;
  if (typeof action !== 'string' || !ACTIONS.includes(action as OwnerAction)) return fail('invalid_action', 422);
  return (await ownerAct(user.id, id, qaId, action as OwnerAction)) ? json({ ok: true }) : fail('not_found', 404);
}

import type { NextRequest } from 'next/server';
import { conversationFailure } from '@/lib/http/conversations';
import { json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { addParticipant, removeParticipant } from '@/lib/services/conversations';

type Context = { params: Promise<{ id: string; reeId: string }> };

/** Pulls a Ree in: the user's own or a public one; the sixth is refused with `too_many_rees` (409). */
export async function POST(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, reeId } = await context.params;
  try {
    return json({ result: await addParticipant(user.id, id, reeId) });
  } catch (error) {
    return conversationFailure(error);
  }
}

/** Takes a Ree out; its earlier answers stay. */
export async function DELETE(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, reeId } = await context.params;
  try {
    return json({ removed: await removeParticipant(user.id, id, reeId) });
  } catch (error) {
    return conversationFailure(error);
  }
}

import type { NextRequest } from 'next/server';
import { conversationFailure } from '@/lib/http/conversations';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { runBatch, updateConversation } from '@/lib/services/conversations';

type Context = { params: Promise<{ id: string }> };

/** `{title?, pinned?, archived?, trashed?}`: rename (1–120), pin, archive, move to or back from the trash. */
export async function PATCH(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    const conversation = await updateConversation(user.id, (await context.params).id, await body(request));
    return json({ conversation: { id: conversation.id, title: conversation.title, pinned: conversation.pinned, archivedAt: conversation.archivedAt, deletedAt: conversation.deletedAt } });
  } catch (error) {
    return conversationFailure(error);
  }
}

/** Moves the conversation to the trash; it is purged 30 days later. */
export async function DELETE(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const changed = await runBatch(user.id, 'trash', [(await context.params).id]);
  return changed ? json({ trashed: true }) : fail('not_found', 404);
}

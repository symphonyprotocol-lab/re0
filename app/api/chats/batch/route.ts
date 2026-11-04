import type { NextRequest } from 'next/server';
import { BATCH_ACTIONS, type BatchAction } from '@/lib/domain/conversation';
import { conversationFailure } from '@/lib/http/conversations';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { runBatch } from '@/lib/services/conversations';

/** `{action: pin|unpin|archive|unarchive|trash|restore|delete, ids}` → `{changed}`. Delete is restricted to the caller's trash. */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const input = await body(request);
  const action = String(input.action ?? '') as BatchAction;
  if (!BATCH_ACTIONS.includes(action) || !Array.isArray(input.ids)) return fail('invalid_action', 422);
  try {
    return json({ changed: await runBatch(user.id, action, input.ids.map(String)) });
  } catch (error) {
    return conversationFailure(error);
  }
}

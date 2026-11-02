import type { NextRequest } from 'next/server';
import { QUESTION_MAX_CHARS } from '@/lib/constants';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { answer } from '@/lib/services/answer';
import { clearConversation, ownedConversation } from '@/lib/services/chat';
import { ownedRee } from '@/lib/services/rees';

export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/**
 * One question, answered as a UI message stream (`useChat` on the client).
 * Step 1 serves the single-Ree test conversation; multi-Ree conversations
 * reuse this route in step 4.
 */
export async function POST(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const conversation = await ownedConversation(user.id, (await context.params).id);
  if (!conversation || conversation.kind !== 'ree_test' || !conversation.reeId) return fail('not_found', 404);
  const ree = await ownedRee(db(), user.id, conversation.reeId);
  if (!ree) return fail('not_found', 404);
  const question = String((await body(request)).question ?? '').trim();
  if (!question || question.length > QUESTION_MAX_CHARS) return fail('invalid_question', 422);
  return answer({ userId: user.id, lang: user.lang, conversation, ree, question });
}

/** "清空对话": removes the messages; the ledger keeps what was charged. */
export async function DELETE(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const conversation = await ownedConversation(user.id, (await context.params).id);
  if (!conversation) return fail('not_found', 404);
  await clearConversation(conversation.id);
  return json({ cleared: true });
}

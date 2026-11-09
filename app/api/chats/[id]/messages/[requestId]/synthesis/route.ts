import type { NextRequest } from 'next/server';
import { fail } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { ownedConversation } from '@/lib/services/chat';
import { synthesize } from '@/lib/services/synthesis';

export const maxDuration = 300;

type Context = { params: Promise<{ id: string; requestId: string }> };

/**
 * "综合这 N 个回答" (ree-council-proposal.md 4.2): one synthesis of the
 * answers to the question `requestId`, streamed as a UI message stream --
 * its text as it is written, then one `data-synthesis` part with the checked
 * markers. 402 when the fee cannot be held, 409 once the question has one.
 */
export async function POST(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, requestId } = await context.params;
  const conversation = await ownedConversation(user.id, id);
  /* MCP conversations are asked through `/api/mcp` only. */
  if (!conversation || conversation.deletedAt || conversation.kind === 'mcp') return fail('not_found', 404);
  return synthesize({ userId: user.id, lang: user.lang, conversation, requestId });
}

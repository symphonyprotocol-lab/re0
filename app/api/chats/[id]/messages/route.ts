import { and, inArray } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { QUESTION_MAX_CHARS } from '@/lib/constants';
import { questionTargets } from '@/lib/domain/conversation';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db, schema } from '@/lib/infra/db';
import { answer } from '@/lib/services/answer';
import { clearConversation, ownedConversation } from '@/lib/services/chat';
import { participantsOf, usableBy } from '@/lib/services/conversations';
import { ownedRee } from '@/lib/services/rees';

export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/**
 * One question, answered as a UI message stream (`useChat` on the client),
 * every asked Ree in its own text part tagged with its id
 * (rebuild-proposal.md 3). `{question, scope}`: `scope` is "只问这个 Ree";
 * an `@name` in the question overrides it, and an `@` that names no
 * participant is refused. The single-Ree test conversation of
 * `/rees/[id]/chat` uses the same route with its one Ree. `verify` is
 * "核对引用" for this question; left out, it is on in the test conversation
 * and off elsewhere.
 */
export async function POST(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const conversation = await ownedConversation(user.id, (await context.params).id);
  if (!conversation || conversation.deletedAt) return fail('not_found', 404);
  const input = await body(request);
  const question = String(input.question ?? '').trim();
  if (!question || question.length > QUESTION_MAX_CHARS) return fail('invalid_question', 422);
  const verify = typeof input.verify === 'boolean' ? input.verify : conversation.kind === 'ree_test';

  if (conversation.kind === 'ree_test') {
    const ree = conversation.reeId ? await ownedRee(db(), user.id, conversation.reeId) : null;
    if (!ree) return fail('not_found', 404);
    return answer({ userId: user.id, lang: user.lang, conversation, targets: [ree], question, verify });
  }

  const participants = (await participantsOf(db(), conversation.id, user.id)).filter((ree) => ree.usable);
  if (participants.length === 0) return fail('no_participants', 422);
  const chosen = questionTargets(participants, question, typeof input.scope === 'string' ? input.scope : null);
  if (chosen.length === 0) return fail('unknown_mention', 422);
  const rows = await db()
    .select()
    .from(schema.ree)
    .where(and(inArray(schema.ree.id, chosen.map((ree) => ree.id)), usableBy(user.id)));
  const targets = chosen.flatMap((ree) => rows.find((row) => row.id === ree.id) ?? []);
  if (targets.length === 0) return fail('no_participants', 422);
  return answer({ userId: user.id, lang: user.lang, conversation, targets, question, verify });
}

/** "清空对话" of the test conversation: removes the messages; the ledger keeps what was charged. */
export async function DELETE(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const conversation = await ownedConversation(user.id, (await context.params).id);
  if (!conversation || conversation.kind !== 'ree_test') return fail('not_found', 404);
  await clearConversation(conversation.id);
  return json({ cleared: true });
}

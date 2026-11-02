import { after, type NextRequest } from 'next/server';
import { InsufficientCredits } from '@/lib/domain/credits';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { inputErrorStatus, KnowledgeInputError, processKnowledge, refreshKnowledge } from '@/lib/services/knowledge';
import { ownedRee } from '@/lib/services/rees';

export const maxDuration = 300;

/** Reprocess: reserved and charged again (8.2), old passages replaced on success. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; kid: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, kid } = await context.params;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) return fail('not_found', 404);
  try {
    await refreshKnowledge(user.id, ree.id, kid);
    after(() => processKnowledge(kid));
    return json({ id: kid }, 202);
  } catch (error) {
    if (error instanceof KnowledgeInputError) return fail(error.code, inputErrorStatus(error.code));
    if (error instanceof InsufficientCredits) return fail('insufficient_credits', 402, { needed: error.needed, balance: error.available });
    throw error;
  }
}

import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { inputErrorStatus, KnowledgeInputError } from '@/lib/services/knowledge';
import { runBatch } from '@/lib/services/knowledge-library';
import { ownedRee } from '@/lib/services/rees';

/** Back from the trash, with its passages, folder and "参与回答" setting as they were. */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string; kid: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, kid } = await context.params;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) return fail('not_found', 404);
  try {
    await runBatch(user.id, ree.id, { action: 'restore', ids: [kid] });
    return json({ id: kid });
  } catch (error) {
    if (error instanceof KnowledgeInputError) return fail(error.code, inputErrorStatus(error.code));
    throw error;
  }
}

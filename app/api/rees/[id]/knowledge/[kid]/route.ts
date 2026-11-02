import type { NextRequest } from 'next/server';
import { fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { knowledgeDetail } from '@/lib/services/knowledge';
import { ownedRee } from '@/lib/services/rees';

/** One source for the preview: extracted content, its passages, and the processing record. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string; kid: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, kid } = await context.params;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) return fail('not_found', 404);
  const detail = await knowledgeDetail(ree.id, kid);
  return detail ? json({ knowledge: detail }) : fail('not_found', 404);
}

import { after, type NextRequest } from 'next/server';
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { InsufficientCredits } from '@/lib/domain/credits';
import { param, parseList } from '@/lib/domain/list';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import {
  addKnowledge,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_SORTS,
  KNOWLEDGE_STATUSES,
  KnowledgeInputError,
  listKnowledge,
  processKnowledge,
  recoverStale,
} from '@/lib/services/knowledge';
import { ownedRee } from '@/lib/services/rees';

export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/** `?q&status=all|ready|processing|failed&kind&sort&size&page`, plus per-tab counts. */
export async function GET(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const ree = await ownedRee(db(), user.id, (await context.params).id);
  if (!ree) return fail('not_found', 404);
  const waiting = await recoverStale(ree.id);
  for (const id of waiting) after(() => processKnowledge(id));
  const params = request.nextUrl.searchParams;
  const query = parseList(params, { statuses: KNOWLEDGE_STATUSES, sorts: KNOWLEDGE_SORTS, sizes: LIST_PAGE_SIZES });
  const kind = (KNOWLEDGE_KINDS as readonly string[]).includes(param(params, 'kind')) ? param(params, 'kind') : 'all';
  return json(await listKnowledge(ree.id, { ...query, kind }));
}

/**
 * Adds a document (after the browser uploaded it with a token from
 * /api/upload-token) or pasted text, reserves its processing cost, and
 * processes it after the response.
 */
export async function POST(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const ree = await ownedRee(db(), user.id, (await context.params).id);
  if (!ree) return fail('not_found', 404);
  const input = await body(request);
  try {
    const id = await addKnowledge(
      user.id,
      ree,
      input.kind === 'document'
        ? { kind: 'document', blobPath: String(input.blobPath ?? ''), fileName: String(input.fileName ?? '') }
        : { kind: 'text', title: String(input.title ?? ''), content: String(input.content ?? '') },
    );
    after(() => processKnowledge(id));
    return json({ id }, 201);
  } catch (error) {
    if (error instanceof KnowledgeInputError) return fail(error.code, 422);
    if (error instanceof InsufficientCredits) return fail('insufficient_credits', 402, { needed: error.needed, balance: error.available });
    throw error;
  }
}

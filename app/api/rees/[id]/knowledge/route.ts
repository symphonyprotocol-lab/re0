import { after, type NextRequest } from 'next/server';
import { InsufficientCredits } from '@/lib/domain/credits';
import { isKnowledgeKind } from '@/lib/domain/knowledge';
import { param } from '@/lib/domain/list';
import { knowledgeQuery } from '@/lib/http/knowledge';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import {
  addKnowledge,
  inputErrorStatus,
  KnowledgeInputError,
  listKnowledge,
  matchingIds,
  processKnowledge,
  recoverStale,
  type NewKnowledge,
} from '@/lib/services/knowledge';
import { ownedRee } from '@/lib/services/rees';

export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

/**
 * `?q&status=all|ready|processing|failed|paused&kind&sort=new|old|title&size&page&folder&view=trash`,
 * plus tab and folder counts. `ids=1` answers every matching id instead
 * ("选择全部 N 个筛选结果", previous / next).
 */
export async function GET(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const ree = await ownedRee(db(), user.id, (await context.params).id);
  if (!ree) return fail('not_found', 404);
  const params = request.nextUrl.searchParams;
  const query = knowledgeQuery(params);
  if (param(params, 'ids') === '1') {
    const ids = await matchingIds(ree.id, query);
    return json({ ids, total: ids.length });
  }
  const waiting = await recoverStale(ree.id);
  for (const id of waiting) after(() => processKnowledge(id));
  return json(await listKnowledge(ree.id, query));
}

function newKnowledge(input: Record<string, unknown>): NewKnowledge | null {
  const folderId = typeof input.folderId === 'string' && input.folderId ? input.folderId : null;
  const text = (name: string) => String(input[name] ?? '');
  if (!isKnowledgeKind(input.kind)) return null;
  switch (input.kind) {
    case 'document':
      return { kind: 'document', blobPath: text('blobPath'), fileName: text('fileName'), folderId };
    case 'audio':
      return { kind: 'audio', blobPath: text('blobPath'), fileName: text('fileName'), consent: input.consent === true, folderId };
    case 'text':
      return { kind: 'text', title: text('title'), content: text('content'), folderId };
    case 'github':
    case 'page':
    case 'site':
      return { kind: input.kind, url: text('url'), folderId };
  }
}

/**
 * Adds any of the six kinds: an upload (document, audio) after the browser
 * sent it to Blob with a token from /api/upload-token, a URL (GitHub, page,
 * website), or pasted text. Reserves the processing cost and processes it
 * after the response.
 */
export async function POST(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const ree = await ownedRee(db(), user.id, (await context.params).id);
  if (!ree) return fail('not_found', 404);
  const input = newKnowledge(await body(request));
  if (!input) return fail('invalid_kind', 422);
  try {
    const id = await addKnowledge(user.id, ree, input);
    after(() => processKnowledge(id));
    return json({ id }, 201);
  } catch (error) {
    if (error instanceof KnowledgeInputError) return fail(error.code, inputErrorStatus(error.code));
    if (error instanceof InsufficientCredits) return fail('insufficient_credits', 402, { needed: error.needed, balance: error.available });
    throw error;
  }
}

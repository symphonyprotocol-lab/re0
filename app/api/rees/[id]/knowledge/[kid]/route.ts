import { after, type NextRequest } from 'next/server';
import { fail, json, body } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { inputErrorStatus, knowledgeChild, knowledgeDetail, KnowledgeInputError } from '@/lib/services/knowledge';
import { renameKnowledge, runBatch } from '@/lib/services/knowledge-library';
import { refreshProfile } from '@/lib/services/profile';
import { ownedRee } from '@/lib/services/rees';

type Context = { params: Promise<{ id: string; kid: string }> };

/**
 * One source for the preview: content, children, passages and the
 * processing record. `?child=N` answers one page of a website or one file of
 * a repository instead.
 */
export async function GET(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, kid } = await context.params;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) return fail('not_found', 404);
  const child = request.nextUrl.searchParams.get('child');
  if (child !== null) {
    const found = await knowledgeChild(ree.id, kid, Number(child));
    return found ? json(found) : fail('not_found', 404);
  }
  const detail = await knowledgeDetail(ree.id, kid);
  return detail ? json({ knowledge: detail }) : fail('not_found', 404);
}

/** `{ title }` renames (≤ 200); `{ enabled }` pauses or resumes; `{ folderId }` moves (null: 未分组). */
export async function PATCH(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, kid } = await context.params;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) return fail('not_found', 404);
  const input = await body(request);
  try {
    if ('title' in input) await renameKnowledge(ree.id, kid, input.title);
    if (typeof input.enabled === 'boolean') {
      await runBatch(user.id, ree.id, { action: input.enabled ? 'resume' : 'pause', ids: [kid] });
      /* What the Ree knows changed: its explore profile follows (2.4). */
      if (ree.isPublished) after(() => refreshProfile(ree.id).catch(() => undefined));
    }
    if ('folderId' in input) {
      await runBatch(user.id, ree.id, { action: 'move', ids: [kid], folderId: typeof input.folderId === 'string' && input.folderId ? input.folderId : null });
    }
    const detail = await knowledgeDetail(ree.id, kid);
    return detail ? json({ knowledge: detail }) : fail('not_found', 404);
  } catch (error) {
    if (error instanceof KnowledgeInputError) return fail(error.code, inputErrorStatus(error.code));
    throw error;
  }
}

/** Moves the source to the trash; purged with its passages 30 days later. */
export async function DELETE(request: NextRequest, context: Context) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id, kid } = await context.params;
  const ree = await ownedRee(db(), user.id, id);
  if (!ree) return fail('not_found', 404);
  try {
    await runBatch(user.id, ree.id, { action: 'trash', ids: [kid] });
    if (ree.isPublished) after(() => refreshProfile(ree.id).catch(() => undefined));
    return json({ id: kid });
  } catch (error) {
    if (error instanceof KnowledgeInputError) return fail(error.code, inputErrorStatus(error.code));
    throw error;
  }
}

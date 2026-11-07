import { after, type NextRequest } from 'next/server';
import { InsufficientCredits } from '@/lib/domain/credits';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { inputErrorStatus, KnowledgeInputError, processMany } from '@/lib/services/knowledge';
import { BATCH_ACTIONS, FolderError, runBatch, validIds, type BatchAction } from '@/lib/services/knowledge-library';
import { refreshProfile } from '@/lib/services/profile';
import { ownedRee } from '@/lib/services/rees';

export const maxDuration = 300;

/**
 * `{ action: move|reprocess|pause|resume|trash|restore, ids, folderId?, newFolderName? }`.
 * One transaction: a stale selection, a source still processing (trash,
 * reprocess) or a short balance (reprocess) refuses the whole batch.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const ree = await ownedRee(db(), user.id, (await context.params).id);
  if (!ree) return fail('not_found', 404);
  const input = await body(request);
  const action = String(input.action ?? '') as BatchAction;
  const ids = validIds(input.ids);
  if (!(BATCH_ACTIONS as readonly string[]).includes(action) || !ids) return fail('invalid_batch', 422);
  try {
    const result =
      action === 'move'
        ? await runBatch(user.id, ree.id, {
            action,
            ids,
            folderId: typeof input.folderId === 'string' && input.folderId ? input.folderId : null,
            ...(typeof input.newFolderName === 'string' ? { newFolderName: input.newFolderName } : {}),
          })
        : await runBatch(user.id, ree.id, { action, ids });
    if (result.process.length > 0) after(() => processMany(result.process));
    /* Paused, resumed, trashed or restored sources change what the Ree knows: its explore profile follows (2.4). */
    if (['pause', 'resume', 'trash', 'restore'].includes(action) && ree.isPublished) after(() => refreshProfile(ree.id).catch(() => undefined));
    return json({ changed: result.changed, folder: result.folder ?? null });
  } catch (error) {
    if (error instanceof KnowledgeInputError) return fail(error.code, inputErrorStatus(error.code));
    if (error instanceof FolderError) return fail(error.code, 422);
    if (error instanceof InsufficientCredits) return fail('insufficient_credits', 402, { needed: error.needed, balance: error.available });
    throw error;
  }
}

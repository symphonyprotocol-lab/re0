'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { AppError } from '@/contracts/errors';
import { runOperation } from '@/lib/application/ingestion';
import { updateLibraryFiles } from '@/lib/application/libraries';
import { requireSession } from '@/lib/http/session';

/**
 * The files page's one mutation: add and remove PDFs, then queue a rebuild.
 * Re-resolves the session like every action -- a server action is a public
 * endpoint with a generated name -- and returns a coarse code the page
 * translates; detail stays server side.
 */
export interface UpdateLibraryFilesActionResult {
  ok: boolean;
  /** True when a build was queued (or one was already waiting). */
  queued?: boolean;
  error?: 'nothing' | 'invalid' | 'not_found' | 'access_denied' | 'quota' | 'unavailable';
}

export async function updateLibraryFilesAction(
  _previous: UpdateLibraryFilesActionResult | null,
  form: FormData,
): Promise<UpdateLibraryFilesActionResult> {
  const libraryId = String(form.get('libraryId') ?? '');
  const session = await requireSession(`/dashboard/assets/${libraryId}/files`);

  let add: unknown;
  let remove: unknown;
  try {
    const posted = String(form.get('add') ?? '');
    add = posted === '' ? undefined : JSON.parse(posted);
    remove = JSON.parse(String(form.get('remove') ?? '[]'));
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (!Array.isArray(remove) || remove.some((id) => typeof id !== 'string')) {
    return { ok: false, error: 'invalid' };
  }

  try {
    const result = await updateLibraryFiles({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId,
      add,
      remove: remove as string[],
    });
    revalidatePath(`/dashboard/assets/${libraryId}/files`);
    revalidatePath(`/dashboard/assets/${libraryId}`);
    revalidatePath('/dashboard/assets');
    const operationId = result.operationId;
    if (operationId) {
      after(async () => {
        try {
          await runOperation({ operationId });
        } catch (error) {
          console.error(`library rebuild run failed: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      });
    }
    return { ok: true, queued: operationId !== null };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
      if (error.code === 'access_denied') return { ok: false, error: 'access_denied' };
      if (error.code === 'quota_exceeded') return { ok: false, error: 'quota' };
      if (error.code === 'invalid_request') {
        return { ok: false, error: error.message === 'nothing to change' ? 'nothing' : 'invalid' };
      }
    }
    console.error(`update library files failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

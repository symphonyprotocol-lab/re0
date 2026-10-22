'use server';

import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { AppError } from '@/contracts/errors';
import { runOperation } from '@/lib/application/ingestion';
import { deleteWorkspaceLibrary } from '@/lib/application/libraries';
import { requireSession } from '@/lib/http/session';

/**
 * The library list's one mutation: delete. requirement.md 5.2 -- an owner-side
 * operation with a definite outcome.
 *
 * Re-resolves the session like every action (a server action is a public
 * endpoint with a generated name) and re-checks the role in the use case; that
 * the list only renders the control for owners says nothing about who can
 * post to it. Returns a coarse code the dialog translates; detail stays server
 * side.
 */
export interface DeleteLibraryActionResult {
  ok: boolean;
  publicId?: string;
  error?: 'not_found' | 'access_denied' | 'unavailable';
}

export async function deleteWorkspaceLibraryAction(
  _previous: DeleteLibraryActionResult | null,
  form: FormData,
): Promise<DeleteLibraryActionResult> {
  const session = await requireSession('/dashboard/libraries');
  try {
    const { publicId, operationId } = await deleteWorkspaceLibrary({
      workspaceId: session.workspace.id,
      role: session.workspace.role,
      libraryId: String(form.get('libraryId') ?? ''),
    });

    /* The list, and the overview's library count and quota. */
    revalidatePath('/dashboard/libraries');
    revalidatePath('/dashboard');

    /*
     * The tombstone is written and the response can go; the content is
     * removed by the Delete Workflow (architecture.md 8.4). Started here so it
     * is usually done by the time the user looks again, and retried by the
     * scheduled drain if it is not. Failures are on the operation row --
     * throwing after the response would only be an unhandled rejection.
     */
    if (operationId) {
      after(async () => {
        try {
          await runOperation({ operationId });
        } catch (error) {
          console.error(
            `library purge run failed: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        }
      });
    }

    return { ok: true, publicId };
  } catch (error) {
    if (error instanceof AppError && error.code === 'library_not_found') {
      return { ok: false, error: 'not_found' };
    }
    if (error instanceof AppError && error.code === 'access_denied') {
      return { ok: false, error: 'access_denied' };
    }
    console.error(`delete library failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

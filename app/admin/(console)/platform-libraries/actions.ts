'use server';

import { headers } from 'next/headers';
import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import {
  addPlatformLibrarySource,
  createPlatformLibrary,
  deletePlatformLibrary,
  rebuildPlatformLibraryProfile,
  removePlatformLibrarySource,
  requestPlatformLibraryRefresh,
  setPlatformLibraryLifecycle,
  updatePlatformLibrary,
  updatePlatformLibraryFiles,
  updatePlatformLibrarySource,
} from '@/lib/application/administration';
import { runOperation } from '@/lib/application/ingestion';
import { preparePlatformUploads } from '@/lib/application/libraries';
import type { PrepareUploadResult } from '@/app/dashboard/libraries/new/actions';
import { AppError } from '@/contracts/errors';
import { AdminChangeRefused } from '@/lib/domain/admin';
import {
  isPlatformLifecycleAction,
  PlatformLibraryRefused,
  UPLOAD_LIMITS,
  type PlatformLibraryError,
} from '@/lib/domain/library';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

/**
 * The mutations behind the platform-library screens.
 *
 * Each one re-resolves the session and re-checks the capability, like every
 * other console action: a server action is a public endpoint with a generated
 * name, and that a screen only renders a control for entitled operators says
 * nothing about who can post to it.
 */
export interface PlatformLibraryActionResult {
  ok: boolean;
  error?: PlatformLibraryError;
  /** Set on a successful create, so the dialog can name what it made. */
  libraryId?: string;
  publicId?: string;
  /** Set on a refresh: false means one was already queued. */
  queued?: boolean;
  /** Set on a profile rebuild: what the extractor wrote. */
  rebuilt?: { titles: number; terms: number };
}

async function actorAddress(): Promise<string | null> {
  const bag = await headers();
  return clientAddress(bag);
}

/**
 * Maps a thrown refusal onto a code the dialog has a sentence for.
 *
 * `normalizeReason` is shared with the administrator screens and throws the
 * administrator refusal, so its one reachable code is translated rather than
 * flattened into a field error the operator would go looking for.
 */
function refused(error: unknown, context: string): PlatformLibraryActionResult {
  if (error instanceof PlatformLibraryRefused) return { ok: false, error: error.code };
  if (error instanceof AdminChangeRefused && error.code === 'reason_required') {
    return { ok: false, error: 'reason_required' };
  }
  console.error(
    `${context} failed: ${error instanceof Error ? error.message : 'unknown'}`,
  );
  return { ok: false, error: 'unavailable' };
}

const text = (form: FormData, field: string) => String(form.get(field) ?? '');

/** The operator, as every use case in this module wants them. */
async function actor(session: { administratorId: string; email: string }) {
  return {
    administratorId: session.administratorId,
    email: session.email,
    clientAddress: await actorAddress(),
  };
}

export async function createPlatformLibraryAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('platformLibraries');
  /* The dialog posts an empty manifest field when no file was uploaded;
     that is an empty PDF library, filled in from its files panel. */
  let uploads: unknown;
  const posted = text(form, 'uploads');
  if (text(form, 'sourceType') === 'pdf' && posted !== '') {
    try {
      uploads = JSON.parse(posted);
    } catch {
      return { ok: false, error: 'invalid_uploads' };
    }
  }
  try {
    const { libraryId, publicId, operationId } = await createPlatformLibrary({
      actor: await actor(session),
      title: text(form, 'title'),
      publicId: text(form, 'publicId'),
      sourceType: text(form, 'sourceType'),
      location: text(form, 'location'),
      refreshPolicy: text(form, 'refreshPolicy'),
      indexDepth: text(form, 'indexDepth'),
      uploads,
      description: text(form, 'description'),
      domainTag: text(form, 'domainTag'),
      language: text(form, 'language'),
      reason: text(form, 'reason'),
    });
    revalidatePath('/admin/platform-libraries');
    /* A pdf library created with files builds at once, like a refresh. */
    if (operationId) runAfterResponse(operationId, 'platform library first build');
    return { ok: true, libraryId, publicId };
  } catch (error) {
    return refused(error, 'platform library create');
  }
}

/**
 * Runs a queued operation after the response, the way every console
 * mutation that queues one does: the operator gets the acknowledgement at
 * once, and a failure lands on the operation row rather than here.
 */
function runAfterResponse(operationId: string, context: string): void {
  after(async () => {
    try {
      await runOperation({ operationId });
    } catch (error) {
      console.error(`${context} run failed: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  });
}

/**
 * Room in the store for the PDFs the console is about to upload, one
 * ticket per file; the browser uploads straight to storage. The result shape
 * is the dashboard wizard's, so the same uploader component serves both.
 */
export async function preparePlatformUploadAction(
  files: { name: string; size: number }[],
  batchId?: string,
): Promise<PrepareUploadResult> {
  await requireAdminCapability('platformLibraries');
  const maxFileBytes = UPLOAD_LIMITS.maxFileBytes;
  if (!Array.isArray(files) || files.length > UPLOAD_LIMITS.maxFiles) {
    return { ok: false, maxFileBytes, error: 'invalid' };
  }
  try {
    const prepared = await preparePlatformUploads({
      files: files.map((file) => ({ name: String(file?.name ?? ''), size: Number(file?.size) })),
      batchId: typeof batchId === 'string' ? batchId : undefined,
    });
    return { ok: true, maxFileBytes, ...prepared };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.code === 'library_size_exceeded') return { ok: false, maxFileBytes, error: 'too_large' };
      if (error.code === 'invalid_request') return { ok: false, maxFileBytes, error: 'invalid' };
    }
    console.error(`platform upload prepare failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, maxFileBytes, error: 'unavailable' };
  }
}

export async function updatePlatformFilesAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('platformLibraries');
  const libraryId = text(form, 'libraryId');
  let add: unknown;
  let remove: unknown;
  try {
    const posted = text(form, 'add');
    add = posted === '' ? undefined : JSON.parse(posted);
    remove = JSON.parse(text(form, 'remove') || '[]');
  } catch {
    return { ok: false, error: 'invalid_uploads' };
  }
  if (!Array.isArray(remove) || remove.some((id) => typeof id !== 'string')) {
    return { ok: false, error: 'invalid_uploads' };
  }
  try {
    const { operationId, created } = await updatePlatformLibraryFiles({
      actor: await actor(session),
      libraryId,
      add,
      remove: remove as string[],
      reason: text(form, 'reason'),
    });
    revalidatePath('/admin/platform-libraries');
    revalidatePath(`/admin/platform-libraries/${libraryId}`);
    if (operationId && created) runAfterResponse(operationId, 'platform library rebuild');
    return { ok: true, libraryId, queued: operationId !== null };
  } catch (error) {
    return refused(error, 'platform library files');
  }
}

export async function setPlatformLifecycleAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('platformLibraries');
  const action = text(form, 'action');
  if (!isPlatformLifecycleAction(action)) return { ok: false, error: 'invalid_transition' };

  const libraryId = text(form, 'libraryId');
  try {
    await setPlatformLibraryLifecycle({
      actor: await actor(session),
      libraryId,
      action,
      reason: text(form, 'reason'),
    });
    // The list shows the status too, and its tab counts move with it.
    revalidatePath('/admin/platform-libraries');
    revalidatePath(`/admin/platform-libraries/${libraryId}`);
    return { ok: true, libraryId };
  } catch (error) {
    return refused(error, 'platform library lifecycle');
  }
}

export async function refreshPlatformLibraryAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('platformLibraries');
  const libraryId = text(form, 'libraryId');
  try {
    const { created, operationId } = await requestPlatformLibraryRefresh({
      actor: await actor(session),
      libraryId,
      sourceId: text(form, 'sourceId') || null,
      reason: text(form, 'reason'),
    });
    /*
     * The list's queue figure moves with this too, which is why both paths are
     * revalidated for what looks like a change to one library.
     */
    revalidatePath('/admin/platform-libraries');
    revalidatePath(`/admin/platform-libraries/${libraryId}`);

    /*
     * Queued and then run, in that order and after the response.
     *
     * architecture.md 8.4 is explicit that the caller does not wait for a
     * refresh to execute, and this keeps that promise -- the operator gets the
     * queued acknowledgement immediately. Running it in `after` rather than
     * leaving it to the cron drain is what makes the button feel like a button:
     * by the time they reload the detail page the operation has usually
     * finished, and if it has not, the queue panel on that page says so.
     *
     * `runOperation` claims the row with a conditional update, so a cron drain
     * that overlaps this cannot build the same library twice; the loser reports
     * `lost` and does nothing. Failures are recorded on the operation row --
     * throwing here would only produce an unhandled rejection after a response
     * that already said "queued".
     */
    if (created) {
      after(async () => {
        try {
          await runOperation({ operationId });
        } catch (error) {
          console.error(
            `platform library refresh run failed: ${
              error instanceof Error ? error.message : 'unknown'
            }`,
          );
        }
      });
    }

    return { ok: true, libraryId, queued: created };
  } catch (error) {
    return refused(error, 'platform library refresh');
  }
}

export async function rebuildPlatformLibraryProfileAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('platformLibraries');
  const libraryId = text(form, 'libraryId');
  try {
    const rebuilt = await rebuildPlatformLibraryProfile({
      actor: await actor(session),
      libraryId,
      reason: text(form, 'reason'),
    });
    revalidatePath(`/admin/platform-libraries/${libraryId}`);
    return { ok: true, libraryId, rebuilt };
  } catch (error) {
    return refused(error, 'platform library profile rebuild');
  }
}

export async function updatePlatformLibraryAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('platformLibraries');
  const libraryId = text(form, 'libraryId');
  try {
    const { publicId } = await updatePlatformLibrary({
      actor: await actor(session),
      libraryId,
      title: text(form, 'title'),
      publicId: text(form, 'publicId'),
      description: text(form, 'description'),
      domainTag: text(form, 'domainTag'),
      language: text(form, 'language'),
      reason: text(form, 'reason'),
    });
    revalidatePath('/admin/platform-libraries');
    revalidatePath(`/admin/platform-libraries/${libraryId}`);
    return { ok: true, libraryId, publicId };
  } catch (error) {
    return refused(error, 'platform library update');
  }
}

export async function addPlatformSourceAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('platformLibraries');
  const libraryId = text(form, 'libraryId');
  let uploads: unknown;
  const posted = text(form, 'uploads');
  if (text(form, 'sourceType') === 'pdf' && posted !== '') {
    try {
      uploads = JSON.parse(posted);
    } catch {
      return { ok: false, error: 'invalid_uploads' };
    }
  }
  try {
    const { operationId } = await addPlatformLibrarySource({
      actor: await actor(session),
      libraryId,
      type: text(form, 'sourceType'),
      location: text(form, 'location'),
      refreshPolicy: text(form, 'refreshPolicy'),
      indexDepth: text(form, 'indexDepth'),
      uploads,
      reason: text(form, 'reason'),
    });
    revalidatePath('/admin/platform-libraries');
    revalidatePath(`/admin/platform-libraries/${libraryId}`);
    if (operationId) runAfterResponse(operationId, 'platform library source build');
    return { ok: true, libraryId };
  } catch (error) {
    return refused(error, 'platform library source add');
  }
}

export async function updatePlatformSourceAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('platformLibraries');
  const libraryId = text(form, 'libraryId');
  try {
    await updatePlatformLibrarySource({
      actor: await actor(session),
      libraryId,
      sourceId: text(form, 'sourceId'),
      location: text(form, 'location'),
      refreshPolicy: text(form, 'refreshPolicy'),
      indexDepth: text(form, 'indexDepth'),
      reason: text(form, 'reason'),
    });
    revalidatePath(`/admin/platform-libraries/${libraryId}`);
    return { ok: true, libraryId };
  } catch (error) {
    return refused(error, 'platform library source update');
  }
}

export async function removePlatformSourceAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('platformLibraries');
  const libraryId = text(form, 'libraryId');
  try {
    await removePlatformLibrarySource({
      actor: await actor(session),
      libraryId,
      sourceId: text(form, 'sourceId'),
      reason: text(form, 'reason'),
    });
    revalidatePath('/admin/platform-libraries');
    revalidatePath(`/admin/platform-libraries/${libraryId}`);
    return { ok: true, libraryId };
  } catch (error) {
    return refused(error, 'platform library source remove');
  }
}

export async function deletePlatformLibraryAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('platformLibraries');
  const libraryId = text(form, 'libraryId');
  try {
    const { publicId, operationId } = await deletePlatformLibrary({
      actor: await actor(session),
      libraryId,
      reason: text(form, 'reason'),
    });
    revalidatePath('/admin/platform-libraries');
    revalidatePath(`/admin/platform-libraries/${libraryId}`);

    /*
     * The tombstone is written; the content is not yet gone. architecture.md
     * 8.4 makes the purge a workflow, and like a refresh it is started here,
     * after the response, so it has usually finished by the time the operator
     * looks at anything -- and the scheduled drain retries it if it has not.
     * A purge that fails keeps retrying and never restores access, so there
     * is nothing for the operator to do about it from this dialog.
     */
    if (operationId) {
      after(async () => {
        try {
          await runOperation({ operationId });
        } catch (error) {
          console.error(
            `platform library purge run failed: ${
              error instanceof Error ? error.message : 'unknown'
            }`,
          );
        }
      });
    }

    return { ok: true, libraryId, publicId };
  } catch (error) {
    return refused(error, 'platform library delete');
  }
}

'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  probeReviewLibrary,
  reviewUserLibrary,
  type ProbeResult,
} from '@/lib/application/administration';
import { AdminChangeRefused } from '@/lib/domain/admin';
import { isUserReviewAction, PlatformLibraryRefused } from '@/lib/domain/library';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';
import type { PlatformLibraryActionResult } from '../platform-libraries/actions';

/**
 * The mutations behind the user-library screens: a suspension or its
 * lifting, and the console's one instrument, a probe question.
 *
 * Each re-resolves the session and re-checks the `libraries` capability like
 * every console action -- a server action is a public endpoint with a
 * generated name. The result shape is shared with the platform-library
 * actions so the dialogs can share their refusal copy.
 */

async function actor(session: { administratorId: string; email: string }) {
  return {
    administratorId: session.administratorId,
    email: session.email,
    clientAddress: clientAddress(await headers()),
  };
}

function refused(error: unknown, context: string): PlatformLibraryActionResult {
  if (error instanceof PlatformLibraryRefused) return { ok: false, error: error.code };
  if (error instanceof AdminChangeRefused && error.code === 'reason_required') {
    return { ok: false, error: 'reason_required' };
  }
  console.error(`${context} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

const text = (form: FormData, field: string) => String(form.get(field) ?? '');

/** Suspend a live user library or restore a suspended one, with a reason the owner reads. */
export async function reviewUserLibraryAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('libraries');
  const libraryId = text(form, 'libraryId');
  const action = text(form, 'action');
  if (!isUserReviewAction(action)) return { ok: false, error: 'invalid_transition' };

  try {
    await reviewUserLibrary({ actor: await actor(session), libraryId, action, reason: text(form, 'reason') });
    revalidatePath('/admin/libraries');
    revalidatePath(`/admin/libraries/${libraryId}`);
    return { ok: true };
  } catch (error) {
    return refused(error, 'review library');
  }
}

export interface ProbeActionResult extends PlatformLibraryActionResult {
  probe?: ProbeResult;
}

/** Ask the library a question as a caller would; nothing is metered or cached. */
export async function probeUserLibraryAction(
  _previous: ProbeActionResult | null,
  form: FormData,
): Promise<ProbeActionResult> {
  const session = await requireAdminCapability('libraries');
  const libraryId = text(form, 'libraryId');
  try {
    const probe = await probeReviewLibrary({ actor: await actor(session), libraryId, query: text(form, 'query') });
    return { ok: true, libraryId, probe };
  } catch (error) {
    return refused(error, 'review probe');
  }
}

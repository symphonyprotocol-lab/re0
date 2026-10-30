'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  probeReviewAsset,
  reviewUserAsset,
  type ProbeResult,
} from '@/lib/application/administration';
import { AdminChangeRefused } from '@/lib/domain/admin';
import { isUserReviewAction, PlatformAssetRefused } from '@/lib/domain/asset';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';
import type { PlatformAssetActionResult } from '../platform-assets/actions';

/**
 * The mutations behind the user-asset screens: a suspension or its
 * lifting, and the console's one instrument, a probe question.
 *
 * Each re-resolves the session and re-checks the `assets` capability like
 * every console action -- a server action is a public endpoint with a
 * generated name. The result shape is shared with the platform-asset
 * actions so the dialogs can share their refusal copy.
 */

async function actor(session: { administratorId: string; email: string }) {
  return {
    administratorId: session.administratorId,
    email: session.email,
    clientAddress: clientAddress(await headers()),
  };
}

function refused(error: unknown, context: string): PlatformAssetActionResult {
  if (error instanceof PlatformAssetRefused) return { ok: false, error: error.code };
  if (error instanceof AdminChangeRefused && error.code === 'reason_required') {
    return { ok: false, error: 'reason_required' };
  }
  console.error(`${context} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

const text = (form: FormData, field: string) => String(form.get(field) ?? '');

/** Suspend a live user asset or restore a suspended one, with a reason the owner reads. */
export async function reviewUserAssetAction(
  _previous: PlatformAssetActionResult | null,
  form: FormData,
): Promise<PlatformAssetActionResult> {
  const session = await requireAdminCapability('assets');
  const assetId = text(form, 'assetId');
  const action = text(form, 'action');
  if (!isUserReviewAction(action)) return { ok: false, error: 'invalid_transition' };

  try {
    await reviewUserAsset({ actor: await actor(session), assetId, action, reason: text(form, 'reason') });
    revalidatePath('/admin/assets');
    revalidatePath(`/admin/assets/${assetId}`);
    return { ok: true };
  } catch (error) {
    return refused(error, 'review asset');
  }
}

export interface ProbeActionResult extends PlatformAssetActionResult {
  probe?: ProbeResult;
}

/** Ask the asset a question as a caller would; nothing is metered or cached. */
export async function probeUserAssetAction(
  _previous: ProbeActionResult | null,
  form: FormData,
): Promise<ProbeActionResult> {
  const session = await requireAdminCapability('assets');
  const assetId = text(form, 'assetId');
  try {
    const probe = await probeReviewAsset({ actor: await actor(session), assetId, query: text(form, 'query') });
    return { ok: true, assetId, probe };
  } catch (error) {
    return refused(error, 'review probe');
  }
}

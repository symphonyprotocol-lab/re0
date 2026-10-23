'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  decideExpertApplication,
  expertSampleProbe,
  revokeExpertTag,
  updateExpertThresholds,
  type ExpertSample,
} from '@/lib/application/expert-libraries';
import { AdminChangeRefused } from '@/lib/domain/admin';
import { ExpertLibraryRefused, type ExpertLibraryError } from '@/lib/domain/expert-library';
import { EXPERT_THRESHOLD_KEYS, ExpertThresholdsRefused, type ExpertThresholdKey } from '@/lib/domain/expert-thresholds';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

/**
 * The console's moves over an expert-library application
 * (expert-library-prd.md 6). Each re-resolves the session and re-checks the
 * `expertLibraries` capability: a server action is a public endpoint with a
 * generated name, and the page only rendering these controls for an entitled
 * administrator says nothing about who can post to them.
 *
 * Each takes a reason, and the use case writes the audit row. An approval
 * decides who is paid from the next served call on, so the record of *why*
 * is part of the decision.
 */
export interface ExpertAdminActionResult {
  ok: boolean;
  error?: ExpertLibraryError | 'unavailable';
  /** Set on a revoke: earning events of open periods that were voided. */
  voidedEvents?: number;
}

function refused(error: unknown, context: string): ExpertAdminActionResult {
  if (error instanceof ExpertLibraryRefused) return { ok: false, error: error.code };
  console.error(`${context} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

const text = (form: FormData, field: string) => String(form.get(field) ?? '');

async function actor(session: { administratorId: string; email: string }) {
  return {
    administratorId: session.administratorId,
    email: session.email,
    clientAddress: clientAddress(await headers()),
  };
}

/** The queue, the application, and the rail's badge all move with a decision. */
function revalidateApplication(applicationId: string): void {
  revalidatePath('/admin/expert-libraries');
  revalidatePath(`/admin/expert-libraries/${applicationId}`);
  revalidatePath('/admin', 'layout');
}

/** Approve or reject a pending application. Anything else is refused here. */
export async function decideExpertAction(
  _previous: ExpertAdminActionResult | null,
  form: FormData,
): Promise<ExpertAdminActionResult> {
  const session = await requireAdminCapability('expertLibraries');
  const decision = text(form, 'decision');
  if (decision !== 'approve' && decision !== 'reject') return { ok: false, error: 'not_pending' };

  const applicationId = text(form, 'applicationId');
  try {
    await decideExpertApplication({
      actor: await actor(session),
      applicationId,
      decision,
      reason: text(form, 'reason'),
      /* The expert checklist rides as `check.<id>` / `note.<id>` fields (lib/domain/expert-library.ts). */
      checklist: form,
    });
    revalidateApplication(applicationId);
    return { ok: true };
  } catch (error) {
    return refused(error, `expert ${decision}`);
  }
}

export interface ExpertSampleActionResult {
  ok: boolean;
  error?: ExpertLibraryError | 'unavailable';
  sample?: ExpertSample;
}

/** Re-ask a few of the library's questions, for the reviewer's own look (review-visibility-proposal.md 6.5). */
export async function probeExpertSampleAction(
  _previous: ExpertSampleActionResult | null,
  form: FormData,
): Promise<ExpertSampleActionResult> {
  const session = await requireAdminCapability('expertLibraries');
  const applicationId = text(form, 'applicationId');
  try {
    const sample = await expertSampleProbe({ actor: await actor(session), applicationId });
    return { ok: true, sample };
  } catch (error) {
    if (error instanceof ExpertLibraryRefused) return { ok: false, error: error.code };
    console.error(`expert sample probe failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

/** Withdraw the tag from an approved application's library. */
export async function revokeExpertAction(
  _previous: ExpertAdminActionResult | null,
  form: FormData,
): Promise<ExpertAdminActionResult> {
  const session = await requireAdminCapability('expertLibraries');
  const applicationId = text(form, 'applicationId');
  try {
    const { voidedEvents } = await revokeExpertTag({
      actor: await actor(session),
      applicationId,
      reason: text(form, 'reason'),
    });
    revalidateApplication(applicationId);
    return { ok: true, voidedEvents };
  } catch (error) {
    return refused(error, 'expert revoke');
  }
}

/* ---------------------------------------------------------- thresholds */

export type ExpertThresholdsError = 'out_of_range' | 'reason_required' | 'unavailable';

export interface ExpertThresholdsActionResult {
  ok: boolean;
  error?: ExpertThresholdsError;
  /** Which threshold was refused, for the error that names one. */
  field?: ExpertThresholdKey;
}

/** Save the expert gate's thresholds (lib/domain/expert-thresholds.ts); every save is an immutable row with a reason. */
export async function updateExpertThresholdsAction(
  _previous: ExpertThresholdsActionResult | null,
  form: FormData,
): Promise<ExpertThresholdsActionResult> {
  const session = await requireAdminCapability('expertLibraries');
  try {
    const values: Partial<Record<ExpertThresholdKey, number>> = {};
    for (const key of EXPERT_THRESHOLD_KEYS) {
      const raw = text(form, key).trim();
      if (raw !== '') values[key] = Number(raw);
    }
    await updateExpertThresholds({ actor: await actor(session), values, reason: text(form, 'reason') });
    revalidatePath('/admin/expert-libraries/thresholds');
    return { ok: true };
  } catch (error) {
    if (error instanceof ExpertThresholdsRefused) return { ok: false, error: error.code, field: error.field };
    if (error instanceof AdminChangeRefused && error.code === 'reason_required') return { ok: false, error: 'reason_required' };
    console.error(`expert thresholds update failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

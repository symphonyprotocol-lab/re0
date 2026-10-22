'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { updateReviewRules } from '@/lib/application/review';
import { REVIEW_RULE_KEYS, ReviewRulesRefused, type ReviewRuleKey } from '@/lib/domain/auto-review';
import {
  addEvalQuestion,
  adoptEvalQuestion,
  closeReviewSample,
  probeReviewLibrary,
  removeEvalQuestion,
  reviewable,
  reviewUserLibrary,
  runLibraryEvaluation,
  type ProbeResult,
} from '@/lib/application/administration';
import { AdminChangeRefused } from '@/lib/domain/admin';
import { isUserReviewAction, PlatformLibraryRefused } from '@/lib/domain/library';
import { REVIEW_CHECKS } from '@/lib/domain/review';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';
import type { PlatformLibraryActionResult } from '../platform-libraries/actions';

/**
 * The mutations behind the user-library screens: a review decision, and the
 * reviewer's instruments -- a probe question and the library's test set.
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

/**
 * A review decision. A public library's form carries the 7.4 checklist as
 * `check.<id>` and `note.<id>` fields (lib/domain/review.ts); the use case
 * decides whether one is required and whether it agrees with the verb.
 */
export async function reviewUserLibraryAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('libraries');
  const libraryId = text(form, 'libraryId');
  const action = text(form, 'action');
  if (!isUserReviewAction(action)) return { ok: false, error: 'invalid_transition' };
  const hasChecklist = REVIEW_CHECKS.some((check) => form.has(`check.${check}`));

  try {
    await reviewUserLibrary({
      actor: await actor(session),
      libraryId,
      action,
      reason: text(form, 'reason'),
      ...(hasChecklist ? { checklist: form } : {}),
    });
    revalidatePath('/admin/libraries');
    revalidatePath(`/admin/libraries/${libraryId}`);
    return { ok: true };
  } catch (error) {
    return refused(error, 'review library');
  }
}

/** Close an open sample on an auto-published library: a person looked and found nothing wrong. */
export async function closeSampleAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('libraries');
  const libraryId = text(form, 'libraryId');
  try {
    await closeReviewSample({ actor: await actor(session), libraryId, reason: text(form, 'reason') });
    revalidatePath('/admin/libraries');
    revalidatePath(`/admin/libraries/${libraryId}`);
    return { ok: true, libraryId };
  } catch (error) {
    return refused(error, 'close sample');
  }
}

/* --------------------------------------------------------------- rules */

export type ReviewRulesError = 'out_of_range' | 'reason_required' | 'unavailable';

export interface ReviewRulesActionResult {
  ok: boolean;
  error?: ReviewRulesError;
  /** Which threshold was refused, for the error that names one. */
  field?: ReviewRuleKey;
}

/** Save the rules layer's thresholds (lib/domain/auto-review.ts); every save is an immutable row with a reason. */
export async function updateReviewRulesAction(
  _previous: ReviewRulesActionResult | null,
  form: FormData,
): Promise<ReviewRulesActionResult> {
  const session = await requireAdminCapability('libraries');
  try {
    const values: Partial<Record<ReviewRuleKey, number>> = {};
    for (const key of REVIEW_RULE_KEYS) {
      const raw = text(form, key).trim();
      if (raw !== '') values[key] = Number(raw);
    }
    await updateReviewRules({ actor: await actor(session), values, reason: text(form, 'reason') });
    revalidatePath('/admin/libraries/rules');
    return { ok: true };
  } catch (error) {
    if (error instanceof ReviewRulesRefused) return { ok: false, error: error.code, field: error.field };
    if (error instanceof AdminChangeRefused && error.code === 'reason_required') return { ok: false, error: 'reason_required' };
    console.error(`review rules update failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
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

/*
 * The test set, for a reviewer. The use cases are the platform console's
 * (manage-eval-questions.ts); what differs is the gate -- the `libraries`
 * capability, and only a public user library -- so a reviewer cannot reach
 * a platform library's questions through these.
 */

async function reviewableOrRefuse(libraryId: string): Promise<void> {
  if (!(await reviewable(libraryId))) throw new PlatformLibraryRefused('not_found', 'no such library');
}

export async function addReviewEvalQuestionAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('libraries');
  const libraryId = text(form, 'libraryId');
  try {
    await reviewableOrRefuse(libraryId);
    await addEvalQuestion({
      actor: await actor(session),
      libraryId,
      question: text(form, 'question'),
      expectedSource: text(form, 'expectedSource'),
      expectedText: text(form, 'expectedText'),
    });
    revalidatePath(`/admin/libraries/${libraryId}`);
    return { ok: true, libraryId };
  } catch (error) {
    return refused(error, 'review eval question add');
  }
}

export async function removeReviewEvalQuestionAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('libraries');
  const libraryId = text(form, 'libraryId');
  try {
    await reviewableOrRefuse(libraryId);
    await removeEvalQuestion({ actor: await actor(session), libraryId, questionId: text(form, 'questionId') });
    revalidatePath(`/admin/libraries/${libraryId}`);
    return { ok: true, libraryId };
  } catch (error) {
    return refused(error, 'review eval question remove');
  }
}

/** Adopt an owner's self-check question into the scored set; from then on it moves the Benchmark. */
export async function adoptReviewEvalQuestionAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('libraries');
  const libraryId = text(form, 'libraryId');
  try {
    await reviewableOrRefuse(libraryId);
    await adoptEvalQuestion({ actor: await actor(session), libraryId, questionId: text(form, 'questionId') });
    revalidatePath(`/admin/libraries/${libraryId}`);
    return { ok: true, libraryId };
  } catch (error) {
    return refused(error, 'review eval question adopt');
  }
}

export async function runReviewEvaluationAction(
  _previous: PlatformLibraryActionResult | null,
  form: FormData,
): Promise<PlatformLibraryActionResult> {
  const session = await requireAdminCapability('libraries');
  const libraryId = text(form, 'libraryId');
  try {
    await reviewableOrRefuse(libraryId);
    const evaluated = await runLibraryEvaluation({ actor: await actor(session), libraryId });
    revalidatePath(`/admin/libraries/${libraryId}`);
    return { ok: true, libraryId, evaluated };
  } catch (error) {
    return refused(error, 'review evaluation');
  }
}

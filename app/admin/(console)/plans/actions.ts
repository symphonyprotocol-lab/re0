'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { createPlanVersion } from '@/lib/application/plans';
import { AdminChangeRefused } from '@/lib/domain/admin';
import { PlanChangeRefused, type PlanChangeError } from '@/lib/domain/plans';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

/**
 * The one mutation the subscription-configuration screen has.
 *
 * It re-resolves the session and re-checks the capability, like every other
 * console action: a server action is a public endpoint with a generated name,
 * and that the page only renders the dialog for entitled operators says nothing
 * about who can post to it.
 */
export interface PlanActionResult {
  ok: boolean;
  error?: PlanChangeError;
  /** Set on success, so the dialog can report what the new version supersedes. */
  planVersionId?: string;
  supersededSubscriptions?: number;
}

async function actorAddress(): Promise<string | null> {
  const bag = await headers();
  return clientAddress(bag);
}

function refused(error: unknown): PlanActionResult {
  if (error instanceof PlanChangeRefused) return { ok: false, error: error.code };
  /*
   * `normalizeReason` is shared with the administrator screens and throws the
   * administrator refusal, so its one reachable code is translated rather than
   * flattened into a field error the operator would go looking for.
   */
  if (error instanceof AdminChangeRefused && error.code === 'reason_required') {
    return { ok: false, error: 'reason_required' };
  }
  console.error(`plan version failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'unavailable' };
}

export async function createPlanVersionAction(
  _previous: PlanActionResult | null,
  form: FormData,
): Promise<PlanActionResult> {
  const session = await requireAdminCapability('plans');
  try {
    const { planVersionId, supersededSubscriptions } = await createPlanVersion({
      actor: {
        administratorId: session.administratorId,
        email: session.email,
        clientAddress: await actorAddress(),
      },
      planId: String(form.get('planId') ?? ''),
      /*
       * The version the form was built from. Empty means the tier had none;
       * anything else is checked against the live row, so a dialog left open
       * while someone else minted a version is refused rather than allowed to
       * supersede a change it never displayed.
       */
      expectedLiveVersionId: String(form.get('liveVersionId') ?? '') || null,
      currency: String(form.get('currency') ?? 'USD'),
      price: String(form.get('price') ?? ''),
      calls: String(form.get('calls') ?? ''),
      libraryLimit: String(form.get('libraryLimit') ?? ''),
      librarySizeMb: String(form.get('librarySizeMb') ?? ''),
      apiKeyLimit: String(form.get('apiKeyLimit') ?? ''),
      shareRate: String(form.get('shareRate') ?? ''),
      buildBaseCalls: String(form.get('buildBaseCalls') ?? ''),
      buildTokensPerCall: String(form.get('buildTokensPerCall') ?? ''),
      buildPagesPerCall: String(form.get('buildPagesPerCall') ?? ''),
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/plans');
    return { ok: true, planVersionId, supersededSubscriptions };
  } catch (error) {
    return refused(error);
  }
}

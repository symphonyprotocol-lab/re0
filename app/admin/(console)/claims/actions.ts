'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { revokeClaim, ruleDispute } from '@/lib/application/claims';
import { AdminChangeRefused } from '@/lib/domain/admin';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

/**
 * The three moves the console has over ownership. requirement.md 5.3, 7.3.5.
 *
 * Each re-resolves the session and re-checks the `claims` capability. That is
 * not belt and braces: a server action is a public endpoint with a generated
 * name, and the list only rendering these controls for an entitled operator
 * says nothing about who can post to them.
 *
 * Each also takes a reason, and the use case writes the audit row. Ruling is
 * the one path to ownership that skips source verification (7.3.4), so the
 * record of *why* is the only thing standing between an arbitration and a
 * transfer nobody can account for.
 */
export interface ClaimAdminActionResult {
  ok: boolean;
  error?: 'not_found' | 'invalid_input' | 'reason_required' | 'unavailable';
  /** Set on a revoke: whether the asset also lost its owner. */
  ownerCleared?: boolean;
}

function refused(error: unknown, context: string): ClaimAdminActionResult {
  if (error instanceof AdminChangeRefused) {
    if (
      error.code === 'not_found' ||
      error.code === 'invalid_input' ||
      error.code === 'reason_required'
    ) {
      return { ok: false, error: error.code };
    }
  }
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

/** Both revalidations: the queue the operator came from, and the claim itself. */
function revalidateClaim(claimId: string): void {
  revalidatePath('/admin/claims');
  revalidatePath(`/admin/claims/${claimId}`);
}

/**
 * Decide a dispute: `grant` moves ownership to the claimant, `dismiss` leaves
 * the current owner alone and closes the claim. Anything else is refused here
 * rather than passed on as a string the use case would have to guess at.
 */
export async function ruleDisputeAction(
  _previous: ClaimAdminActionResult | null,
  form: FormData,
): Promise<ClaimAdminActionResult> {
  const session = await requireAdminCapability('claims');
  const decision = text(form, 'decision');
  if (decision !== 'grant' && decision !== 'dismiss') return { ok: false, error: 'invalid_input' };

  const claimId = text(form, 'claimId');
  try {
    await ruleDispute({
      actor: await actor(session),
      claimId,
      decision,
      reason: text(form, 'reason'),
    });
    revalidateClaim(claimId);
    return { ok: true };
  } catch (error) {
    return refused(error, `claim ${decision}`);
  }
}

/**
 * Close a claim. On a verified one the asset loses its owner too, which the
 * result reports so the dialog can say which of the two things happened.
 */
export async function revokeClaimAction(
  _previous: ClaimAdminActionResult | null,
  form: FormData,
): Promise<ClaimAdminActionResult> {
  const session = await requireAdminCapability('claims');
  const claimId = text(form, 'claimId');
  try {
    const { ownerCleared } = await revokeClaim({
      actor: await actor(session),
      claimId,
      reason: text(form, 'reason'),
    });
    revalidateClaim(claimId);
    return { ok: true, ownerCleared };
  } catch (error) {
    return refused(error, 'claim revoke');
  }
}

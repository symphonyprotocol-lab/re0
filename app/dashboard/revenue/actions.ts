'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  canRedeemEarnings,
  redeemEarningsAsCalls,
  requestPayout,
  savePayoutProfile,
  submitTaxDocument,
} from '@/lib/application/revenue';
import { refusalCode } from '@/lib/http/refusal-code';
import {
  EarningCreditRefused,
  PayoutRefused,
  type EarningCreditError,
  type PayoutError,
} from '@/lib/domain';
import { requireSession } from '@/lib/http/session';

/**
 * The two mutations on the revenue screen (agent-first-proposal.md 6.9):
 * turn every redeemable statement into Additional Calls, or ask for the same
 * statements to be paid out in cash to a PayPal address.
 *
 * Re-resolves the session and re-checks the role: a server action is a public
 * endpoint with a generated name, and the page hiding the button from viewers
 * says nothing about who can post to it.
 */
export interface RedeemEarningsActionResult {
  ok: boolean;
  error?: EarningCreditError | 'forbidden' | 'failed';
  outcome?: { amountMinor: number; calls: number; statements: number };
}

export async function redeemEarningsAction(
  _previous: RedeemEarningsActionResult | null,
  _form: FormData,
): Promise<RedeemEarningsActionResult> {
  const session = await requireSession('/dashboard/revenue');
  if (!canRedeemEarnings(session.workspace.role)) return { ok: false, error: 'forbidden' };

  try {
    const result = await redeemEarningsAsCalls({
      workspaceId: session.workspace.id,
      actor: { kind: 'user', id: session.user.id },
    });
    revalidatePath('/dashboard/revenue');
    revalidatePath('/dashboard');
    revalidatePath('/dashboard/settings');
    return {
      ok: true,
      outcome: {
        amountMinor: result.amountMinor,
        calls: result.calls,
        statements: result.statements,
      },
    };
  } catch (error) {
    if (error instanceof EarningCreditRefused) return { ok: false, error: error.code };
    console.error(
      `earning redemption failed: ${error instanceof Error ? error.message : 'unknown'}`,
    );
    return { ok: false, error: 'failed' };
  }
}

export interface RequestPayoutActionResult {
  ok: boolean;
  error?: PayoutError | 'forbidden' | 'failed';
  outcome?: { amountMinor: number; statements: number; payeeEmail: string };
}

export async function requestPayoutAction(
  _previous: RequestPayoutActionResult | null,
  form: FormData,
): Promise<RequestPayoutActionResult> {
  const session = await requireSession('/dashboard/revenue');
  /* Cash spends the same statements the credit does, so the same roles may. */
  if (!canRedeemEarnings(session.workspace.role)) return { ok: false, error: 'forbidden' };

  try {
    const result = await requestPayout({
      workspaceId: session.workspace.id,
      actor: { kind: 'user', id: session.user.id },
      payeeEmail: String(form.get('payeeEmail') ?? ''),
    });
    revalidatePath('/dashboard/revenue');
    return {
      ok: true,
      outcome: {
        amountMinor: result.amountMinor,
        statements: result.statements,
        payeeEmail: result.payeeEmail,
      },
    };
  } catch (error) {
    if (error instanceof PayoutRefused) return { ok: false, error: error.code };
    console.error(`payout request failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'failed' };
  }
}

/**
 * The payout profile (agent-first-proposal.md 6.9): the PayPal address, and
 * the record that a tax document was sent to operations. Plain form posts.
 */
export async function savePayoutProfileAction(form: FormData): Promise<void> {
  const session = await requireSession('/dashboard/revenue');
  let notice = 'saved';
  try {
    if (!canRedeemEarnings(session.workspace.role)) throw new PayoutRefused('no_account', 'forbidden');
    if (form.get('intent') === 'tax') {
      await submitTaxDocument({ workspaceId: session.workspace.id, kind: String(form.get('taxFormKind') ?? '') });
      notice = 'submitted';
    } else {
      await savePayoutProfile({ workspaceId: session.workspace.id, payeeEmail: String(form.get('payeeEmail') ?? '') });
    }
    revalidatePath('/dashboard/revenue');
  } catch (error) {
    notice = refusalCode(error, 'payout profile');
  }
  redirect(`/dashboard/revenue?profile=${notice}#profile`);
}

'use server';

import { revalidatePath } from 'next/cache';
import { canRedeemEarnings, redeemEarningsAsCalls } from '@/lib/application/revenue';
import { EarningCreditRefused, type EarningCreditError } from '@/lib/domain';
import { requireSession } from '@/lib/http/session';

/**
 * The one mutation on the revenue screen: turn every redeemable statement
 * into Additional Calls (publisher-revenue-share.md 3.4).
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
    const result = await redeemEarningsAsCalls({ workspaceId: session.workspace.id });
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

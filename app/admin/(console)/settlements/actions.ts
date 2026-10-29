'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  generateSettlements,
  markPayoutFailed,
  markPayoutPaid,
} from '@/lib/application/administration';
import { PayoutResolveRefused, type PayoutResolveError } from '@/lib/domain';
import { AdminChangeRefused, type AdminChangeError } from '@/lib/domain/admin';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

/**
 * The mutations behind the settlements screen: generating a period's
 * statements, and recording the outcome of a manual PayPal payout.
 *
 * Re-resolves the session and re-checks the capability like every console
 * action: a server action is a public endpoint with a generated name, and the
 * page rendering the button only for entitled operators says nothing about
 * who can post to it.
 */
export interface SettlementActionResult {
  ok: boolean;
  error?: Extract<AdminChangeError, 'period_invalid' | 'reason_required' | 'invalid_input'>;
  /** What the run did, so the dialog can report it in numbers. */
  outcome?: {
    periodId: string;
    totalAmountMinor: number;
    created: number;
    createdMinor: number;
    withoutAccount: number;
    alreadyPresent: number;
  };
}

export async function generateSettlementsAction(
  _previous: SettlementActionResult | null,
  form: FormData,
): Promise<SettlementActionResult> {
  const session = await requireAdminCapability('billing');
  const bag = await headers();

  try {
    const result = await generateSettlements({
      actor: {
        administratorId: session.administratorId,
        email: session.email,
        clientAddress: clientAddress(bag),
      },
      periodId: String(form.get('period') ?? ''),
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/settlements');
    return {
      ok: true,
      outcome: {
        periodId: result.periodId,
        totalAmountMinor: result.totalAmountMinor,
        created: result.created,
        createdMinor: result.createdMinor,
        withoutAccount: result.withoutAccount,
        alreadyPresent: result.alreadyPresent,
      },
    };
  } catch (error) {
    if (error instanceof AdminChangeRefused) {
      return {
        ok: false,
        error:
          error.code === 'period_invalid' || error.code === 'reason_required'
            ? error.code
            : 'invalid_input',
      };
    }
    console.error(
      `settlement generation failed: ${error instanceof Error ? error.message : 'unknown'}`,
    );
    return { ok: false, error: 'invalid_input' };
  }
}

export interface PayoutActionResult {
  ok: boolean;
  error?: PayoutResolveError | 'reason_required';
  outcome?: { status: 'paid' | 'failed'; amountMinor: number; statements: number };
}

function payoutRefused(error: unknown, what: string): PayoutActionResult {
  if (error instanceof PayoutResolveRefused) return { ok: false, error: error.code };
  /* The one console-wide refusal these can raise: the reason the audit row needs. */
  if (error instanceof AdminChangeRefused) {
    return { ok: false, error: error.code === 'reason_required' ? 'reason_required' : 'invalid_input' };
  }
  console.error(`${what} failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { ok: false, error: 'invalid_input' };
}

/** The money went out: record the PayPal transaction id. */
export async function markPayoutPaidAction(
  _previous: PayoutActionResult | null,
  form: FormData,
): Promise<PayoutActionResult> {
  const session = await requireAdminCapability('billing');
  const bag = await headers();

  try {
    const result = await markPayoutPaid({
      actor: {
        administratorId: session.administratorId,
        email: session.email,
        clientAddress: clientAddress(bag),
      },
      payoutId: String(form.get('payoutId') ?? ''),
      reference: String(form.get('reference') ?? ''),
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/settlements');
    return {
      ok: true,
      outcome: { status: 'paid', amountMinor: result.amountMinor, statements: result.statements },
    };
  } catch (error) {
    return payoutRefused(error, 'marking a payout paid');
  }
}

/** The money could not go out: the statements return to the publisher. */
export async function markPayoutFailedAction(
  _previous: PayoutActionResult | null,
  form: FormData,
): Promise<PayoutActionResult> {
  const session = await requireAdminCapability('billing');
  const bag = await headers();

  try {
    const result = await markPayoutFailed({
      actor: {
        administratorId: session.administratorId,
        email: session.email,
        clientAddress: clientAddress(bag),
      },
      payoutId: String(form.get('payoutId') ?? ''),
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/settlements');
    return {
      ok: true,
      outcome: { status: 'failed', amountMinor: result.amountMinor, statements: result.statements },
    };
  } catch (error) {
    return payoutRefused(error, 'marking a payout failed');
  }
}

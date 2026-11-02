/**
 * Step 6's refusals as responses: a user-side refusal is its code with 403
 * (official accounts), 409 (the state does not allow it now) or 422 (the
 * input); anything else is rethrown.
 */
import type { NextResponse } from 'next/server';
import { fail } from '@/lib/http/respond';
import { KycRefused } from '@/lib/services/kyc';
import { PayoutRefused } from '@/lib/services/payouts';

const CONFLICT = new Set(['kyc_pending', 'kyc_verified', 'kyc_required', 'payout_open', 'paypal_required', 'paypal_hold', 'not_found']);

export function refusal(error: unknown): NextResponse {
  if (error instanceof KycRefused || error instanceof PayoutRefused) {
    if (error.code === 'official') return fail(error.code, 403);
    return fail(error.code, CONFLICT.has(error.code) ? 409 : 422);
  }
  throw error;
}

'use server';

import { headers } from 'next/headers';
import { completeEnrolment } from '@/lib/application/administration';
import { AdminChangeRefused, type AdminChangeError } from '@/lib/domain/admin';
import { clientAddress } from '@/lib/http/client-address';

export interface EnrolResult {
  ok: boolean;
  error?: AdminChangeError | 'mismatch';
}

/**
 * Finishes an invitation.
 *
 * Deliberately unauthenticated -- the invitee has no session yet; the
 * invitation token is the credential, and it is single use and expiring. The
 * password never leaves this call, and the TOTP secret is not accepted from the
 * form at all: the use case recomputes it from the token.
 */
export async function completeEnrolmentAction(
  _previous: EnrolResult | null,
  form: FormData,
): Promise<EnrolResult> {
  const password = String(form.get('password') ?? '');
  if (password !== String(form.get('confirm') ?? '')) return { ok: false, error: 'mismatch' };

  const bag = await headers();
  try {
    await completeEnrolment({
      token: String(form.get('token') ?? ''),
      ticket: String(form.get('ticket') ?? ''),
      password,
      mfaCode: String(form.get('mfa') ?? ''),
      clientAddress: clientAddress(bag),
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof AdminChangeRefused) return { ok: false, error: error.code };
    console.error(`enrolment failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'invalid_input' };
  }
}

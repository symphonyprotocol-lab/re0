'use server';

import { headers } from 'next/headers';
import { bootstrapFirstAdministrator } from '@/lib/application/administration';
import { AdminChangeRefused, type AdminChangeError } from '@/lib/domain/admin';
import { clientAddress } from '@/lib/http/client-address';

export interface BootstrapResult {
  ok: boolean;
  error?: AdminChangeError | 'mismatch';
}

/**
 * Registers the first administrator of an installation that has none.
 *
 * Unauthenticated by necessity -- there is nobody to authenticate as yet. What
 * stands in for a credential is the state of the table: the use case refuses
 * unless `administrator` is still empty when it writes, so reaching this action
 * without the page (the form is only rendered while the console has no owner)
 * gets the same refusal rather than a second owner.
 */
export async function bootstrapAdministratorAction(
  _previous: BootstrapResult | null,
  form: FormData,
): Promise<BootstrapResult> {
  const password = String(form.get('password') ?? '');
  if (password !== String(form.get('confirm') ?? '')) return { ok: false, error: 'mismatch' };

  const bag = await headers();
  try {
    await bootstrapFirstAdministrator({
      email: String(form.get('email') ?? ''),
      username: String(form.get('username') ?? ''),
      password,
      mfaCode: String(form.get('mfa') ?? ''),
      ticket: String(form.get('ticket') ?? ''),
      clientAddress: clientAddress(bag),
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof AdminChangeRefused) return { ok: false, error: error.code };
    console.error(`bootstrap failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'invalid_input' };
  }
}

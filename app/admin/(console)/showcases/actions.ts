'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { AppError } from '@/contracts/errors';
import { AdminChangeRefused } from '@/lib/domain/admin';
import { moderateShowcase } from '@/lib/application/showcase';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

/**
 * The console's two moves over a showcase page: take it down, reinstate
 * it. Each re-resolves the session and re-checks the `libraries`
 * capability (content review, lib/domain/admin.ts), takes a reason, and
 * the use case writes the audit row.
 */
export interface ShowcaseAdminActionResult {
  ok: boolean;
  error?: 'reason_required' | 'not_found' | 'not_applicable' | 'unavailable';
}

export async function moderateShowcaseAction(
  _previous: ShowcaseAdminActionResult | null,
  form: FormData,
): Promise<ShowcaseAdminActionResult> {
  const session = await requireAdminCapability('libraries');
  const verb = String(form.get('verb') ?? '');
  if (verb !== 'take_down' && verb !== 'reinstate') return { ok: false, error: 'not_applicable' };
  const showcaseId = String(form.get('showcaseId') ?? '');
  try {
    const slug = String(form.get('slug') ?? '');
    await moderateShowcase({
      actor: {
        administratorId: session.administratorId,
        email: session.email,
        clientAddress: clientAddress(await headers()),
      },
      showcaseId,
      verb,
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/showcases');
    if (slug) revalidatePath(`/s/${slug}`);
    return { ok: true };
  } catch (error) {
    if (error instanceof AdminChangeRefused && error.code === 'reason_required') return { ok: false, error: 'reason_required' };
    if (error instanceof AppError) {
      if (error.code === 'library_not_found') return { ok: false, error: 'not_found' };
      if (error.code === 'invalid_request') return { ok: false, error: 'not_applicable' };
    }
    console.error(`showcase ${verb} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

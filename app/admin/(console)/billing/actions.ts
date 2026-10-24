'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import {
  backfillProviderDocument,
  BackfillRefused,
  type BackfillRefusal,
  type BackfillResult,
} from '@/lib/application/billing';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

/**
 * The one mutation behind the billing screen: backfill a document the
 * provider's webhook never delivered.
 *
 * Re-resolves the session and re-checks the capability like every console
 * action: a server action is a public endpoint with a generated name, and the
 * page rendering the button only for entitled operators says nothing about
 * who can post to it.
 */
export interface BackfillActionResult {
  ok: boolean;
  error?: BackfillRefusal;
  outcome?: BackfillResult;
}

export async function backfillDocumentAction(
  _previous: BackfillActionResult | null,
  form: FormData,
): Promise<BackfillActionResult> {
  const session = await requireAdminCapability('billing');
  const bag = await headers();

  try {
    const outcome = await backfillProviderDocument({
      actor: {
        administratorId: session.administratorId,
        email: session.email,
        clientAddress: clientAddress(bag),
      },
      externalId: String(form.get('externalId') ?? ''),
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/billing');
    return { ok: true, outcome };
  } catch (error) {
    if (error instanceof BackfillRefused) return { ok: false, error: error.code };
    console.error(`billing backfill failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { ok: false, error: 'unavailable' };
  }
}

'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { updateCommerceConfig } from '@/lib/application/administration';
import { verifyTaxDocument } from '@/lib/application/revenue';
import { AdminChangeRefused } from '@/lib/domain/admin';
import { COMMERCE_SETTING_KEYS, CommerceConfigRefused, type CommerceSettingKey } from '@/lib/domain/commerce-config';
import { requireAdminCapability } from '@/lib/http/admin';
import { clientAddress } from '@/lib/http/client-address';

/**
 * The channel-commerce console (agent-first-proposal.md 6.9, 13.2): save
 * the four settings, verify or send back a creator's tax document. Both
 * take a reason and land in the audit chain; both re-check the capability.
 */
export async function updateCommerceConfigAction(form: FormData): Promise<void> {
  const session = await requireAdminCapability('billing');
  let outcome = 'saved';
  try {
    const values = Object.fromEntries(
      COMMERCE_SETTING_KEYS.map((key) => [key, Number(form.get(key) ?? Number.NaN)]),
    ) as Record<CommerceSettingKey, number>;
    await updateCommerceConfig({
      actor: { administratorId: session.administratorId, email: session.email, clientAddress: clientAddress(await headers()) },
      values,
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/commerce');
  } catch (error) {
    if (error instanceof CommerceConfigRefused) outcome = `invalid_${error.key}`;
    else if (error instanceof AdminChangeRefused) outcome = error.code;
    else {
      console.error(`commerce config failed: ${error instanceof Error ? error.message : 'unknown'}`);
      outcome = 'unavailable';
    }
  }
  redirect(`/admin/commerce?notice=${outcome}`);
}

export async function verifyTaxDocumentAction(form: FormData): Promise<void> {
  const session = await requireAdminCapability('billing');
  let outcome = 'saved';
  try {
    await verifyTaxDocument({
      actor: { administratorId: session.administratorId, clientAddress: clientAddress(await headers()) },
      publisherAccountId: String(form.get('publisherAccountId') ?? ''),
      verified: form.get('verified') === 'yes',
      reason: String(form.get('reason') ?? ''),
    });
    revalidatePath('/admin/commerce');
  } catch (error) {
    outcome = error instanceof AdminChangeRefused ? error.code : 'unavailable';
    if (outcome === 'unavailable') console.error(`tax verification failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  redirect(`/admin/commerce?notice=${outcome}#tax`);
}

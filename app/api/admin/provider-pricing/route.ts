import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { providerPrices, providerPricingMigrationMissing, saveProviderPrices } from '@/lib/services/provider-pricing';

export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  return json(await providerPrices());
}
export async function PUT(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json(await saveProviderPrices(administrator.id, await body(request)));
  } catch (error) {
    if (providerPricingMigrationMissing(error)) return fail('provider_pricing_migration_required', 503);
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'pricing_conflict' ? 409 : 422);
    throw error;
  }
}

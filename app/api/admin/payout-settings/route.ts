import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { saveSitePayoutMinimum, sitePayoutMinimum } from '@/lib/services/payout-minimum';

/** The site-wide payout minimum: `{ credits, revision }`, audited. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  return json({ minimum: await sitePayoutMinimum() });
}

export async function PUT(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json({ minimum: await saveSitePayoutMinimum(administrator.id, await body(request)) });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'pricing_conflict' ? 409 : 422);
    throw error;
  }
}

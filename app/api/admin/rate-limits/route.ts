import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { listCeilings, listRateLimitExemptions, listRateLimits, resetRateLimit, saveRateLimit } from '@/lib/services/rate-limit-settings';

/** Every user-route limit and daily or per-minute ceiling (stored value or default), and the exempt accounts. */
export async function GET(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const [limits, exemptions, ceilings] = await Promise.all([listRateLimits(), listRateLimitExemptions(), listCeilings()]);
  return json({ limits, exemptions, ceilings });
}

/** Saves one limit: `{ name, perMinute, perHour }`, audited. */
export async function PUT(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const input = await body(request);
  try {
    return json({ limit: await saveRateLimit(administrator.id, String(input.name ?? ''), input) });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'not_found' ? 404 : 422);
    throw error;
  }
}

/** Puts one limit (`{ name }`) back to its code default, audited. */
export async function DELETE(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  const input = await body(request);
  try {
    return json({ limit: await resetRateLimit(administrator.id, String(input.name ?? '')) });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, 404);
    throw error;
  }
}

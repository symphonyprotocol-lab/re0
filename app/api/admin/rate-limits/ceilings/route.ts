import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { resetCeiling, saveCeiling } from '@/lib/services/rate-limit-settings';

/** Saves one daily or per-minute ceiling: `{ key, value }`, audited. */
export async function PUT(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json({ ceiling: await saveCeiling(administrator.id, await body(request)) });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'not_found' ? 404 : 422);
    throw error;
  }
}

/** Puts one ceiling (`{ key }`) back to its code default, audited. */
export async function DELETE(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json({ ceiling: await resetCeiling(administrator.id, await body(request)) });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, 404);
    throw error;
  }
}

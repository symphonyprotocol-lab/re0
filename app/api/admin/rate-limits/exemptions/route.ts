import type { NextRequest } from 'next/server';
import { apiAdministrator } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { AdminInputError } from '@/lib/services/admin';
import { addRateLimitExemption } from '@/lib/services/rate-limit-settings';

/** Exempts an account from every user-route limit: `{ email }` or `{ userId }`, optional `note`. */
export async function POST(request: NextRequest) {
  const administrator = await apiAdministrator(request);
  if (administrator instanceof Response) return administrator;
  try {
    return json({ exemption: await addRateLimitExemption(administrator.id, await body(request)) });
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'user_not_found' ? 404 : error.code === 'ambiguous_email' ? 409 : 422);
    throw error;
  }
}

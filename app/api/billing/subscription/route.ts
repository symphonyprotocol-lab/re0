import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { PaddleError, PaddleNotConfigured } from '@/lib/infra/paddle';
import { setRenewal } from '@/lib/services/billing';

/** `POST /api/billing/subscription` `{action: 'cancel'|'resume'}`: turn the Plan's renewal off or back on. */
export async function POST(request: NextRequest) {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  try {
    const result = await setRenewal(user.id, (await body(request)).action);
    if (!result.ok) return fail(result.error, result.error === 'no_subscription' ? 409 : 400);
    return json(result);
  } catch (error) {
    if (error instanceof PaddleNotConfigured) return fail('payments_unavailable', 503);
    if (error instanceof PaddleError) {
      console.error('renewal change failed', error.message);
      return fail('payment_provider', 502);
    }
    throw error;
  }
}

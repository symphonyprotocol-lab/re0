import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { setAdminCookie } from '@/lib/http/admin';
import { clientIp } from '@/lib/http/conversations';
import { sameOrigin } from '@/lib/http/session';
import { AdminInputError, AdminRateLimitError, signInAdministrator } from '@/lib/services/admin';

/**
 * Password + TOTP. Every credential failure is the same 401, whatever went
 * wrong; too many recent failures from this address answer 429 with
 * `retry-after` before anything is checked.
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const input = await body(request);
  try {
    const session = await signInAdministrator({
      email: String(input.email ?? ''),
      password: String(input.password ?? ''),
      code: String(input.code ?? ''),
      ip: clientIp(request.headers),
    });
    const response = json({ ok: true });
    setAdminCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    if (error instanceof AdminRateLimitError) {
      const response = fail('too_many_attempts', 429, { retryAfter: error.retryAfter });
      response.headers.set('retry-after', String(error.retryAfter));
      return response;
    }
    if (error instanceof AdminInputError) return fail('invalid_credentials', 401);
    throw error;
  }
}

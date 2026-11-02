import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { setAdminCookie } from '@/lib/http/admin';
import { sameOrigin } from '@/lib/http/session';
import { AdminInputError, signInAdministrator } from '@/lib/services/admin';

/** Password + TOTP. Every failure is the same 401, whatever went wrong. */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const input = await body(request);
  try {
    const session = await signInAdministrator({
      email: String(input.email ?? ''),
      password: String(input.password ?? ''),
      code: String(input.code ?? ''),
    });
    const response = json({ ok: true });
    setAdminCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    if (error instanceof AdminInputError) return fail('invalid_credentials', 401);
    throw error;
  }
}

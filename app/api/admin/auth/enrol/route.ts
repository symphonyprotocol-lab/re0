import type { NextRequest } from 'next/server';
import { setAdminCookie } from '@/lib/http/admin';
import { body, fail, json } from '@/lib/http/respond';
import { sameOrigin } from '@/lib/http/session';
import { AdminInputError, openAdminSession } from '@/lib/services/admin';
import { acceptInvite } from '@/lib/services/admin-administrators';

/** An invited administrator sets a password and binds TOTP through their link, then is signed in. */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const input = await body(request);
  try {
    const administrator = await acceptInvite({
      token: String(input.token ?? ''),
      password: String(input.password ?? ''),
      sealedSecret: String(input.sealedSecret ?? ''),
      code: String(input.code ?? ''),
    });
    const session = await openAdminSession(administrator.id);
    const response = json({ ok: true });
    setAdminCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, 422);
    throw error;
  }
}

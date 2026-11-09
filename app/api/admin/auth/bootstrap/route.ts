import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { setAdminCookie } from '@/lib/http/admin';
import { sameOrigin } from '@/lib/http/session';
import { AdminInputError, bootstrapFirstAdministrator, openAdminSession } from '@/lib/services/admin';

/** Empty installation only: registers the first administrator and signs them in. */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request.headers)) return fail('cross_origin', 403);
  const input = await body(request);
  try {
    const administrator = await bootstrapFirstAdministrator({
      name: String(input.name ?? ''),
      email: String(input.email ?? ''),
      password: String(input.password ?? ''),
      sealedSecret: String(input.sealedSecret ?? ''),
      code: String(input.code ?? ''),
    });
    const session = await openAdminSession(administrator.id);
    const response = json({ ok: true });
    setAdminCookie(response, session.token, session.expiresAt);
    return response;
  } catch (error) {
    if (error instanceof AdminInputError) return fail(error.code, error.code === 'bootstrap_closed' ? 409 : 422);
    throw error;
  }
}

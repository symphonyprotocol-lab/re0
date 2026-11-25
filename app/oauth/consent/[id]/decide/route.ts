import { NextResponse, type NextRequest } from 'next/server';
import { body, fail } from '@/lib/http/respond';
import { apiUser } from '@/lib/http/session';
import { consentCookieName, consentCookieOptions } from '@/lib/http/oauth';
import { ConsentError, decideAuthorization } from '@/lib/services/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The consent page's decision: `{approve, permissions?}` → `{redirect}`, the
 * client's redirect URI with a code or `access_denied`. Needs the signed-in
 * user, a same-origin request (apiUser) and the cookie `/oauth/authorize`
 * set in this browser for this request -- so another site cannot approve on
 * the user's behalf, and a consent link sent to someone else does nothing.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  const { id } = await context.params;
  const input = await body(request);
  try {
    const { redirect } = await decideAuthorization(user.id, id, request.cookies.get(consentCookieName())?.value, {
      approve: input.approve === true,
      permissions: input.permissions && typeof input.permissions === 'object' ? (input.permissions as Record<string, unknown>) : {},
    });
    const response = NextResponse.json({ redirect }, { headers: { 'cache-control': 'no-store' } });
    response.cookies.set(consentCookieName(), '', consentCookieOptions(id, 0));
    return response;
  } catch (error) {
    if (error instanceof ConsentError) return fail(error.code, error.code === 'expired' ? 410 : 422);
    throw error;
  }
}

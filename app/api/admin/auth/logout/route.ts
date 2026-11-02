import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE, appBaseUrl } from '@/lib/http/cookies';
import { clearAdminCookie } from '@/lib/http/admin';
import { sameOrigin } from '@/lib/http/session';
import { closeAdminSession } from '@/lib/services/admin';

export async function POST(request: NextRequest) {
  if (!sameOrigin(request.headers)) return new NextResponse('cross-origin request refused', { status: 403 });
  await closeAdminSession(request.cookies.get(ADMIN_SESSION_COOKIE)?.value);
  const response = NextResponse.redirect(new URL('/admin/login', appBaseUrl()), 303);
  clearAdminCookie(response);
  return response;
}

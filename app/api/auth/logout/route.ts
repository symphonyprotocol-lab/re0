import { NextResponse, type NextRequest } from 'next/server';
import { appBaseUrl, SESSION_COOKIE } from '@/lib/http/cookies';
import { clearSessionCookie, sameOrigin } from '@/lib/http/session';
import { signOut } from '@/lib/services/auth';

export async function POST(request: NextRequest) {
  if (!sameOrigin(request.headers)) return new NextResponse('cross-origin request refused', { status: 403 });
  await signOut(request.cookies.get(SESSION_COOKIE)?.value);
  const response = NextResponse.redirect(new URL('/login', appBaseUrl()), 303);
  clearSessionCookie(response);
  return response;
}

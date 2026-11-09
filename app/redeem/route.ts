import { NextResponse, type NextRequest } from 'next/server';

/**
 * `/redeem?code=…`, the link a redeem code can be sent as: a 302 to the
 * balance tab with the code filled in, never submitted (docs/design/redeem-codes.md
 * 6.2). Signing in is that page's business.
 */
export function GET(request: NextRequest) {
  const target = new URL('/settings?tab=balance', request.url);
  const code = request.nextUrl.searchParams.get('code')?.trim().slice(0, 60);
  if (code && /^[\w\s-]+$/.test(code)) target.searchParams.set('code', code);
  target.hash = 'redeem';
  return NextResponse.redirect(target, 302);
}

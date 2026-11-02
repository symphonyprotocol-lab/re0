import { NextResponse, type NextRequest } from 'next/server';

/** `/billing` lives on as a 302 to the settings tab (8.2, "路由命名"); signing in is that page's business. */
export function GET(request: NextRequest) {
  return NextResponse.redirect(new URL('/settings?tab=billing', request.url), 302);
}

/**
 * POST /s/[slug]/api/unlock -- a visitor's password for a link-only
 * page (lib/http/showcase-gate.ts). A correct one earns the unlock cookie;
 * a wrong one is a 403 that says only that. Ten tries an hour per browser
 * is a person who mistyped; the page's own hourly cap stops a distributed
 * guess.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { surfaceEnabled } from '@/lib/domain/surfaces';
import { AppError } from '@/contracts/errors';
import { verifyAdminPassword } from '@/lib/application/administration/password';
import { showcasePasswordFor } from '@/lib/application/showcase';
import { isShowcaseExpired } from '@/lib/domain/showcase';
import { rateLimitKey } from '@/lib/http/auth-endpoints';
import { configuredBaseUrl } from '@/lib/http/base-url';
import { errorResponse, newRequestId } from '@/lib/http/respond';
import { issueShowcaseUnlock, setShowcaseUnlockCookie } from '@/lib/http/showcase-gate';
import { isShowcaseOrigin } from '@/lib/http/widget-ask';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';

export const runtime = 'nodejs';

const VISITOR_RULE = { limit: 10, windowSeconds: 3_600 };
const PAGE_RULE = { limit: 200, windowSeconds: 3_600 };

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  /* agent-first-proposal.md 3.6: shared pages are offline. */
  if (!surfaceEnabled('showcase')) return new NextResponse(null, { status: 404 });
  const requestId = newRequestId();
  try {
    const { slug } = await context.params;
    let body: { password?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      throw new AppError('invalid_request', 'the body must be JSON');
    }
    const password = typeof body.password === 'string' ? body.password : '';

    const visitor = await strictRateLimit(await rateLimitKey(request, `showcase:unlock:${slug}`), VISITOR_RULE);
    if (!visitor.allowed) throw new AppError('rate_limited', 'too many tries; wait a while');

    const page = await showcasePasswordFor(slug);
    if (!page || isShowcaseExpired(page.gate.expiresAt)) throw new AppError('library_not_found', 'no such page');
    if (!isShowcaseOrigin(request.headers.get('origin'), request, configuredBaseUrl(), page.customHost)) {
      throw new AppError('access_denied', 'a showcase page unlocks only on its own site');
    }

    const daily = await strictRateLimit(`showcase:unlock:page:${page.showcaseId}`, PAGE_RULE);
    if (!daily.allowed) throw new AppError('rate_limited', 'too many tries on this page; wait a while');

    if (password.length === 0 || !(await verifyAdminPassword(password, page.hash))) {
      throw new AppError('access_denied', 'wrong password');
    }

    const response = new NextResponse(null, { status: 204 });
    setShowcaseUnlockCookie(response, await issueShowcaseUnlock(page.showcaseId, page.gate.passwordVersion), slug);
    return response;
  } catch (error) {
    return errorResponse(error, requestId) as unknown as NextResponse;
  }
}

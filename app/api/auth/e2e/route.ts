import { NextResponse, type NextRequest } from 'next/server';
import { timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { setSessionCookie } from '@/lib/http/session';
import { createSession } from '@/lib/services/auth';

/**
 * Sign-in for end-to-end tests and local walkthroughs, where Google and
 * GitHub cannot be driven. Exists only under `next dev` / vitest (never in a
 * build: Vercel and `next start` run with NODE_ENV=production) and only when
 * E2E_LOGIN_SECRET is set; the caller must present that secret. Test users
 * are keyed `e2e:<name>` under the github provider, so they never collide
 * with a real account.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.E2E_LOGIN_SECRET ?? '';
  if (process.env.NODE_ENV === 'production' || secret.length < 32) return new NextResponse(null, { status: 404 });
  const presented = request.headers.get('x-e2e-secret') ?? '';
  if (!timingSafeEqual(presented, secret)) return new NextResponse(null, { status: 404 });
  const input = (await request.json().catch(() => ({}))) as { name?: string; lang?: string; invite?: string };
  const name = (input.name ?? 'tester').replace(/[^\w-]/g, '').slice(0, 40) || 'tester';
  const result = await createSession(
    {
      provider: 'github',
      subject: `e2e:${name}`,
      handle: `e2e-${name}`,
      email: `${name}@e2e.example.test`,
      displayName: `E2E ${name}`,
      avatarUrl: null,
    },
    input.lang === 'en' ? 'en' : 'zh',
    '/dashboard',
    new Date(),
    { invite: input.invite },
  );
  const response = NextResponse.json({ userId: result.userId, created: result.created, invitation: result.invitation });
  setSessionCookie(response, result.sessionToken, result.expiresAt);
  return response;
}

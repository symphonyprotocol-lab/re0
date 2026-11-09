import { NextResponse, type NextRequest } from 'next/server';
import { appBaseUrl } from '@/lib/http/cookies';
import { fail, json } from '@/lib/http/respond';
import { apiUser, currentUser, sameOrigin, setHandshakeCookie } from '@/lib/http/session';
import { githubRepositoryAccess } from '@/lib/infra/identity/github';
import { beginGithubConnect, CONNECTIONS_PATH, connectReturnPath, disconnectGithub, githubConnectionFor } from '@/lib/services/connections';

type Context = { params: Promise<{ provider: string }> };

/** Only GitHub has a repository grant (2.2); the dynamic segment is shared with sign-in. */
async function isGithub(context: Context): Promise<boolean> {
  return (await context.params).provider === 'github';
}

function connectCallbackUrl(): string {
  return `${appBaseUrl()}/api/auth/github/callback/connect`;
}

/** The connection, without its token. */
export async function GET(request: NextRequest, context: Context) {
  if (!(await isGithub(context))) return fail('not_found', 404);
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  return json({ connection: await githubConnectionFor(user.id), repositoryAccess: githubRepositoryAccess() });
}

/** "连接 GitHub": the settings form posts here; we answer with GitHub's consent screen. */
export async function POST(request: NextRequest, context: Context) {
  if (!(await isGithub(context))) return fail('not_found', 404);
  if (!sameOrigin(request.headers)) return new NextResponse('cross-origin request refused', { status: 403 });
  const back = (path: string) => NextResponse.redirect(new URL(path, appBaseUrl()), 303);
  const user = await currentUser();
  if (!user) return back(`/login?returnTo=${encodeURIComponent(CONNECTIONS_PATH)}`);
  const form = await request.formData().catch(() => null);
  try {
    const started = await beginGithubConnect({ returnTo: form?.get('returnTo') ?? CONNECTIONS_PATH, redirectUri: connectCallbackUrl() });
    const response = NextResponse.redirect(started.redirectUrl, 303);
    setHandshakeCookie(response, started.handshake, started.expiresAt);
    return response;
  } catch (error) {
    console.warn(`github connect start failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return back(connectReturnPath(CONNECTIONS_PATH, 'failed'));
  }
}

/** "断开连接": the token is deleted and repository refreshes stop. Imported knowledge stays. */
export async function DELETE(request: NextRequest, context: Context) {
  if (!(await isGithub(context))) return fail('not_found', 404);
  const user = await apiUser(request);
  if (user instanceof Response) return user;
  await disconnectGithub(user.id);
  return json({ connection: null });
}

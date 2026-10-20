/**
 * The owner's preview of their website widget, from the dashboard.
 * requirement.md 9.4.
 *
 * The widget page is served only to parents on the key's allowlist, which
 * the browser enforces through frame-ancestors -- and the dashboard's own
 * origin is never on that list. A preview is the one parent admitted by
 * something other than the list: the request must carry a dashboard session
 * whose workspace owns the key. That keeps the gate exactly as strong for a
 * visitor (a public key still opens nothing outside the allowlist) while the
 * owner sees the widget as their visitors will, including questions, which
 * are answered and metered as a visitor's would be. A preview is not an
 * integrated site, so it leaves no origin mark.
 *
 * The session is read off the request's cookies rather than `next/headers`
 * so the two embed routes stay plain functions of their request, as their
 * tests call them.
 */
import type { NextRequest } from 'next/server';
import { resolveSession } from '@/lib/application/auth';
import { normaliseOrigin } from '@/lib/domain/site-key';
import { configuredBaseUrl } from './base-url';
import { SESSION_COOKIE_NAMES } from './cookie-names';

/** Whether `parent` is this deployment itself -- the configured base URL or the one the request arrived on. */
export function isPreviewParent(parent: string | null | undefined, request: NextRequest): boolean {
  const normalised = parent ? normaliseOrigin(parent) : null;
  if (!normalised) return false;
  const configured = configuredBaseUrl();
  const own = [configured ? normaliseOrigin(configured) : null, new URL(request.url).origin.toLowerCase()];
  return own.includes(normalised);
}

/** Whether the request's dashboard session belongs to `workspaceId`. */
export async function isPreviewOwner(request: NextRequest, workspaceId: string): Promise<boolean> {
  const token = SESSION_COOKIE_NAMES.map((name) => request.cookies.get(name)?.value).find(Boolean);
  if (!token) return false;
  try {
    const session = await resolveSession(token);
    return session?.workspace.id === workspaceId;
  } catch {
    return false;
  }
}

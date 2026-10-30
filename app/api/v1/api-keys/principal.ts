/**
 * Who may manage keys over REST. requirement.md 9.2 lists the key endpoints
 * beside the retrieval ones, but a key that can mint keys is the reserved
 * management scope (requirement.md 5.2) -- so the usual caller here is the
 * signed-in browser, and a Bearer key only when it carries that scope.
 *
 * A session on a mutating verb must be same-origin: the cookie is SameSite
 * Lax, which already keeps it off a cross-site POST, and the check here is
 * the second lock on the same door.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { requireScope, resolveApiKey, resolveSession } from '@/lib/application/auth';
import type { WorkspaceRole } from '@/lib/application/assets';
import { API_KEY_MANAGEMENT_SCOPE } from '@/lib/domain/api-key';
import { isSameOriginHeaders, SESSION_COOKIE } from '@/lib/http/session';

export interface KeyManager {
  workspaceId: string;
  role: WorkspaceRole;
}

export async function keyManager(request: NextRequest): Promise<KeyManager> {
  const principal = await resolveApiKey(request.headers.get('authorization'));
  if (principal) {
    requireScope(principal, API_KEY_MANAGEMENT_SCOPE);
    /* Keys are the owner's (requirement.md 3.3); a key that may manage them acts as one. */
    return { workspaceId: principal.workspaceId, role: 'owner' };
  }

  const session = await resolveSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) throw new AppError('invalid_api_key', 'an API key or a session is required');
  if (request.method !== 'GET' && !isSameOriginHeaders((name) => request.headers.get(name))) {
    throw new AppError('access_denied', 'cross-origin key management is refused');
  }
  return { workspaceId: session.workspace.id, role: session.workspace.role };
}

/** The body as JSON, or `invalid_request`; an empty body reads as `{}`. */
export async function jsonBody(request: NextRequest): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  throw new AppError('invalid_request', 'the body must be a JSON object');
}

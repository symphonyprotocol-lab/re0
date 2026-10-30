/**
 * Who is claiming, for the REST claim routes.
 *
 * A claim belongs to a workspace, so both credentials the product issues are
 * accepted: an API key (the integration path) or the web session (so the
 * claim page's fetches and a signed-in browser get the same envelope). A
 * session-backed mutation is additionally same-origin checked; an API key
 * carries no cookie and needs no such guard.
 *
 * The GitHub method needs a user, not just a workspace, because its check is
 * against the account's own consent (7.3.2); an API key has none, so that
 * method's verification is only reachable from the web flow.
 */
import type { NextRequest } from 'next/server';
import { AppError } from '@/contracts/errors';
import { resolveApiKey } from '@/lib/application/auth';
import type { WorkspaceRole } from '@/lib/application/assets';
import { currentSession, isSameOrigin } from '@/lib/http/session';

export interface ClaimPrincipal {
  workspaceId: string;
  userId: string | null;
  /**
   * The role the claim use cases check. Opening or verifying a claim binds a
   * asset's management and its share of the revenue pool to the workspace
   * (requirement.md 7.3.4), so REST asks for the same authority the dashboard
   * does rather than accepting any member.
   */
  role: WorkspaceRole;
}

export async function claimPrincipal(
  request: NextRequest,
  options: { mutation: boolean },
): Promise<ClaimPrincipal> {
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const key = await resolveApiKey(authorization);
    if (!key) throw new AppError('invalid_api_key', 'the API key was not accepted');
    /*
     * A key is not a member and carries no role of its own; it is a
     * workspace-level credential, mintable only by a member who may manage
     * keys, and it acts for the workspace rather than for a seat in it.
     */
    return { workspaceId: key.workspaceId, userId: null, role: 'owner' };
  }

  const session = await currentSession();
  if (!session) throw new AppError('invalid_api_key', 'an API key or a signed-in session is required');
  if (options.mutation && !(await isSameOrigin())) {
    throw new AppError('access_denied', 'cross-origin request refused');
  }
  return {
    workspaceId: session.workspace.id,
    userId: session.user.id,
    role: session.workspace.role,
  };
}

/**
 * The GitHub permission check's consent hop. requirement.md 7.3.2, architecture.md 5.4.
 *
 * Login never keeps a provider token (identity/github.ts), so the repository
 * permission read needs one of its own. The claimant is sent to GitHub with
 * the identity scopes only -- no write scope, no private source -- and the
 * token that comes back is used for one repository read inside `verifyClaim`
 * and then dropped. The consent is revocable on GitHub at any time.
 *
 * The round trip reuses the login handshake cookie and callback URL (the
 * OAuth app has one registered redirect), marked with a purpose so the
 * callback can tell a grant from a login and never mint a session for it.
 */
import { AppError } from '@/contracts/errors';
import { AuthFailure } from '@/lib/domain/auth';
import { seal, unseal } from '@/lib/infrastructure/crypto/sealed';
import { randomToken, timingSafeEqual } from '@/lib/infrastructure/crypto/tokens';
import { authorizeUrl, exchangeForGrant } from '@/lib/infrastructure/identity/github';
import { handshakeExpiry, type Handshake } from '@/lib/application/auth/handshake';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { loadClaim, notFound, workspaceRoleOf } from './shared';
import { verifyClaim, type VerifyClaimResult } from './verify';

const PURPOSE = 'claim_grant';

interface GrantHandshake extends Handshake {
  purpose: typeof PURPOSE;
  claimId: string;
}

function isGrantHandshake(value: unknown): value is GrantHandshake {
  if (typeof value !== 'object' || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    h.purpose === PURPOSE &&
    h.provider === 'github' &&
    typeof h.state === 'string' &&
    typeof h.claimId === 'string' &&
    typeof h.expiresAt === 'number' &&
    typeof h.returnTo === 'string'
  );
}

export function claimPagePath(claimId: string): string {
  return `/assets/claim?claim=${encodeURIComponent(claimId)}`;
}

export interface BeginGithubGrantInput {
  claimId: string;
  workspaceId: string;
  /** Same authority as verifying: the hop exists only to finish a check. */
  role: WorkspaceRole;
  redirectUri: string;
  now?: Date;
}

export interface BeginGithubGrantResult {
  redirectUrl: string;
  handshake: string;
  expiresAt: number;
}

export async function beginGithubGrant(input: BeginGithubGrantInput): Promise<BeginGithubGrantResult> {
  if (!canManageLibraries(input.role)) {
    throw new AppError('access_denied', 'only an owner or admin may verify a claim');
  }
  const claim = await loadClaim(input.claimId);
  if (!claim || claim.claimantWorkspaceId !== input.workspaceId) throw notFound();
  if (claim.method !== 'github_permission' || claim.status !== 'pending') {
    throw new AppError('invalid_request', 'this claim does not take a GitHub grant');
  }

  const handshake: GrantHandshake = {
    purpose: PURPOSE,
    provider: 'github',
    state: randomToken(),
    nonce: randomToken(),
    codeVerifier: randomToken(),
    returnTo: claimPagePath(claim.id),
    expiresAt: handshakeExpiry(input.now ?? new Date()),
    claimId: claim.id,
  };

  return {
    redirectUrl: authorizeUrl({ state: handshake.state, redirectUri: input.redirectUri }),
    handshake: await seal(handshake),
    expiresAt: handshake.expiresAt,
  };
}

/** The claim a sealed handshake cookie is for, or null when it is a login. */
export async function peekGrantHandshake(
  sealedHandshake: string | null | undefined,
): Promise<{ claimId: string; returnTo: string } | null> {
  const value = await unseal<unknown>(sealedHandshake);
  return isGrantHandshake(value) ? { claimId: value.claimId, returnTo: value.returnTo } : null;
}

export interface CompleteGithubGrantInput {
  code: string | null;
  state: string | null;
  sealedHandshake: string | null | undefined;
  redirectUri: string;
  /** The signed-in claimant; a grant with no session is refused. */
  userId: string;
  workspaceId: string;
  now?: Date;
}

/**
 * Finishes the hop and runs the check in one go, so the token's whole life
 * is this call. Handshake faults are `AuthFailure`s like a login's; the
 * check's own outcome is `verifyClaim`'s.
 */
export async function completeGithubGrant(
  input: CompleteGithubGrantInput,
): Promise<VerifyClaimResult> {
  const now = input.now ?? new Date();
  const handshake = await unseal<unknown>(input.sealedHandshake);
  if (!isGrantHandshake(handshake)) {
    throw new AuthFailure('oauth_failed', 'missing or unreadable grant handshake');
  }
  if (handshake.expiresAt <= now.getTime()) {
    throw new AuthFailure('oauth_failed', 'grant handshake expired');
  }
  if (!input.state || !timingSafeEqual(input.state, handshake.state)) {
    throw new AuthFailure('oauth_failed', 'state mismatch');
  }
  if (!input.code) throw new AuthFailure('oauth_failed', 'no authorization code');

  /*
   * The role is read here rather than passed in: the OAuth callback carries a
   * session but not the membership behind it, and a role can change between
   * the hop starting and coming back. `beginGithubGrant` checked it too --
   * this is the check that decides.
   */
  const role = await workspaceRoleOf(input.workspaceId, input.userId);
  if (!role || !canManageLibraries(role)) {
    throw new AppError('access_denied', 'only an owner or admin may verify a claim');
  }

  const grant = await exchangeForGrant({ code: input.code, redirectUri: input.redirectUri });
  return verifyClaim({
    claimId: handshake.claimId,
    workspaceId: input.workspaceId,
    role,
    grant: { token: grant.token, subject: grant.subject, userId: input.userId },
    now,
  });
}

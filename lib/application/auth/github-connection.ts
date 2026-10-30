/**
 * Use cases: connect a GitHub account for repository imports, list what it
 * may import, and prove a chosen repository is importable at submit time.
 *
 * Login never keeps the provider token (requirement.md 12). Importing a
 * repository needs one anyway -- not to read the content, which is public,
 * but to establish *whose* repositories are being offered: the wizard lists
 * only what the token's account owns, and `checkGithubImport` re-reads the
 * chosen repository with the same token and compares its owner id with the
 * account's (lib/domain/github.ts). So the grant is its own consent, sealed
 * at rest in its own table, and gone the moment the person disconnects or
 * GitHub reports the token revoked.
 */
import { eq } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { AuthFailure, OAUTH_STATE_TTL_MS, safeReturnTo } from '@/lib/domain/auth';
import {
  grantScopeCovers,
  importableRepositories,
  importRefusal,
  isGithubConnectHandshake,
  type GithubConnectHandshake,
  type GithubConnectOutcome,
  type ImportRefusal,
} from '@/lib/domain/github';
import { uuidv7 } from '@/lib/domain/id';
import { seal, unseal } from '@/lib/infrastructure/crypto/sealed';
import { randomToken, timingSafeEqual } from '@/lib/infrastructure/crypto/tokens';
import {
  connectAuthorizeUrl,
  exchangeForRepositoryGrant,
  GithubGrantRevoked,
  listOwnedPublicRepositories,
  readRepository,
  type GithubRepository,
  type RepositoryGrant,
} from '@/lib/infrastructure/identity/github';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export type { GithubRepository };

/** Seam for tests; production always talks to GitHub. */
export interface GithubRepositoryReader {
  listOwnedPublicRepositories(token: string): Promise<GithubRepository[]>;
  readRepository(token: string, location: string): Promise<GithubRepository | null>;
}

const githubReader: GithubRepositoryReader = { listOwnedPublicRepositories, readRepository };

/* ------------------------------------------------------------- connecting */

export interface BeginGithubConnectInput {
  returnTo: unknown;
  /** `${APP_BASE_URL}/api/auth/github/callback/connect`, built by the caller. */
  redirectUri: string;
  now?: Date;
}

export interface BeginGithubConnectResult {
  redirectUrl: string;
  /** Sealed handshake, to be written as a short-lived cookie. */
  handshake: string;
  expiresAt: number;
}

export async function beginGithubConnect(
  input: BeginGithubConnectInput,
): Promise<BeginGithubConnectResult> {
  const now = input.now ?? new Date();
  const handshake: GithubConnectHandshake = {
    purpose: 'github_connect',
    state: randomToken(),
    returnTo: safeReturnTo(input.returnTo),
    expiresAt: now.getTime() + OAUTH_STATE_TTL_MS,
  };
  return {
    redirectUrl: connectAuthorizeUrl({ state: handshake.state, redirectUri: input.redirectUri }),
    handshake: await seal(handshake),
    expiresAt: handshake.expiresAt,
  };
}

export interface CompleteGithubConnectInput {
  /** The signed-in account the grant is stored under. */
  userId: string;
  code: string | null;
  state: string | null;
  sealedHandshake: string | null | undefined;
  redirectUri: string;
  now?: Date;
  /** Seam for tests; production always exchanges with GitHub. */
  exchange?: (input: { code: string; redirectUri: string }) => Promise<RepositoryGrant>;
}

export interface CompleteGithubConnectResult {
  login: string;
  returnTo: string;
}

/**
 * Verifies the handshake, exchanges the code and stores the sealed grant.
 * A second connection for the same account replaces the first: the old token
 * is not kept alongside, so a revoked-and-reconnected account has exactly one
 * live credential on file.
 */
export async function completeGithubConnect(
  input: CompleteGithubConnectInput,
): Promise<CompleteGithubConnectResult> {
  const now = input.now ?? new Date();
  const handshake = await unseal<unknown>(input.sealedHandshake);
  if (!isGithubConnectHandshake(handshake)) {
    throw new AuthFailure('oauth_failed', 'missing or unreadable connect handshake');
  }
  if (handshake.expiresAt <= now.getTime()) {
    throw new AuthFailure('oauth_failed', 'connect handshake expired');
  }
  if (!input.state || !timingSafeEqual(handshake.state, input.state)) {
    throw new AuthFailure('oauth_failed', 'connect state mismatch');
  }
  if (!input.code) {
    throw new AuthFailure('oauth_failed', 'connect callback carried no code');
  }

  const exchange = input.exchange ?? exchangeForRepositoryGrant;
  const grant = await exchange({ code: input.code, redirectUri: input.redirectUri });
  const tokenSealed = await seal(grant.accessToken);

  await db()
    .insert(schema.githubConnection)
    .values({
      id: uuidv7(now.getTime()),
      userId: input.userId,
      githubUserId: grant.githubUserId,
      login: grant.login,
      tokenSealed,
      scope: grant.scope,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.githubConnection.userId,
      set: {
        githubUserId: grant.githubUserId,
        login: grant.login,
        tokenSealed,
        scope: grant.scope,
        updatedAt: now,
      },
    });

  return { login: grant.login, returnTo: handshake.returnTo };
}

/** The return path with the outcome on it, for the wizard to read. */
export function connectReturnPath(returnTo: string, outcome: GithubConnectOutcome): string {
  const url = new URL(safeReturnTo(returnTo), 'http://placeholder.invalid');
  url.searchParams.set('github', outcome);
  return `${url.pathname}${url.search}`;
}

export async function disconnectGithub(userId: string): Promise<void> {
  await db().delete(schema.githubConnection).where(eq(schema.githubConnection.userId, userId));
}

/* ---------------------------------------------------------------- reading */

export interface GithubConnectionView {
  login: string;
  githubUserId: string;
  connectedAt: Date;
}

/** The connection without its token: what a page may show. */
export async function githubConnectionFor(userId: string): Promise<GithubConnectionView | null> {
  const [row] = await db()
    .select({
      login: schema.githubConnection.login,
      githubUserId: schema.githubConnection.githubUserId,
      connectedAt: schema.githubConnection.updatedAt,
    })
    .from(schema.githubConnection)
    .where(eq(schema.githubConnection.userId, userId))
    .limit(1);
  return row ?? null;
}

interface Grant {
  token: string;
  githubUserId: string;
  login: string;
}

async function grantFor(userId: string): Promise<Grant | null> {
  const [row] = await db()
    .select({
      tokenSealed: schema.githubConnection.tokenSealed,
      githubUserId: schema.githubConnection.githubUserId,
      login: schema.githubConnection.login,
      scope: schema.githubConnection.scope,
    })
    .from(schema.githubConnection)
    .where(eq(schema.githubConnection.userId, userId))
    .limit(1);
  if (!row) return null;
  /* An older grant with fewer scopes: keep the row, but ask again. */
  if (!grantScopeCovers(row.scope)) return null;
  const token = await unseal<string>(row.tokenSealed);
  /* Unreadable means the signing secret rotated; the grant is as good as gone. */
  if (typeof token !== 'string') {
    await disconnectGithub(userId);
    return null;
  }
  return { token, githubUserId: row.githubUserId, login: row.login };
}

export type ImportableRepositories =
  | { connected: false }
  | { connected: true; login: string; repositories: GithubRepository[] };

/**
 * What the wizard offers: public, non-fork repositories the account owns or
 * administers in an organisation.
 * A token GitHub no longer honours drops the connection, so the wizard asks
 * for a fresh one instead of showing a list that submit would then refuse.
 */
export async function listImportableRepositories(
  userId: string,
  reader: GithubRepositoryReader = githubReader,
): Promise<ImportableRepositories> {
  const grant = await grantFor(userId);
  if (!grant) return { connected: false };
  try {
    const owned = await reader.listOwnedPublicRepositories(grant.token);
    return {
      connected: true,
      login: grant.login,
      repositories: importableRepositories(owned, grant.githubUserId),
    };
  } catch (error) {
    if (error instanceof GithubGrantRevoked) {
      await disconnectGithub(userId);
      return { connected: false };
    }
    throw error;
  }
}

/* ------------------------------------------------------------ submitting */

export type GithubImportRefusalCode = 'not_connected' | 'not_found' | ImportRefusal;

/**
 * A repository the account may not import. Carries the refusal so the wizard
 * can say which rule was hit; the `reason` on the base class keeps the public
 * contract's vocabulary for REST callers.
 */
export class GithubImportRefused extends AppError {
  constructor(readonly refusal: GithubImportRefusalCode) {
    super(
      'claim_verification_failed',
      `github import refused: ${refusal}`,
      refusal === 'not_connected'
        ? 'account_not_linked'
        : refusal === 'not_found'
          ? 'source_mismatch'
          : 'insufficient_permission',
    );
    this.name = 'GithubImportRefused';
  }
}

export interface GithubImportCheck {
  /** `owner/name` as GitHub spells it, which the asset id is taken from. */
  location: string;
  repositoryId: number;
}

export type CheckGithubImport = (input: {
  userId: string;
  location: string;
}) => Promise<GithubImportCheck>;

/**
 * Re-reads the chosen repository with the account's own token and applies
 * the import rule. The list the wizard showed is not trusted: a form post
 * can name any repository, and the wizard's list may be minutes old.
 */
export async function checkGithubImport(
  input: { userId: string; location: string },
  reader: GithubRepositoryReader = githubReader,
): Promise<GithubImportCheck> {
  const grant = await grantFor(input.userId);
  if (!grant) throw new GithubImportRefused('not_connected');

  let repository: GithubRepository | null;
  try {
    repository = await reader.readRepository(grant.token, input.location);
  } catch (error) {
    if (error instanceof GithubGrantRevoked) {
      await disconnectGithub(input.userId);
      throw new GithubImportRefused('not_connected');
    }
    throw error;
  }
  if (!repository) throw new GithubImportRefused('not_found');

  const refusal = importRefusal(repository, grant.githubUserId);
  if (refusal) throw new GithubImportRefused(refusal);
  return { location: repository.fullName, repositoryId: repository.id };
}

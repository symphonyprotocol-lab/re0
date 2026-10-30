/**
 * Importing a GitHub repository into a workspace library: the rules, as pure
 * functions. No fetch, no Next.js, no driver.
 *
 * A workspace may only import repositories the signed-in person controls on
 * GitHub, and only those that are public and not forks. Two reasons, both
 * from requirement.md 7.3 and architecture.md 5.4: the library's owner is
 * decided by control of the source, and a fork or a stranger's repository
 * would let anyone publish -- and earn from -- documentation that is not
 * theirs. "Controls" means one of two things: the repository sits under the
 * person's own account (compared by GitHub account id, never the login
 * string: logins are renamed and reused, ids are not), or it sits under an
 * organisation where GitHub reports them as admin or maintainer -- the same
 * bar requirement.md 7.3 sets for a claim. Plain membership or push access
 * is not control: a contributor may not publish the organisation's docs.
 */

/** What the platform reads from a repository record before importing it. */
export interface RepositoryFacts {
  /** GitHub's numeric repository id, stable across renames and transfers. */
  id: number;
  /** `owner/name` as GitHub spells it. */
  fullName: string;
  /** The numeric account id of the owner, user or organisation. */
  ownerId: number;
  private: boolean;
  fork: boolean;
  archived: boolean;
  /** The token's account's own permission on it, as GitHub reports it. */
  permission: RepositoryPermission;
}

export type RepositoryPermission = 'admin' | 'maintain' | 'write' | 'read' | 'none';

/** Enough control to publish the repository's documentation (requirement.md 7.3). */
export const CONTROLLING_PERMISSIONS: readonly RepositoryPermission[] = ['admin', 'maintain'];

export const IMPORT_REFUSALS = ['not_owner', 'private', 'fork'] as const;
export type ImportRefusal = (typeof IMPORT_REFUSALS)[number];

/**
 * Why a repository cannot be imported by the account whose GitHub id is
 * `accountId`, or null when it can.
 *
 * Control is checked first: a stranger's private fork is refused as "not
 * yours", which is the answer that gives away least about the repository
 * (architecture.md 5.4, response minimisation). An archived repository is
 * still importable; the connector marks its content stale instead.
 */
export function importRefusal(repository: RepositoryFacts, accountId: string): ImportRefusal | null {
  if (!controlsRepository(repository, accountId)) return 'not_owner';
  if (repository.private) return 'private';
  if (repository.fork) return 'fork';
  return null;
}

/** Own account, or admin/maintain in an organisation. */
export function controlsRepository(repository: RepositoryFacts, accountId: string): boolean {
  if (String(repository.ownerId) === accountId) return true;
  return CONTROLLING_PERMISSIONS.includes(repository.permission);
}

export function isImportable(repository: RepositoryFacts, accountId: string): boolean {
  return importRefusal(repository, accountId) === null;
}

/**
 * The repositories the wizard may offer, from everything the account owns.
 * Same rule as `importRefusal`, applied as a filter, so the list and the
 * server-side check at submit time can never disagree.
 */
export function importableRepositories<T extends RepositoryFacts>(
  repositories: readonly T[],
  accountId: string,
): T[] {
  return repositories.filter((repository) => isImportable(repository, accountId));
}

/**
 * Scope asked for when a person connects their GitHub account for imports.
 *
 * Deliberately no `repo` or `public_repo`: those grant write access, which
 * requirement.md 7.3 forbids asking for, and a public repository's tree is
 * readable without any scope. What the grant buys is not access to the
 * content but proof of *whose* repositories are being listed -- the token is
 * the account's own, so the owner id GitHub reports on each repository can be
 * compared against the account the token belongs to. `read:org` is what
 * makes organisation membership visible to the app at all: without it
 * `affiliation=organization_member` lists nothing, and the consent screen
 * offers no organisation grant.
 */
export const GITHUB_CONNECT_SCOPES = ['read:user', 'read:org'] as const;
export const GITHUB_CONNECT_SCOPE = GITHUB_CONNECT_SCOPES.join(' ');

/**
 * Whether a stored grant carries every scope the current flow needs. A grant
 * taken before a scope was added is treated as not connected, so the person
 * is sent through consent again -- which GitHub does show for a changed
 * scope -- rather than shown a list that is quietly missing half of it.
 */
export function grantScopeCovers(scope: string): boolean {
  const held = new Set(scope.split(/[\s,]+/).filter(Boolean));
  return GITHUB_CONNECT_SCOPES.every((required) => held.has(required));
}

/** Where the connect flow lands when nothing better is known: the wizard. */
export const GITHUB_CONNECT_RETURN_TO = '/dashboard/assets/new';

/** The in-flight connect handshake, sealed in its own short-lived cookie. */
export interface GithubConnectHandshake {
  purpose: 'github_connect';
  state: string;
  /** Where to land afterwards; an in-app path, validated by the caller. */
  returnTo: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export function isGithubConnectHandshake(value: unknown): value is GithubConnectHandshake {
  if (typeof value !== 'object' || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    h.purpose === 'github_connect' &&
    typeof h.state === 'string' &&
    typeof h.returnTo === 'string' &&
    typeof h.expiresAt === 'number'
  );
}

/**
 * Outcomes the connect callback can land on, appended to the return path as
 * `?github=` so the wizard can say what happened. Coarse on purpose: the
 * provider's own message and the state comparison stay in the server log.
 */
export const GITHUB_CONNECT_OUTCOMES = ['connected', 'canceled', 'failed'] as const;
export type GithubConnectOutcome = (typeof GITHUB_CONNECT_OUTCOMES)[number];

export function isGithubConnectOutcome(value: unknown): value is GithubConnectOutcome {
  return (
    typeof value === 'string' && (GITHUB_CONNECT_OUTCOMES as readonly string[]).includes(value)
  );
}

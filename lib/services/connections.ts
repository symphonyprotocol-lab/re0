/**
 * "连接与域名" (rebuild-proposal.md 2.2): a user's GitHub grant for
 * repositories, and the domains they proved are theirs for website crawls.
 *
 * The GitHub connect flow is the old `github-connection.ts`: a sealed
 * handshake cookie carries `state`, the callback exchanges the code, and the
 * token is sealed at rest. One connection per user; reconnecting replaces
 * it, disconnecting deletes it, after which repositories stop
 * refreshing.
 *
 * A domain claim is created with its challenge and checked on demand, by
 * DNS TXT and by the well-known file -- either one passing verifies it. One
 * verification serves every Ree of the user.
 */
import { and, asc, eq } from 'drizzle-orm';
import { OAUTH_STATE_TTL_MS } from '@/lib/constants';
import { AuthFailure, safeReturnTo } from '@/lib/domain/auth';
import { challengeValue, domainCovers, normalizeDomain } from '@/lib/domain/sources';
import { openCredential, sealCredential } from '@/lib/infra/crypto/credentials';
import { seal, unseal } from '@/lib/infra/crypto/sealed';
import { randomHex, randomToken, timingSafeEqual } from '@/lib/infra/crypto/tokens';
import { db, schema } from '@/lib/infra/db';
import { connectAuthorizeUrl, exchangeForRepositoryGrant, type RepositoryGrant } from '@/lib/infra/identity/github';
import { challengeChecks, type ChallengeChecks } from '@/lib/infra/verification/challenge';

/* ------------------------------------------------------------------ GitHub */

interface ConnectHandshake {
  purpose: 'github_connect';
  state: string;
  returnTo: string;
  expiresAt: number;
}

export const CONNECTIONS_PATH = '/settings?tab=connections';

export async function beginGithubConnect(input: { returnTo: unknown; redirectUri: string; now?: Date }) {
  const now = input.now ?? new Date();
  const returnTo = typeof input.returnTo === 'string' && input.returnTo ? safeReturnTo(input.returnTo) : CONNECTIONS_PATH;
  const handshake: ConnectHandshake = { purpose: 'github_connect', state: randomToken(), returnTo, expiresAt: now.getTime() + OAUTH_STATE_TTL_MS };
  return {
    redirectUrl: connectAuthorizeUrl({ state: handshake.state, redirectUri: input.redirectUri }),
    handshake: await seal('github-connect', handshake),
    expiresAt: handshake.expiresAt,
  };
}

export async function completeGithubConnect(input: {
  userId: string;
  code: string | null;
  state: string | null;
  sealedHandshake: string | null | undefined;
  redirectUri: string;
  now?: Date;
  exchange?: (input: { code: string; redirectUri: string }) => Promise<RepositoryGrant>;
}): Promise<{ login: string; returnTo: string }> {
  const now = input.now ?? new Date();
  const handshake = await unseal<ConnectHandshake>('github-connect', input.sealedHandshake, (payload) => (payload as { purpose?: unknown } | null)?.purpose === 'github_connect');
  if (!handshake || handshake.purpose !== 'github_connect' || typeof handshake.state !== 'string') {
    throw new AuthFailure('oauth_failed', 'missing or unreadable connect handshake');
  }
  if (handshake.expiresAt <= now.getTime()) throw new AuthFailure('oauth_failed', 'connect handshake expired');
  if (!input.state || !timingSafeEqual(handshake.state, input.state)) throw new AuthFailure('oauth_failed', 'connect state mismatch');
  if (!input.code) throw new AuthFailure('oauth_failed', 'connect callback carried no code');
  const grant = await (input.exchange ?? exchangeForRepositoryGrant)({ code: input.code, redirectUri: input.redirectUri });
  await saveGithubConnection(input.userId, grant, now);
  return { login: grant.login, returnTo: handshake.returnTo };
}

export async function saveGithubConnection(userId: string, grant: RepositoryGrant, now = new Date()): Promise<void> {
  const encryptedToken = await sealCredential(grant.accessToken, 'github');
  await db()
    .insert(schema.githubConnection)
    .values({ userId, githubLogin: grant.login, encryptedToken, scope: grant.scope, connectedAt: now })
    .onConflictDoUpdate({
      target: schema.githubConnection.userId,
      set: { githubLogin: grant.login, encryptedToken, scope: grant.scope, connectedAt: now },
    });
}

/** The return path with `?github=connected|canceled|failed` on it, for the page to say what happened. */
export function connectReturnPath(returnTo: string, outcome: 'connected' | 'canceled' | 'failed'): string {
  const url = new URL(safeReturnTo(returnTo), 'http://placeholder.invalid');
  url.searchParams.set('github', outcome);
  return `${url.pathname}${url.search}`;
}

export async function disconnectGithub(userId: string): Promise<void> {
  await db().delete(schema.githubConnection).where(eq(schema.githubConnection.userId, userId));
}

export async function githubConnectionFor(userId: string): Promise<{ login: string; connectedAt: Date; scope: string } | null> {
  const [row] = await db()
    .select({ login: schema.githubConnection.githubLogin, connectedAt: schema.githubConnection.connectedAt, scope: schema.githubConnection.scope })
    .from(schema.githubConnection)
    .where(eq(schema.githubConnection.userId, userId))
    .limit(1);
  return row ?? null;
}

/** The user's token, or null when not connected (or sealed under a key since rotated, which drops it). */
export async function githubTokenFor(userId: string): Promise<string | null> {
  const [row] = await db()
    .select({ encryptedToken: schema.githubConnection.encryptedToken })
    .from(schema.githubConnection)
    .where(eq(schema.githubConnection.userId, userId))
    .limit(1);
  if (!row) return null;
  const token = await openCredential(row.encryptedToken, 'github');
  if (!token) await disconnectGithub(userId);
  return token;
}

/* ----------------------------------------------------------------- domains */

export class DomainError extends Error {
  constructor(readonly code: 'invalid_domain' | 'domain_exists' | 'not_found') {
    super(code);
    this.name = 'DomainError';
  }
}

export interface DomainView {
  id: string;
  domain: string;
  status: 'pending' | 'verified' | 'failed';
  method: 'dns_txt' | 'well_known' | null;
  challenge: string;
  verifiedAt: Date | null;
  checkedAt: Date | null;
  createdAt: Date;
}

const domainColumns = {
  id: schema.domainClaim.id,
  domain: schema.domainClaim.domain,
  status: schema.domainClaim.status,
  method: schema.domainClaim.method,
  challenge: schema.domainClaim.challenge,
  verifiedAt: schema.domainClaim.verifiedAt,
  checkedAt: schema.domainClaim.checkedAt,
  createdAt: schema.domainClaim.createdAt,
};

export async function listDomains(userId: string): Promise<DomainView[]> {
  return db().select(domainColumns).from(schema.domainClaim).where(eq(schema.domainClaim.userId, userId)).orderBy(asc(schema.domainClaim.createdAt));
}

/**
 * Adds a domain to verify, or returns the pending claim already there (the
 * prototype reopens the wizard for it). A verified domain is not added twice.
 */
export async function addDomain(userId: string, raw: unknown): Promise<DomainView> {
  const domain = normalizeDomain(raw);
  if (!domain) throw new DomainError('invalid_domain');
  const [existing] = await db()
    .select(domainColumns)
    .from(schema.domainClaim)
    .where(and(eq(schema.domainClaim.userId, userId), eq(schema.domainClaim.domain, domain)))
    .limit(1);
  if (existing) {
    if (existing.status === 'verified') throw new DomainError('domain_exists');
    return existing;
  }
  const [row] = await db()
    .insert(schema.domainClaim)
    .values({ userId, domain, challenge: challengeValue(randomHex(16)) })
    .onConflictDoNothing()
    .returning(domainColumns);
  if (row) return row;
  /* Lost a race with a second tab: return the row that won. */
  const [winner] = await db()
    .select(domainColumns)
    .from(schema.domainClaim)
    .where(and(eq(schema.domainClaim.userId, userId), eq(schema.domainClaim.domain, domain)))
    .limit(1);
  return winner!;
}

export async function removeDomain(userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const rows = await db()
    .delete(schema.domainClaim)
    .where(and(eq(schema.domainClaim.id, id), eq(schema.domainClaim.userId, userId)))
    .returning({ id: schema.domainClaim.id });
  return rows.length > 0;
}

/**
 * Runs both checks; either one matching verifies the claim. The method asked
 * for runs first, so its answer comes back even when the other is slow. A
 * failure keeps the claim open for another try ("继续验证").
 */
export async function verifyDomain(
  userId: string,
  id: string,
  preferred: 'dns_txt' | 'well_known' = 'dns_txt',
  checks: ChallengeChecks = challengeChecks,
  now = new Date(),
): Promise<{ domain: DomainView; outcome: 'verified' | 'not_found' | 'unreachable' }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new DomainError('not_found');
  const [claim] = await db()
    .select(domainColumns)
    .from(schema.domainClaim)
    .where(and(eq(schema.domainClaim.id, id), eq(schema.domainClaim.userId, userId)))
    .limit(1);
  if (!claim) throw new DomainError('not_found');
  if (claim.status === 'verified') return { domain: claim, outcome: 'verified' };

  const order: ('dns_txt' | 'well_known')[] = preferred === 'well_known' ? ['well_known', 'dns_txt'] : ['dns_txt', 'well_known'];
  let unreachable = false;
  let matched: 'dns_txt' | 'well_known' | null = null;
  for (const method of order) {
    const outcome = method === 'dns_txt' ? await checks.dns(claim.domain, claim.challenge) : await checks.wellKnown(claim.domain, claim.challenge);
    if (outcome === 'matched') {
      matched = method;
      break;
    }
    if (outcome === 'unreachable') unreachable = true;
  }
  const [row] = await db()
    .update(schema.domainClaim)
    .set(matched ? { status: 'verified', method: matched, verifiedAt: now, checkedAt: now } : { status: 'failed', checkedAt: now })
    .where(eq(schema.domainClaim.id, claim.id))
    .returning(domainColumns);
  return { domain: row!, outcome: matched ? 'verified' : unreachable ? 'unreachable' : 'not_found' };
}

/** Whether the user has verified a domain that covers `hostname` (2.2). */
export async function hasVerifiedDomainFor(userId: string, hostname: string): Promise<boolean> {
  const rows = await db()
    .select({ domain: schema.domainClaim.domain })
    .from(schema.domainClaim)
    .where(and(eq(schema.domainClaim.userId, userId), eq(schema.domainClaim.status, 'verified')));
  return rows.some((row) => domainCovers(row.domain, hostname));
}

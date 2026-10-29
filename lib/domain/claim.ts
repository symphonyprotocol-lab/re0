/**
 * Ownership claim rules, as pure functions. requirement.md 7.3, architecture.md 5.4.
 *
 * No Next.js, no driver, no fetch. What lives here is the part of the claim
 * flow a test can pin without a database: which methods a source admits, how
 * a challenge is addressed, how a claim moves between states, and what each
 * failure code asks the user to do next.
 */
import type { ClaimFailureReason } from '@/contracts/errors';
import type { ClaimMethod, ClaimStatus, SourceType } from '@/lib/domain';
import { claimMethodsFor } from '@/lib/domain';

/** A challenge is valid for seven days, then it is void and never reusable. 7.3.2. */
export const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Consecutive failed verifications before the claim locks. 7.3.7: past the
 * threshold the entry is closed for that account and library until a person
 * looks at it -- a revoked or expired claim is the way out, not another retry.
 */
export const CLAIM_ATTEMPT_LIMIT = 5;

/** The DNS label the TXT record sits under. */
export const CHALLENGE_DNS_LABEL = '_re0-challenge';

/** Where the well-known file is served from. */
export const CHALLENGE_WELL_KNOWN_PATH = '/.well-known/re0-challenge/';

export function claimExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + CLAIM_TTL_MS);
}

export function isClaimExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** Whole days left on a challenge, never negative; `0` on its last day. */
export function remainingDays(expiresAt: Date, now: Date): number {
  const left = expiresAt.getTime() - now.getTime();
  if (left <= 0) return 0;
  return Math.ceil(left / (24 * 60 * 60 * 1000));
}

/**
 * Whether a claim still holds the entry shut for its claimant and library.
 *
 * A claim that failed by exhausting its attempts locks until the challenge it
 * carried would have expired; an administrator revoking it opens the entry
 * sooner. A claim dismissed by ruling has not exhausted anything and locks
 * nothing.
 */
export function isClaimLocked(
  claim: { status: ClaimStatus; attempts: number; expiresAt: Date },
  now: Date,
): boolean {
  return (
    claim.status === 'failed' &&
    claim.attempts >= CLAIM_ATTEMPT_LIMIT &&
    !isClaimExpired(claim.expiresAt, now)
  );
}

/**
 * The default method per source type: the one 7.3.2 marks in bold. It is the
 * first entry `claimMethodsFor` lists, and this states that rather than
 * relying on array order at every call site.
 */
export function defaultClaimMethod(type: SourceType): ClaimMethod | null {
  return claimMethodsFor(type)[0] ?? null;
}

export function isClaimMethod(value: unknown): value is ClaimMethod {
  return value === 'github_permission' || value === 'dns_txt' || value === 'well_known';
}

/* ------------------------------------------------------------------ domain */

/** A hostname as DNS accepts it: labels of letters, digits and hyphens, dotted. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isVerifiableHostname(value: string): boolean {
  return HOSTNAME.test(value);
}

/**
 * The domain a source is verified against.
 *
 * A website source is a URL, and its host is the domain -- 7.3.2 gives it
 * the DNS TXT / well-known challenge. A GitHub source has no domain of its
 * own: 7.3.2 falls back to the repository's
 * *home* domain, which only the repository can say, so the caller supplies it
 * (from the repository's `homepage`) and this validates it like any other.
 * Subdomains are not folded into their parent -- 7.3.2 says a parent's
 * verification does not flow down, and the reverse would be stranger still.
 */
export function verificationDomain(input: {
  sourceType: SourceType;
  location: string;
  homepage?: string | null;
}): string | null {
  let candidate: string | null = null;
  if (input.sourceType === 'github') {
    candidate = hostOf(input.homepage);
  } else if (input.sourceType === 'website') {
    candidate = hostOf(input.location);
  }
  if (!candidate) return null;
  const host = candidate.toLowerCase().replace(/^www\./, '');
  return isVerifiableHostname(host) ? host : null;
}

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

export function dnsRecordName(domain: string): string {
  return `${CHALLENGE_DNS_LABEL}.${domain}`;
}

/**
 * The well-known address is keyed by the claim id, not the token. Only the
 * token's hash is stored (architecture.md 5.4), so a path that carried the
 * token could never be rebuilt after creation; the id addresses the file and
 * the token is what the file must contain, which is what the hash compares.
 */
export function wellKnownUrl(domain: string, claimId: string): string {
  return `https://${domain}${CHALLENGE_WELL_KNOWN_PATH}${claimId}`;
}

/** `owner/repository`, lower-cased, so two spellings of one repository agree. */
export function repositoryKey(location: string): string {
  /* Trailing slashes come off first: a clone URL ends `.git/`, and stripping
     the suffix before the slash would leave `.git` on the key. */
  return location.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
}

/** The permission levels GitHub reports that count as control. 7.3.2. */
export function hasRepositoryControl(permissions: {
  admin?: boolean;
  maintain?: boolean;
} | null | undefined): boolean {
  return Boolean(permissions?.admin || permissions?.maintain);
}

/* --------------------------------------------------------------- transitions */

export type ClaimEvent =
  | 'verify_ok'
  | 'verify_failed'
  | 'expire'
  | 'revoke'
  | 'grant'
  | 'dismiss'
  | 'release';

/**
 * Where a claim goes on an event, or null when the event is not allowed from
 * that state. 7.3.3: only `pending` moves; the four other states are terminal
 * for the self-service flow. `revoke` is the one administrative move that
 * also applies to a `verified` claim -- and to a `failed` one, where it is how
 * a locked entry is reopened after review (7.3.7). `release` is the owner
 * giving up.
 */
export function nextClaimStatus(
  status: ClaimStatus,
  event: ClaimEvent,
  context: { attempts: number },
): ClaimStatus | null {
  switch (status) {
    case 'pending':
      switch (event) {
        case 'verify_ok':
        case 'grant':
          return 'verified';
        case 'verify_failed':
          return context.attempts >= CLAIM_ATTEMPT_LIMIT ? 'failed' : 'pending';
        case 'expire':
          return 'expired';
        case 'dismiss':
          return 'failed';
        case 'revoke':
          return 'revoked';
        default:
          return null;
      }
    case 'verified':
      return event === 'revoke' || event === 'release' ? 'revoked' : null;
    case 'failed':
      return event === 'revoke' ? 'revoked' : null;
    default:
      return null;
  }
}

export function isTerminalClaimStatus(status: ClaimStatus): boolean {
  return status !== 'pending';
}

/**
 * Whether a claim is a dispute. requirement.md 7.3.5: a claim on a library
 * that *someone else* already owns leaves the self-service flow and waits for
 * an administrator.
 *
 * One definition, because three screens and one use case ask the question and
 * a Grant control the ruling then refuses is worse than no control at all.
 * The claimant's own library is not a dispute with itself, and neither is an
 * unowned one; and a claim that is no longer `pending` has already been
 * settled, so it is not waiting on anybody.
 */
export function isDisputedClaim(input: {
  status: ClaimStatus;
  ownerWorkspaceId: string | null;
  claimantWorkspaceId: string;
}): boolean {
  return (
    input.status === 'pending' &&
    input.ownerWorkspaceId !== null &&
    input.ownerWorkspaceId !== input.claimantWorkspaceId
  );
}

/**
 * Whether ownership can be given up. requirement.md 7.3.5 gives the owner the
 * right to abandon a *claimed* library: it goes back to the unowned pool and
 * somebody else may prove control of the same source.
 *
 * A library whose creator is its owner by construction -- an upload, a
 * Notion connection -- has no claim to release. Releasing one
 * would strand it: `owner_workspace_id` is the tenancy key for manage,
 * rebuild, delete and detail, and `claimMethodsFor` offers those source types
 * no way back in, so the library would stay public, live and unmanageable by
 * anyone.
 */
export function isReleasableOwnership(kind: OwnershipView['kind']): boolean {
  return kind === 'claimed';
}

/* ----------------------------------------------------------------- checks */

export type ClaimCheckKey =
  | 'account_linked'
  | 'repository_match'
  | 'permission'
  | 'domain_match'
  | 'dns_record'
  | 'well_known_file'
  | 'no_conflict';

/**
 * The checks each method runs, in the order they run. The last one is the
 * conflict check every method shares: control of the source is necessary,
 * an unowned library is what makes it sufficient.
 */
export function checksForMethod(method: ClaimMethod): readonly ClaimCheckKey[] {
  switch (method) {
    case 'github_permission':
      return ['account_linked', 'repository_match', 'permission', 'no_conflict'];
    case 'dns_txt':
      return ['domain_match', 'dns_record', 'no_conflict'];
    case 'well_known':
      return ['domain_match', 'well_known_file', 'no_conflict'];
  }
}

/** The check a failure code is reported against. */
export function checkFailedBy(reason: ClaimFailureReason): ClaimCheckKey | null {
  switch (reason) {
    case 'account_not_linked':
      return 'account_linked';
    case 'insufficient_permission':
      return 'permission';
    case 'source_mismatch':
      return 'domain_match';
    case 'challenge_not_found':
    case 'challenge_expired':
      return null;
    case 'already_claimed':
    case 'claim_in_progress':
      return 'no_conflict';
    case 'retry_limit_exceeded':
      return null;
  }
}

export interface ClaimCheckView {
  key: ClaimCheckKey;
  state: 'ok' | 'pending' | 'failed';
}

/**
 * The check list as a status and a failure code render it: everything before
 * the failed check passed, the failed one failed, the rest never ran. A
 * verified claim passed all of them; an untouched pending claim ran none.
 */
export function checkStates(input: {
  method: ClaimMethod;
  status: ClaimStatus;
  failureReason: ClaimFailureReason | null;
  attempted: boolean;
}): ClaimCheckView[] {
  const keys = checksForMethod(input.method);
  if (input.status === 'verified') return keys.map((key) => ({ key, state: 'ok' }));
  if (!input.attempted || !input.failureReason) {
    return keys.map((key) => ({ key, state: 'pending' }));
  }
  const failed = checkFailedBy(input.failureReason);
  const failedAt = failed ? keys.indexOf(failed) : -1;
  return keys.map((key, index) => ({
    key,
    state:
      failedAt === -1
        ? index === keys.length - 1
          ? 'failed'
          : 'ok'
        : index < failedAt
          ? 'ok'
          : index === failedAt
            ? 'failed'
            : 'pending',
  }));
}

/* --------------------------------------------------------- user-facing view */

/**
 * What a library's ownership looks like to one workspace. requirement.md 5.2
 * asks the dashboard to show exactly these four, and a fifth for the case the
 * schema makes common: a library the workspace owns because it created it.
 */
export type OwnershipView =
  | { kind: 'claimed'; claimedAt: Date | null; ownerName: string | null }
  | { kind: 'owned' }
  | { kind: 'pending'; claimId: string; expiresAt: Date; attempts: number; failureReason: ClaimFailureReason | null }
  | { kind: 'failed'; claimId: string; failureReason: ClaimFailureReason }
  | { kind: 'unclaimed' };

export interface OwnershipFacts {
  ownerWorkspaceId: string | null;
  ownerName: string | null;
  /** The newest claim by *this* workspace on the library, if any. */
  claim: {
    id: string;
    status: ClaimStatus;
    failureReason: ClaimFailureReason | null;
    attempts: number;
    expiresAt: Date;
    verifiedAt: Date | null;
  } | null;
}

export function ownershipView(facts: OwnershipFacts, workspaceId: string): OwnershipView {
  if (facts.ownerWorkspaceId === workspaceId) {
    return facts.claim?.status === 'verified'
      ? { kind: 'claimed', claimedAt: facts.claim.verifiedAt, ownerName: facts.ownerName }
      : { kind: 'owned' };
  }
  if (facts.claim?.status === 'pending') {
    return {
      kind: 'pending',
      claimId: facts.claim.id,
      expiresAt: facts.claim.expiresAt,
      attempts: facts.claim.attempts,
      failureReason: facts.claim.failureReason,
    };
  }
  if (facts.claim?.status === 'failed' && facts.claim.failureReason) {
    return { kind: 'failed', claimId: facts.claim.id, failureReason: facts.claim.failureReason };
  }
  if (facts.ownerWorkspaceId) {
    return { kind: 'claimed', claimedAt: null, ownerName: facts.ownerName };
  }
  return { kind: 'unclaimed' };
}

export function isClaimFailureReason(value: unknown): value is ClaimFailureReason {
  return (
    value === 'insufficient_permission' ||
    value === 'account_not_linked' ||
    value === 'source_mismatch' ||
    value === 'challenge_not_found' ||
    value === 'challenge_expired' ||
    value === 'already_claimed' ||
    value === 'claim_in_progress' ||
    value === 'retry_limit_exceeded'
  );
}

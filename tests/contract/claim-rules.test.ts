/**
 * The claim rules a database cannot answer for. requirement.md 7.3.
 *
 * Everything here is pure: which methods a source type admits, how a claim
 * moves between states, and which check a 7.3.8 failure code is reported
 * against. These are the parts a screen and a use case both depend on, so
 * they are pinned once rather than restated in each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimFailureReason } from '@/contracts/errors';
import {
  CLAIMABLE_SOURCE_TYPES,
  claimMethodsFor,
  requiresClaim,
  SELF_OWNED_SOURCE_TYPES,
} from '@/lib/domain';
import type { ClaimMethod, ClaimStatus, SourceType } from '@/lib/domain';
import {
  CLAIM_ATTEMPT_LIMIT,
  CLAIM_TTL_MS,
  checkFailedBy,
  checkStates,
  checksForMethod,
  claimExpiryFrom,
  defaultClaimMethod,
  dnsRecordName,
  isClaimExpired,
  isClaimFailureReason,
  isClaimLocked,
  isClaimMethod,
  isDisputedClaim,
  isReleasableOwnership,
  isTerminalClaimStatus,
  nextClaimStatus,
  ownershipView,
  remainingDays,
  repositoryKey,
  hasRepositoryControl,
  verificationDomain,
  wellKnownUrl,
} from '@/lib/domain/claim';
import { AuthFailure } from '@/lib/domain/auth';
import { publicRepositoryHomepage, repositoryGrant } from '@/lib/infrastructure/identity/github';
import { assertWithinClaimLimits } from '@/lib/application/claims/shared';
import { canManageLibraries, type WorkspaceRole } from '@/lib/application/libraries/delete';
import { startClaim } from '@/lib/application/claims/start';
import { verifyClaim } from '@/lib/application/claims/verify';

/*
 * The claim limiters are the one place this file reaches past the domain: the
 * rule under test is the *order* of two counters, which only the caller can
 * show. Everything the limiter itself does is somebody else's test.
 */
const spent: string[] = [];
const denied = new Set<string>();

vi.mock('@/lib/infrastructure/cache/strict-rate-limit', () => ({
  strictRateLimit: async (key: string) => {
    spent.push(key);
    return { allowed: !denied.has(key), remaining: 0, resetAt: 0 };
  },
}));

const now = new Date('2026-09-08T12:00:00.000Z');

const REASONS: readonly ClaimFailureReason[] = [
  'insufficient_permission',
  'account_not_linked',
  'source_mismatch',
  'challenge_not_found',
  'challenge_expired',
  'already_claimed',
  'claim_in_progress',
  'retry_limit_exceeded',
];

const STATUSES: readonly ClaimStatus[] = ['pending', 'verified', 'failed', 'expired', 'revoked'];

/* ------------------------------------------------ method availability 7.3.2 */

describe('method availability per source type', () => {
  it('gives a GitHub source all three methods, permission first', () => {
    expect(claimMethodsFor('github')).toEqual(['github_permission', 'dns_txt', 'well_known']);
    expect(defaultClaimMethod('github')).toBe('github_permission');
  });

  it('gives a website source the two domain methods, DNS first', () => {
    expect(claimMethodsFor('website')).toEqual(['dns_txt', 'well_known']);
    expect(defaultClaimMethod('website')).toBe('dns_txt');
  });

  it('gives the self-owned source types no method at all', () => {
    for (const type of SELF_OWNED_SOURCE_TYPES) {
      expect(claimMethodsFor(type)).toEqual([]);
      expect(defaultClaimMethod(type)).toBeNull();
      expect(requiresClaim(type)).toBe(false);
    }
  });

  it('never offers the GitHub method to a source that is not a repository', () => {
    for (const type of ['website', 'markdown', 'pdf', 'notion'] as SourceType[]) {
      expect(claimMethodsFor(type)).not.toContain('github_permission');
    }
  });

  it('recognises exactly the three methods', () => {
    for (const method of ['github_permission', 'dns_txt', 'well_known']) {
      expect(isClaimMethod(method)).toBe(true);
    }
    expect(isClaimMethod('re0_json')).toBe(false);
    expect(isClaimMethod(null)).toBe(false);
  });
});

/* --------------------------------------------------------- transitions 7.3.3 */

describe('claim status transitions', () => {
  const attempts = { attempts: 0 };

  it('verifies a pending claim that passes, or that a ruling grants', () => {
    expect(nextClaimStatus('pending', 'verify_ok', attempts)).toBe('verified');
    expect(nextClaimStatus('pending', 'grant', attempts)).toBe('verified');
  });

  it('keeps a failed check pending until the attempt limit is reached', () => {
    for (let attempt = 1; attempt < CLAIM_ATTEMPT_LIMIT; attempt += 1) {
      expect(nextClaimStatus('pending', 'verify_failed', { attempts: attempt })).toBe('pending');
    }
    expect(nextClaimStatus('pending', 'verify_failed', { attempts: CLAIM_ATTEMPT_LIMIT })).toBe(
      'failed',
    );
    expect(nextClaimStatus('pending', 'verify_failed', { attempts: CLAIM_ATTEMPT_LIMIT + 3 })).toBe(
      'failed',
    );
  });

  it('expires, dismisses and revokes a pending claim', () => {
    expect(nextClaimStatus('pending', 'expire', attempts)).toBe('expired');
    expect(nextClaimStatus('pending', 'dismiss', attempts)).toBe('failed');
    expect(nextClaimStatus('pending', 'revoke', attempts)).toBe('revoked');
  });

  it('lets a verified claim only be revoked or released', () => {
    expect(nextClaimStatus('verified', 'revoke', attempts)).toBe('revoked');
    expect(nextClaimStatus('verified', 'release', attempts)).toBe('revoked');
    for (const event of ['verify_ok', 'verify_failed', 'expire', 'grant', 'dismiss'] as const) {
      expect(nextClaimStatus('verified', event, attempts)).toBeNull();
    }
  });

  it('reopens a failed claim only by revoking it', () => {
    expect(nextClaimStatus('failed', 'revoke', attempts)).toBe('revoked');
    for (const event of ['verify_ok', 'verify_failed', 'grant', 'dismiss', 'release'] as const) {
      expect(nextClaimStatus('failed', event, attempts)).toBeNull();
    }
  });

  it('moves nothing out of expired or revoked', () => {
    for (const status of ['expired', 'revoked'] as ClaimStatus[]) {
      for (const event of [
        'verify_ok',
        'verify_failed',
        'expire',
        'revoke',
        'grant',
        'dismiss',
        'release',
      ] as const) {
        expect(nextClaimStatus(status, event, attempts)).toBeNull();
      }
    }
  });

  it('treats every state but pending as terminal', () => {
    for (const status of STATUSES) {
      expect(isTerminalClaimStatus(status)).toBe(status !== 'pending');
    }
  });

  it('never lets a ruling grant ownership from a state other than pending', () => {
    for (const status of STATUSES.filter((value) => value !== 'pending')) {
      expect(nextClaimStatus(status, 'grant', attempts)).not.toBe('verified');
    }
  });
});

/* -------------------------------------------------------------- validity 7.3.2 */

describe('challenge validity', () => {
  it('is seven days from creation', () => {
    expect(CLAIM_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(claimExpiryFrom(now).toISOString()).toBe('2026-09-15T12:00:00.000Z');
  });

  it('counts whole days left and never goes negative', () => {
    expect(remainingDays(claimExpiryFrom(now), now)).toBe(7);
    expect(remainingDays(new Date(now.getTime() + 36 * 60 * 60 * 1000), now)).toBe(2);
    expect(remainingDays(new Date(now.getTime() + 60_000), now)).toBe(1);
    expect(remainingDays(now, now)).toBe(0);
    expect(remainingDays(new Date(now.getTime() - 86_400_000), now)).toBe(0);
  });

  it('is expired at its instant, not after it', () => {
    expect(isClaimExpired(now, now)).toBe(true);
    expect(isClaimExpired(new Date(now.getTime() + 1), now)).toBe(false);
  });

  it('locks the entry only while an exhausted claim is still inside its window', () => {
    const live = new Date(now.getTime() + 86_400_000);
    const gone = new Date(now.getTime() - 1);
    expect(isClaimLocked({ status: 'failed', attempts: CLAIM_ATTEMPT_LIMIT, expiresAt: live }, now)).toBe(true);
    expect(isClaimLocked({ status: 'failed', attempts: CLAIM_ATTEMPT_LIMIT, expiresAt: gone }, now)).toBe(false);
    /* A claim dismissed by a ruling has exhausted nothing and locks nothing. */
    expect(isClaimLocked({ status: 'failed', attempts: 1, expiresAt: live }, now)).toBe(false);
    expect(isClaimLocked({ status: 'revoked', attempts: 9, expiresAt: live }, now)).toBe(false);
  });
});

/* ------------------------------------------------------ failure codes 7.3.8 */

describe('failure codes', () => {
  it('recognises exactly the eight codes', () => {
    for (const reason of REASONS) expect(isClaimFailureReason(reason)).toBe(true);
    expect(isClaimFailureReason('dns_lookup_failed')).toBe(false);
    expect(isClaimFailureReason(undefined)).toBe(false);
  });

  it('reports a code against a check the method actually runs, or none', () => {
    for (const reason of REASONS) {
      const key = checkFailedBy(reason);
      if (key === null) continue;
      const methods = (['github_permission', 'dns_txt', 'well_known'] as ClaimMethod[]).filter(
        (method) => checksForMethod(method).includes(key),
      );
      expect(methods.length).toBeGreaterThan(0);
    }
  });

  it('maps the three source-control codes onto their own checks', () => {
    expect(checkFailedBy('account_not_linked')).toBe('account_linked');
    expect(checkFailedBy('insufficient_permission')).toBe('permission');
    expect(checkFailedBy('source_mismatch')).toBe('domain_match');
  });

  it('maps both conflict codes onto the shared conflict check', () => {
    expect(checkFailedBy('already_claimed')).toBe('no_conflict');
    expect(checkFailedBy('claim_in_progress')).toBe('no_conflict');
  });

  it('attaches the challenge and retry codes to no check', () => {
    expect(checkFailedBy('challenge_not_found')).toBeNull();
    expect(checkFailedBy('challenge_expired')).toBeNull();
    expect(checkFailedBy('retry_limit_exceeded')).toBeNull();
  });
});

/* ----------------------------------------------------------------- checks */

describe('check lists', () => {
  it('ends every method with the shared conflict check', () => {
    for (const method of ['github_permission', 'dns_txt', 'well_known'] as ClaimMethod[]) {
      expect(checksForMethod(method).at(-1)).toBe('no_conflict');
    }
  });

  it('runs the repository checks only for the GitHub method', () => {
    expect(checksForMethod('github_permission')).toEqual([
      'account_linked',
      'repository_match',
      'permission',
      'no_conflict',
    ]);
    expect(checksForMethod('dns_txt')).toEqual(['domain_match', 'dns_record', 'no_conflict']);
    expect(checksForMethod('well_known')).toEqual(['domain_match', 'well_known_file', 'no_conflict']);
  });

  it('marks every check passed on a verified claim', () => {
    const states = checkStates({
      method: 'dns_txt',
      status: 'verified',
      failureReason: null,
      attempted: true,
    });
    expect(states.every((check) => check.state === 'ok')).toBe(true);
  });

  it('leaves every check unrun on a claim nobody has verified yet', () => {
    const states = checkStates({
      method: 'well_known',
      status: 'pending',
      failureReason: null,
      attempted: false,
    });
    expect(states.every((check) => check.state === 'pending')).toBe(true);
  });

  it('stops the list at the check that failed', () => {
    const states = checkStates({
      method: 'github_permission',
      status: 'pending',
      failureReason: 'insufficient_permission',
      attempted: true,
    });
    expect(states).toEqual([
      { key: 'account_linked', state: 'ok' },
      { key: 'repository_match', state: 'ok' },
      { key: 'permission', state: 'failed' },
      { key: 'no_conflict', state: 'pending' },
    ]);
  });

  it('fails the last check for a code that names none', () => {
    const states = checkStates({
      method: 'dns_txt',
      status: 'pending',
      failureReason: 'challenge_not_found',
      attempted: true,
    });
    expect(states.at(-1)).toEqual({ key: 'no_conflict', state: 'failed' });
    expect(states.slice(0, -1).every((check) => check.state === 'ok')).toBe(true);
  });
});

/* ------------------------------------------------------- verification target */

describe('verification target', () => {
  it('takes a website source at its own host, without www', () => {
    expect(
      verificationDomain({ sourceType: 'website', location: 'https://www.Example.com/docs' }),
    ).toBe('example.com');
    expect(
      verificationDomain({ sourceType: 'website', location: 'https://docs.example.com/guide' }),
    ).toBe('docs.example.com');
  });

  it('takes a GitHub source at its declared home domain, never its repository host', () => {
    expect(
      verificationDomain({
        sourceType: 'github',
        location: 'acme/widgets',
        homepage: 'https://acme.dev/',
      }),
    ).toBe('acme.dev');
    expect(verificationDomain({ sourceType: 'github', location: 'acme/widgets' })).toBeNull();
  });

  it('refuses a source type with no claim flow, and a location that is not a URL', () => {
    expect(verificationDomain({ sourceType: 'pdf', location: 'https://example.com/a.pdf' })).toBeNull();
    expect(verificationDomain({ sourceType: 'website', location: 'not a url' })).toBeNull();
    expect(verificationDomain({ sourceType: 'website', location: 'ftp://example.com' })).toBeNull();
  });

  it('addresses the challenge under the fixed label and the claim id', () => {
    expect(dnsRecordName('example.com')).toBe('_re0-challenge.example.com');
    expect(wellKnownUrl('example.com', 'c-1')).toBe(
      'https://example.com/.well-known/re0-challenge/c-1',
    );
  });

  it('folds two spellings of one repository together', () => {
    expect(repositoryKey('  Acme/Widgets.git/ ')).toBe('acme/widgets');
  });

  it('counts only admin or maintain as control of a repository', () => {
    expect(hasRepositoryControl({ admin: true })).toBe(true);
    expect(hasRepositoryControl({ maintain: true })).toBe(true);
    expect(hasRepositoryControl({ admin: false, maintain: false })).toBe(false);
    expect(hasRepositoryControl(null)).toBe(false);
  });
});

/* -------------------------------------------------------------- ownership 5.2 */

describe('ownership as one workspace sees it', () => {
  const workspace = 'w-1';
  const base = { ownerWorkspaceId: null, ownerName: null, claim: null };
  const claim = {
    id: 'c-1',
    status: 'pending' as ClaimStatus,
    failureReason: null as ClaimFailureReason | null,
    attempts: 0,
    expiresAt: claimExpiryFrom(now),
    verifiedAt: null as Date | null,
  };

  it('is unclaimed with no owner and no claim', () => {
    expect(ownershipView(base, workspace)).toEqual({ kind: 'unclaimed' });
  });

  it('is claimed by us, with the date, when a verified claim made us the owner', () => {
    const verifiedAt = new Date('2026-09-01T00:00:00.000Z');
    expect(
      ownershipView(
        {
          ownerWorkspaceId: workspace,
          ownerName: 'Acme',
          claim: { ...claim, status: 'verified', verifiedAt },
        },
        workspace,
      ),
    ).toEqual({ kind: 'claimed', claimedAt: verifiedAt, ownerName: 'Acme' });
  });

  it('is owned by creation when we own it without a verified claim', () => {
    expect(
      ownershipView({ ownerWorkspaceId: workspace, ownerName: 'Acme', claim: null }, workspace),
    ).toEqual({ kind: 'owned' });
  });

  it('is pending while our claim is open, carrying its window and attempts', () => {
    expect(ownershipView({ ...base, claim }, workspace)).toEqual({
      kind: 'pending',
      claimId: 'c-1',
      expiresAt: claim.expiresAt,
      attempts: 0,
      failureReason: null,
    });
  });

  it('is failed with the reason once our claim is closed by one', () => {
    expect(
      ownershipView(
        { ...base, claim: { ...claim, status: 'failed', failureReason: 'source_mismatch' } },
        workspace,
      ),
    ).toEqual({ kind: 'failed', claimId: 'c-1', failureReason: 'source_mismatch' });
  });

  it('shows another workspace as the owner, without a claim date we cannot see', () => {
    expect(
      ownershipView({ ownerWorkspaceId: 'w-2', ownerName: 'Other', claim: null }, workspace),
    ).toEqual({ kind: 'claimed', claimedAt: null, ownerName: 'Other' });
  });

  it('keeps our pending claim visible even where another workspace owns the library', () => {
    expect(
      ownershipView({ ownerWorkspaceId: 'w-2', ownerName: 'Other', claim }, workspace).kind,
    ).toBe('pending');
  });
});

/* ------------------------------------------------------- claimable sources */

describe('which sources a claim may name', () => {
  /*
   * `visibleLibrary` filters the claim page's target by this list, so it has
   * to agree with `claimMethodsFor` exactly. When it does not, a pdf or a
   * Notion library reaches a claim form with no method to pick and a Start
   * button that can only fail.
   */
  it('is exactly the set of source types that have a method', () => {
    const withMethods = (
      ['github', 'website', 'markdown', 'pdf', 'notion'] as SourceType[]
    ).filter((type) => claimMethodsFor(type).length > 0);
    expect([...CLAIMABLE_SOURCE_TYPES].sort()).toEqual(withMethods.sort());
  });

  it('never overlaps the self-owned source types', () => {
    for (const type of SELF_OWNED_SOURCE_TYPES) {
      expect(CLAIMABLE_SOURCE_TYPES).not.toContain(type);
      expect(requiresClaim(type)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------- disputes 7.3.5 */

describe('what counts as a dispute', () => {
  /*
   * One definition, because the console list, the console detail, the
   * dashboard and `ruleDispute` all ask. The console once omitted the
   * "another owner" half and offered a Grant control that the ruling refused.
   */
  it('is a pending claim on a library another workspace owns', () => {
    expect(
      isDisputedClaim({ status: 'pending', ownerWorkspaceId: 'w-2', claimantWorkspaceId: 'w-1' }),
    ).toBe(true);
  });

  it('is not a claim by the workspace that already owns the library', () => {
    expect(
      isDisputedClaim({ status: 'pending', ownerWorkspaceId: 'w-1', claimantWorkspaceId: 'w-1' }),
    ).toBe(false);
  });

  it('is not a claim on an unowned library', () => {
    expect(
      isDisputedClaim({ status: 'pending', ownerWorkspaceId: null, claimantWorkspaceId: 'w-1' }),
    ).toBe(false);
  });

  it('is over once the claim leaves pending, whoever owns the library', () => {
    for (const status of STATUSES.filter((value) => value !== 'pending')) {
      expect(
        isDisputedClaim({ status, ownerWorkspaceId: 'w-2', claimantWorkspaceId: 'w-1' }),
      ).toBe(false);
    }
  });

  it('agrees with the ruling: only a dispute may be ruled on', () => {
    /* `ruleDispute` refuses anything this rejects, and grants from pending only. */
    expect(nextClaimStatus('pending', 'grant', { attempts: 0 })).toBe('verified');
    expect(
      isDisputedClaim({ status: 'verified', ownerWorkspaceId: 'w-2', claimantWorkspaceId: 'w-1' }),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------- release 7.3.5 */

describe('which ownership can be given up', () => {
  /*
   * 7.3.5 is about a *claimed* library going back to the unowned pool.
   * Releasing a library whose creator is its owner would strand it: the owner
   * column is the tenancy key for manage, rebuild, delete and detail, and an
   * upload or a Notion source has no claim method to get back in with.
   */
  it('is claimed ownership only', () => {
    expect(isReleasableOwnership('claimed')).toBe(true);
  });

  it('is not ownership by creation, nor any state that is not ownership', () => {
    for (const kind of ['owned', 'pending', 'failed', 'unclaimed'] as const) {
      expect(isReleasableOwnership(kind)).toBe(false);
    }
  });

  it('leaves no way back for the source types release must refuse', () => {
    /* Why the rule exists: these have no claim flow to re-acquire ownership. */
    for (const type of SELF_OWNED_SOURCE_TYPES) {
      expect(claimMethodsFor(type)).toEqual([]);
    }
  });

  it('does release a library the workspace owns through a verified claim', () => {
    const verifiedAt = new Date('2026-09-01T00:00:00.000Z');
    const view = ownershipView(
      {
        ownerWorkspaceId: 'w-1',
        ownerName: 'Acme',
        claim: {
          id: 'c-1',
          status: 'verified',
          failureReason: null,
          attempts: 1,
          expiresAt: claimExpiryFrom(now),
          verifiedAt,
        },
      },
      'w-1',
    );
    expect(isReleasableOwnership(view.kind)).toBe(true);
    expect(nextClaimStatus('verified', 'release', { attempts: 1 })).toBe('revoked');
  });

  it('does not release a library the workspace owns because it created it', () => {
    const view = ownershipView(
      { ownerWorkspaceId: 'w-1', ownerName: 'Acme', claim: null },
      'w-1',
    );
    expect(view.kind).toBe('owned');
    expect(isReleasableOwnership(view.kind)).toBe(false);
  });
});

/* ------------------------------------------------- a dispute that passed its checks */

describe('checks on a claim that proved control of a contested library', () => {
  /*
   * Verification of a disputed claim leaves `status = 'pending'` -- 7.3.3
   * fixes the five values and none of them says "waiting on a ruling" -- and
   * records `already_claimed`, the conflict check's own code. Leaving the
   * reason null made `checkStates` render every check as "not run" on a claim
   * that had just passed all of them.
   */
  const disputed = (method: ClaimMethod) =>
    checkStates({ method, status: 'pending', failureReason: 'already_claimed', attempted: true });

  it('shows the control checks passed and the conflict check as the one blocking', () => {
    for (const method of ['github_permission', 'dns_txt', 'well_known'] as ClaimMethod[]) {
      const states = disputed(method);
      const last = states[states.length - 1]!;
      expect(last.key).toBe('no_conflict');
      expect(last.state).toBe('failed');
      expect(states.slice(0, -1).every((check) => check.state === 'ok')).toBe(true);
    }
  });

  it('never renders such a claim as untouched', () => {
    /* What the null reason produced before: every check "pending". */
    const unrun = checkStates({
      method: 'dns_txt',
      status: 'pending',
      failureReason: null,
      attempted: true,
    });
    expect(unrun.every((check) => check.state === 'pending')).toBe(true);
    expect(disputed('dns_txt')).not.toEqual(unrun);
  });

  it('reports the code against the conflict check, as 7.3.8 pairs them', () => {
    expect(checkFailedBy('already_claimed')).toBe('no_conflict');
  });
});

/* --------------------------------------------- transient provider faults 7.3.7 */

/*
 * Not pure, but the rule it pins is: a failed *check* costs an attempt and
 * five of them lock the entry for the rest of the challenge's seven days.
 * GitHub not answering is not a failed check, so it must not reach the code
 * path that counts one. The two are told apart by status, which is the only
 * place that decision is made.
 */
describe('a GitHub answer versus GitHub not answering', () => {
  const realFetch = globalThis.fetch;
  let status = 200;
  let body: unknown = {};

  beforeEach(() => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const grant = () => repositoryGrant('token', 'acme/widgets');

  it('answers null for a repository the token cannot see', async () => {
    status = 404;
    body = { message: 'Not Found' };
    await expect(grant()).resolves.toBeNull();
  });

  it('raises rather than answers on a secondary rate limit', async () => {
    status = 403;
    body = { message: 'You have exceeded a secondary rate limit' };
    await expect(grant()).rejects.toBeInstanceOf(AuthFailure);
    await expect(grant()).rejects.toMatchObject({ loginError: 'provider_unavailable' });
  });

  it('raises on a server fault, so no attempt is spent on it', async () => {
    for (const code of [500, 502, 503, 429]) {
      status = code;
      body = {};
      await expect(grant()).rejects.toMatchObject({ loginError: 'provider_unavailable' });
    }
  });

  it('never carries GitHub\'s own message out to the caller', async () => {
    status = 403;
    body = { message: 'secret repository detail' };
    await expect(grant()).rejects.toMatchObject({
      message: expect.not.stringContaining('secret repository detail'),
    });
  });

  it('reads a home page, and separates "no repository" from "no answer"', async () => {
    status = 200;
    body = { homepage: 'https://acme.dev' };
    await expect(publicRepositoryHomepage('acme/widgets')).resolves.toBe('https://acme.dev');

    status = 404;
    body = {};
    await expect(publicRepositoryHomepage('acme/widgets')).resolves.toBeNull();

    status = 503;
    body = {};
    await expect(publicRepositoryHomepage('acme/widgets')).rejects.toMatchObject({
      loginError: 'provider_unavailable',
    });
  });

  it('turns a permission answer into control, and only that', async () => {
    status = 200;
    body = { id: 1, full_name: 'Acme/Widgets', homepage: null, permissions: { admin: true } };
    const repository = await grant();
    expect(repositoryKey(repository!.fullName)).toBe('acme/widgets');
    expect(hasRepositoryControl(repository!.permissions)).toBe(true);

    body = { id: 1, full_name: 'Acme/Widgets', homepage: null, permissions: { push: true } };
    expect(hasRepositoryControl((await grant())!.permissions)).toBe(false);
  });
});

/* ------------------------------------------------------- claim limits 7.3.7 */

describe('the two claim limiters', () => {
  beforeEach(() => {
    spent.length = 0;
    denied.clear();
  });

  it('counts the account and the library separately', async () => {
    await assertWithinClaimLimits('start', 'w-1', 'lib-1');
    expect(spent).toEqual([
      'ratelimit:claim-start-account:w-1',
      'ratelimit:claim-start-library:lib-1',
    ]);
  });

  /*
   * The per-library budget is shared with every other claimant. Spending it on
   * behalf of a caller who is already over its own limit lets one account
   * cool down a library for everybody, which is the opposite of what a
   * per-library limit is for.
   */
  it('never spends the shared library budget for a caller already over its own', async () => {
    denied.add('ratelimit:claim-verify-account:w-1');
    await expect(assertWithinClaimLimits('verify', 'w-1', 'lib-1')).rejects.toMatchObject({
      reason: 'retry_limit_exceeded',
    });
    expect(spent).toEqual(['ratelimit:claim-verify-account:w-1']);
  });

  it('still refuses when only the library is over', async () => {
    denied.add('ratelimit:claim-verify-library:lib-1');
    await expect(assertWithinClaimLimits('verify', 'w-1', 'lib-1')).rejects.toMatchObject({
      code: 'rate_limited',
      reason: 'retry_limit_exceeded',
    });
    expect(spent).toHaveLength(2);
  });
});

/* ------------------------------------------------- who may claim, 3.3 and 7.3.4 */

describe('the authority a claim needs', () => {
  /*
   * A claim binds the library's management and its place in the revenue pool
   * to the workspace (7.3.4). That is the same authority releasing it asks
   * for, so the same roles hold it -- and the use case checks, because a
   * server action and a REST route are both public endpoints and the screen
   * that hides the button proves nothing.
   */
  const ROLES: readonly WorkspaceRole[] = ['owner', 'admin', 'developer', 'viewer'];

  it('is manage-libraries, which a developer and a viewer do not hold', () => {
    expect(ROLES.filter(canManageLibraries)).toEqual(['owner', 'admin']);
  });

  it('refuses a viewer opening a claim, before it looks at anything else', async () => {
    /* No database is touched: the role is the first thing either use case reads. */
    for (const role of ['viewer', 'developer'] as WorkspaceRole[]) {
      await expect(
        startClaim({
          workspaceId: 'w-1',
          role,
          libraryPublicId: '/acme/widgets',
          method: 'dns_txt',
        }),
      ).rejects.toMatchObject({ code: 'access_denied' });
    }
  });

  it('refuses a viewer running the check on someone else\'s claim', async () => {
    for (const role of ['viewer', 'developer'] as WorkspaceRole[]) {
      await expect(
        verifyClaim({ claimId: 'c-1', workspaceId: 'w-1', role }),
      ).rejects.toMatchObject({ code: 'access_denied' });
    }
  });
});

/**
 * Proving control of a domain before an asset is fetched from it: the
 * rules, as pure functions. No fetch, no DNS, no Next.js, no driver.
 *
 * A website asset is built from whatever a host serves, so whoever
 * controls that host is the only person who may create
 * the asset (requirement.md 7.3: the question is "do you control this
 * source", never "who are you"). The wizard therefore cannot submit such a
 * asset until one challenge for the source's host has been met, by one of
 * the two methods requirement.md 7.3.2 gives a domain:
 *
 * - a TXT record at `_re0-challenge.<host>` whose value is the challenge;
 * - a file at `https://<host>/.well-known/re0-challenge/<token>` whose body
 *   is the token.
 *
 * The verification is spent at creation. It is not a standing credential
 * (requirement.md 7.3.2: "验证结果只在校验当次有效"): a verified challenge is
 * good for one asset, on the host it named, within a short window.
 */

import type { ClaimFailureReason } from '@/contracts/errors';
import type { SourceType } from './index';

/** The source types whose creation is gated on a verified domain. */
export const DOMAIN_VERIFIED_SOURCE_TYPES = ['website'] as const;

export type DomainVerifiedSourceType = (typeof DOMAIN_VERIFIED_SOURCE_TYPES)[number];

export function requiresDomainVerification(type: SourceType): type is DomainVerifiedSourceType {
  return (DOMAIN_VERIFIED_SOURCE_TYPES as readonly string[]).includes(type);
}

export const DOMAIN_VERIFICATION_METHODS = ['dns_txt', 'well_known'] as const;

export type DomainVerificationMethod = (typeof DOMAIN_VERIFICATION_METHODS)[number];

export function isDomainVerificationMethod(value: unknown): value is DomainVerificationMethod {
  return typeof value === 'string' && (DOMAIN_VERIFICATION_METHODS as readonly string[]).includes(value);
}

/** requirement.md 7.3.2: a challenge lives seven days. */
export const CHALLENGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a *verified* challenge may wait before the asset is created.
 * Long enough to finish the wizard, short enough that a verification is
 * never a credential someone comes back to a month later.
 */
export const VERIFIED_VALID_MS = 60 * 60 * 1000;

/** Checks one challenge may take before it locks (requirement.md 7.3.7). */
export const MAX_CHECK_ATTEMPTS = 10;

/** Challenges one workspace may start in an hour (requirement.md 7.3.7). */
export const MAX_STARTS_PER_HOUR = 10;

/** The DNS label the TXT record sits under, and the prefix its value carries. */
export const DNS_CHALLENGE_LABEL = '_re0-challenge';
export const DNS_VALUE_PREFIX = 're0-verify=';

/** Where the well-known file must be served from. */
export const WELL_KNOWN_PATH = '/.well-known/re0-challenge/';

/**
 * The host a source location is fetched from, in the one spelling a
 * challenge is bound to: lowercase, no trailing dot, no port. Null when the
 * location is not an https URL with a dotted host -- the same shape
 * `normalizeLocation` accepts for these source types, so a location that
 * can be a source always has a host that can be verified.
 */
export function verificationHost(location: string): string | null {
  let url: URL;
  try {
    url = new URL(location.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.startsWith('[')) return null;
  return host;
}

/**
 * Whether a challenge verified for `verifiedHost` covers an asset fetched
 * from `location`. Exact host only: requirement.md 7.3.2 says a subdomain
 * never inherits its parent's verification, and `docs.example.com` and
 * `example.com` are different hosts under different control often enough
 * that the strict reading is the safe one.
 */
export function verificationCovers(verifiedHost: string, location: string): boolean {
  const host = verificationHost(location);
  return host !== null && host === verifiedHost.toLowerCase();
}

export function dnsChallengeName(host: string): string {
  return `${DNS_CHALLENGE_LABEL}.${host}`;
}

export function dnsChallengeValue(token: string): string {
  return `${DNS_VALUE_PREFIX}${token}`;
}

export function wellKnownUrl(host: string, token: string): string {
  return `https://${host}${WELL_KNOWN_PATH}${token}`;
}

/**
 * Whether any TXT record at the challenge name carries this token.
 *
 * A TXT record is a list of character strings; resolvers hand each record
 * back as such a list, and a long value may have been split across them. A
 * record is joined before it is compared, and surrounding quotes -- which
 * some DNS panels store literally -- are stripped. The comparison is exact
 * after that: a record that carries the token plus anything else is not a
 * match, so a provider that appends to the value cannot verify by accident.
 */
export function matchesDnsChallenge(records: readonly (readonly string[])[], token: string): boolean {
  const expected = dnsChallengeValue(token);
  return records.some((record) => {
    const value = record.join('').trim().replace(/^"(.*)"$/s, '$1').trim();
    return value === expected;
  });
}

/**
 * Whether a well-known file's body is this token. Whitespace around it is
 * tolerated (an editor adds a trailing newline); anything else is not.
 */
export function matchesWellKnownBody(body: string, token: string): boolean {
  const trimmed = body.trim();
  return trimmed === token || trimmed === dnsChallengeValue(token);
}

/**
 * The stable reason a domain check can fail with, as the wizard shows it.
 * A subset of the claim reasons (requirement.md 7.3.8): a domain challenge
 * involves no account, no permission level and no competing claimant.
 */
export type DomainVerificationFailure = Extract<
  ClaimFailureReason,
  'challenge_not_found' | 'challenge_expired' | 'retry_limit_exceeded' | 'source_mismatch'
>;

/**
 * What one verified challenge has to satisfy to be spent on an asset, and
 * why it cannot be if it cannot. Pure so the creation use case, the wizard's
 * submit guard and the tests all read the same rule.
 */
export function verificationSpendable(
  verification: {
    status: string;
    host: string;
    verifiedAt: Date | null;
    consumedAssetId: string | null;
  },
  location: string,
  now: Date,
): DomainVerificationFailure | null {
  if (verification.status !== 'verified' || !verification.verifiedAt) return 'challenge_not_found';
  if (verification.consumedAssetId) return 'challenge_not_found';
  if (now.getTime() - verification.verifiedAt.getTime() > VERIFIED_VALID_MS) return 'challenge_expired';
  if (!verificationCovers(verification.host, location)) return 'source_mismatch';
  return null;
}

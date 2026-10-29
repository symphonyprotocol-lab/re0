/**
 * The workspace policy evaluator. architecture.md 10.
 *
 * One pure function decides whether a workspace's policy admits a library,
 * and Library Search, Context Retrieval and the web all call it -- never a
 * re-implementation (10.2). The verdict carries a stable reason code; call
 * records store the code and nothing else.
 *
 * Precedence, in order and deliberately asymmetric (10.2):
 *
 *   1. source-type switches and the blocklist refuse first, and nothing
 *      overrides them -- not even "always allow";
 *   2. select mode admits only the allowlist;
 *   3. "always allow" (excepted) bypasses ONLY the quality thresholds below;
 *   4. quality thresholds: verified, trust score, freshness, then the repo
 *      and website metrics of requirement.md 5.2.
 *
 * What is NOT this module's job: private ownership, safety suspension,
 * account deactivation and credential revocation are enforced by the
 * retrieval chain before the policy is ever consulted (10.2 lists them as
 * non-overridable for exactly that reason -- they are not policy at all).
 *
 * The repo and website metrics (stars, licence, backlinks, referring
 * domains, organic traffic) are evaluated only against a subject that
 * carries them: the ingestion pipeline does not collect most of them yet, and
 * a threshold over a value that is never populated would silently block
 * everything. An unknown metric (`null`) therefore passes, exactly as an
 * unknown age does.
 */

export const POLICY_REASONS = [
  'allowed',
  'source_type_disabled',
  'library_blocked',
  'not_in_allowlist',
  'unverified_library',
  'below_trust_threshold',
  'stale_library',
  'below_star_threshold',
  'unlicensed_library',
  'below_backlink_threshold',
  'below_referring_domain_threshold',
  'below_traffic_threshold',
] as const;

export type PolicyReason = (typeof POLICY_REASONS)[number];

/**
 * The switch a private library answers to. Private libraries are not a source
 * type -- they are the workspace's own content, whatever it was built from --
 * but requirement.md 5.2 lists them beside the source-type switches, and the
 * evaluator treats the key like one: `sourceTypes.private === false` refuses
 * every private library. `policyVerdicts` adds it to a private subject's
 * `sourceTypes`.
 */
export const PRIVATE_SOURCE_TYPE = 'private';

/**
 * The six switches the console shows (requirement.md 5.2), each covering the
 * stored source types it stands for.
 */
export const POLICY_SOURCE_GROUPS = {
  repos: ['github'],
  sites: ['website'],
  schema: ['markdown'],
  uploads: ['pdf'],
  notion: ['notion'],
  private: [PRIVATE_SOURCE_TYPE],
} as const satisfies Record<string, readonly string[]>;

export type PolicySourceGroup = keyof typeof POLICY_SOURCE_GROUPS;

export interface PolicyQuality {
  /** Review / verification status: claimed by a verified owner or curated. */
  requireVerified: boolean;
  minTrustScore: number | null;
  /** Freshness: the content must have been refreshed within this many days. */
  maxAgeDays: number | null;
  minStars: number | null;
  /** Licence: the source must carry a licence that permits republishing. */
  requireLicense: boolean;
  minBacklinks: number | null;
  minReferringDomains: number | null;
  minOrganicTraffic: number | null;
}

export interface WorkspacePolicy {
  mode: 'quality' | 'select' | null;
  /** Source types absent from the map are enabled; false disables. */
  sourceTypes: Record<string, boolean>;
  quality: PolicyQuality;
  /** Policy list entries; see `parsePolicyEntry`. */
  blockedLibraries: string[];
  exceptedLibraries: string[];
  allowedLibraries: string[];
}

export const OPEN_QUALITY: PolicyQuality = {
  requireVerified: false,
  minTrustScore: null,
  maxAgeDays: null,
  minStars: null,
  requireLicense: false,
  minBacklinks: null,
  minReferringDomains: null,
  minOrganicTraffic: null,
};

/** The policy of a workspace that never configured one: everything admits. */
export const OPEN_POLICY: WorkspacePolicy = {
  mode: null,
  sourceTypes: {},
  quality: OPEN_QUALITY,
  blockedLibraries: [],
  exceptedLibraries: [],
  allowedLibraries: [],
};

/** Whether a quality block constrains nothing: every threshold left unset. */
export function qualityIsOpen(quality: PolicyQuality): boolean {
  return (Object.keys(OPEN_QUALITY) as (keyof PolicyQuality)[]).every(
    (key) => quality[key] === OPEN_QUALITY[key],
  );
}

/**
 * A policy with its mode made explicit before it is stored or read back.
 *
 * `mode` is nullable because a workspace that never configured anything has
 * no mode, but the console draws the quality controls whenever the mode is
 * not `select` -- so a workspace could set a Trust Score threshold, see it on
 * the screen, and store it beside `mode: null`, where `evaluatePolicy`
 * ignores it and retrieval admits everything. A policy that carries a
 * threshold or an "always allow" entry *is* a quality policy: it is stored as
 * one, and a legacy version that was not is read as one. Only a policy that
 * constrains nothing keeps a null mode.
 */
export function normalizePolicyMode(policy: WorkspacePolicy): WorkspacePolicy {
  if (policy.mode !== null) return policy;
  const constrains = !qualityIsOpen(policy.quality) || policy.exceptedLibraries.length > 0;
  return constrains ? { ...policy, mode: 'quality' } : policy;
}

export interface PolicySubject {
  publicId: string;
  /** Every source type the library ingests from (plus `private` when it is). */
  sourceTypes: string[];
  /** Hostnames of the library's sources, lower-cased; empty when none apply. */
  domains?: string[];
  trustScore: number;
  /** Claimed by a verified owner, or platform-curated. */
  verified: boolean;
  /** Days since the content was last refreshed; null when unknown. */
  ageDays: number | null;
  /** Repository and website metrics; null (or absent) when not collected. */
  stars?: number | null;
  hasLicense?: boolean | null;
  backlinks?: number | null;
  referringDomains?: number | null;
  organicTraffic?: number | null;
}

export interface PolicyVerdict {
  allowed: boolean;
  reason: PolicyReason;
}

export function evaluatePolicy(policy: WorkspacePolicy, subject: PolicySubject): PolicyVerdict {
  /*
   * A library whose chunks include content from any disabled source type is
   * refused outright: chunks from several sources are co-mingled in one
   * version, so admitting the library would admit the disabled source.
   */
  if (subject.sourceTypes.some((type) => policy.sourceTypes[type] === false)) {
    return { allowed: false, reason: 'source_type_disabled' };
  }

  if (listedIn(policy.blockedLibraries, subject)) {
    return { allowed: false, reason: 'library_blocked' };
  }

  if (policy.mode === 'select') {
    return listedIn(policy.allowedLibraries, subject)
      ? { allowed: true, reason: 'allowed' }
      : { allowed: false, reason: 'not_in_allowlist' };
  }

  if (policy.mode === 'quality') {
    if (listedIn(policy.exceptedLibraries, subject)) {
      return { allowed: true, reason: 'allowed' };
    }
    const q = policy.quality;
    if (q.requireVerified && !subject.verified) {
      return { allowed: false, reason: 'unverified_library' };
    }
    if (q.minTrustScore !== null && subject.trustScore < q.minTrustScore) {
      return { allowed: false, reason: 'below_trust_threshold' };
    }
    if (q.maxAgeDays !== null && subject.ageDays !== null && subject.ageDays > q.maxAgeDays) {
      return { allowed: false, reason: 'stale_library' };
    }
    if (below(q.minStars, subject.stars)) {
      return { allowed: false, reason: 'below_star_threshold' };
    }
    if (q.requireLicense && subject.hasLicense === false) {
      return { allowed: false, reason: 'unlicensed_library' };
    }
    if (below(q.minBacklinks, subject.backlinks)) {
      return { allowed: false, reason: 'below_backlink_threshold' };
    }
    if (below(q.minReferringDomains, subject.referringDomains)) {
      return { allowed: false, reason: 'below_referring_domain_threshold' };
    }
    if (below(q.minOrganicTraffic, subject.organicTraffic)) {
      return { allowed: false, reason: 'below_traffic_threshold' };
    }
  }

  return { allowed: true, reason: 'allowed' };
}

/** A threshold only bites when it is set and the metric is known. */
function below(threshold: number | null, value: number | null | undefined): boolean {
  return threshold !== null && value !== null && value !== undefined && value < threshold;
}

/* ---------------------------------------------------------- list entries */

/**
 * Whether one allow/block/except entry covers a library.
 *
 * An entry is a Library ID, or a prefix: `/websites/ethereum/*` covers
 * `/websites/ethereum` and every library nested under it (requirement.md 6.1
 * nests the slug namespaces), and `/vercel/*` covers an organisation's every
 * repository. The star is only meaningful as a whole trailing segment;
 * `/websites/eth*` is not a pattern and matches nothing, which the contract
 * schema refuses before it gets here.
 *
 * Case-insensitively, like a domain entry: a repository Library ID keeps the
 * case GitHub published it in (`/Vercel/next.js`, see `normalizePublicId`),
 * while whoever types an entry types it however they read it. Comparing the
 * two literally would leave an allow entry silently matching nothing.
 */
export function libraryEntryMatches(entry: string, publicId: string): boolean {
  const wanted = entry.toLowerCase();
  const given = publicId.toLowerCase();
  if (!wanted.endsWith('/*')) return given === wanted;
  const base = wanted.slice(0, -2);
  return given === base || given.startsWith(`${base}/`);
}

/**
 * A domain entry (`docs.example.com`) covers a library whose sources live on
 * that host or under it: `example.com` also covers `docs.example.com`.
 */
export function domainEntryMatches(entry: string, host: string): boolean {
  const wanted = entry.toLowerCase();
  const given = host.toLowerCase();
  return given === wanted || given.endsWith(`.${wanted}`);
}

export function isDomainEntry(entry: string): boolean {
  return !entry.startsWith('/');
}

export function listedIn(
  entries: readonly string[],
  subject: string | Pick<PolicySubject, 'publicId' | 'domains'>,
): boolean {
  const publicId = typeof subject === 'string' ? subject : subject.publicId;
  const domains = typeof subject === 'string' ? [] : (subject.domains ?? []);
  return entries.some((entry) =>
    isDomainEntry(entry)
      ? domains.some((host) => domainEntryMatches(entry, host))
      : libraryEntryMatches(entry, publicId),
  );
}

/* ------------------------------------------------------- entry parsing */

const ID_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i;
export const MAX_ENTRY_LENGTH = 258;

export type PolicyEntryKind = 'library' | 'organisation' | 'domain';

export interface ParsedPolicyEntry {
  /** The canonical form the policy stores. */
  entry: string;
  kind: PolicyEntryKind;
}

/**
 * One typed list entry to its stored form, or null when it is none of the
 * three shapes requirement.md 5.2 names:
 *
 *   - a Library ID, `/vercel/next.js` or `/websites/ethereum/whitepaper`,
 *     optionally `/…/*` to cover what nests under it;
 *   - an organisation, `vercel`, `@vercel`, `/vercel` or `/vercel/*`, which
 *     becomes `/vercel/*` -- every repository the owner publishes;
 *   - a domain, `docs.example.com`, with or without a scheme or path, which
 *     covers every library whose sources live on that host.
 *
 * Website slugs are typed by whoever publishes the library, so a domain is
 * kept as a domain rather than guessed into a `/websites/…` id.
 */
export function parsePolicyEntry(raw: string): ParsedPolicyEntry | null {
  let value = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (value.length === 0 || value.length > MAX_ENTRY_LENGTH) return null;

  const url = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  if (url) {
    const host = value.slice(url[0].length).split(/[/?#]/)[0]?.replace(/:\d+$/, '') ?? '';
    return DOMAIN.test(host) ? { entry: host.toLowerCase(), kind: 'domain' } : null;
  }

  if (value.startsWith('@')) value = `/${value.slice(1)}`;
  if (!value.startsWith('/')) {
    if (DOMAIN.test(value)) return { entry: value.toLowerCase(), kind: 'domain' };
    /*
     * A dotted bare value is a host that failed the domain rules -- longer
     * than 253 characters, or a TLD that is not one. `ID_SEGMENT` accepts
     * dots (repository names carry them), so without this it would be stored
     * as `/<whole-host>/*`: an entry the schema accepts and nothing matches.
     */
    if (value.includes('.')) return null;
    return ID_SEGMENT.test(value) ? { entry: `/${value}/*`, kind: 'organisation' } : null;
  }

  const segments = value.slice(1).replace(/\/+$/, '').split('/');
  const wildcard = segments[segments.length - 1] === '*';
  const named = wildcard ? segments.slice(0, -1) : segments;
  if (named.length === 0 || named.length > 6) return null;
  if (!named.every((segment) => ID_SEGMENT.test(segment))) return null;
  if (named.length === 1) {
    return { entry: `/${named[0]}/*`, kind: 'organisation' };
  }
  return { entry: `/${named.join('/')}${wildcard ? '/*' : ''}`, kind: 'library' };
}

export interface ParsedPolicyList {
  entries: string[];
  invalid: string[];
}

/**
 * A pasted or uploaded list to entries: one per line or per CSV cell, in any
 * mix; quotes and blank cells dropped, a header cell (`library`, `id`,
 * `domain`…) ignored, duplicates folded. Whatever does not parse is returned
 * so the console can show it rather than silently dropping it.
 */
export function parsePolicyList(text: string): ParsedPolicyList {
  const entries: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  const cells = text
    .split(/[\r\n,;\t]+/)
    .map((cell) => cell.trim().replace(/^["']|["']$/g, '').trim())
    .filter((cell) => cell.length > 0 && !LIST_HEADERS.has(cell.toLowerCase()));

  for (const cell of cells) {
    const parsed = parsePolicyEntry(cell);
    if (!parsed) {
      if (!invalid.includes(cell)) invalid.push(cell);
      continue;
    }
    if (seen.has(parsed.entry)) continue;
    seen.add(parsed.entry);
    entries.push(parsed.entry);
  }
  return { entries, invalid };
}

const LIST_HEADERS = new Set([
  'library',
  'libraries',
  'library id',
  'library_id',
  'libraryid',
  'id',
  'ids',
  'entry',
  'entries',
  'domain',
  'domains',
  'organisation',
  'organization',
  'org',
]);

/* ------------------------------------------------------------ patching */

export interface PolicyListDiff {
  add?: string[];
  remove?: string[];
}

/**
 * The incremental patch that turns `current` into `next` -- the shape
 * PATCH /v1/policies takes, so the console applies a draft through the same
 * path as the API and mints the same immutable version. Unchanged parts are
 * left out, so a patch built from an unchanged draft is empty.
 */
export interface PolicyDiff {
  mode?: 'quality' | 'select' | 'clear';
  sourceTypes?: { enable?: string[]; disable?: string[] };
  quality?: Partial<PolicyQuality>;
  blocked?: PolicyListDiff;
  excepted?: PolicyListDiff;
  allowed?: PolicyListDiff;
}

export function diffPolicy(current: WorkspacePolicy, next: WorkspacePolicy): PolicyDiff {
  const diff: PolicyDiff = {};
  if (next.mode !== current.mode) diff.mode = next.mode ?? 'clear';

  const enable = Object.keys(current.sourceTypes).filter(
    (type) => current.sourceTypes[type] === false && next.sourceTypes[type] !== false,
  );
  const disable = Object.keys(next.sourceTypes).filter(
    (type) => next.sourceTypes[type] === false && current.sourceTypes[type] !== false,
  );
  if (enable.length > 0 || disable.length > 0) {
    diff.sourceTypes = {
      ...(enable.length > 0 ? { enable } : {}),
      ...(disable.length > 0 ? { disable } : {}),
    };
  }

  const quality: Partial<PolicyQuality> = {};
  for (const key of Object.keys(OPEN_QUALITY) as (keyof PolicyQuality)[]) {
    if (current.quality[key] !== next.quality[key]) {
      (quality as Record<string, unknown>)[key] = next.quality[key];
    }
  }
  if (Object.keys(quality).length > 0) diff.quality = quality;

  const blocked = diffList(current.blockedLibraries, next.blockedLibraries);
  const excepted = diffList(current.exceptedLibraries, next.exceptedLibraries);
  const allowed = diffList(current.allowedLibraries, next.allowedLibraries);
  if (blocked) diff.blocked = blocked;
  if (excepted) diff.excepted = excepted;
  if (allowed) diff.allowed = allowed;
  return diff;
}

function diffList(current: readonly string[], next: readonly string[]): PolicyListDiff | null {
  const before = new Set(current);
  const after = new Set(next);
  const add = [...after].filter((entry) => !before.has(entry));
  const remove = [...before].filter((entry) => !after.has(entry));
  if (add.length === 0 && remove.length === 0) return null;
  return { ...(add.length > 0 ? { add } : {}), ...(remove.length > 0 ? { remove } : {}) };
}

export function policyDiffIsEmpty(diff: PolicyDiff): boolean {
  return Object.keys(diff).length === 0;
}

/** Whether a source group is on: every stored type it covers is enabled. */
export function sourceGroupEnabled(policy: WorkspacePolicy, group: PolicySourceGroup): boolean {
  return POLICY_SOURCE_GROUPS[group].every((type) => policy.sourceTypes[type] !== false);
}

export function withSourceGroup(
  policy: WorkspacePolicy,
  group: PolicySourceGroup,
  enabled: boolean,
): WorkspacePolicy {
  const sourceTypes = { ...policy.sourceTypes };
  for (const type of POLICY_SOURCE_GROUPS[group]) {
    if (enabled) delete sourceTypes[type];
    else sourceTypes[type] = false;
  }
  return { ...policy, sourceTypes };
}

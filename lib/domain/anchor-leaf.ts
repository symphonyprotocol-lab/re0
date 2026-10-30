/**
 * What gets anchored, as pure functions. No driver, no fetch, no chain SDK.
 *
 * aptos-anchoring-proposal.md 4.2 fixes the preimages and 4.3 the aggregation:
 * a window's leaves go into a Merkle tree and only the root reaches the chain.
 * Everything here is the part a third party has to be able to redo without us,
 * so it is written to be re-implementable from this file alone -- proposal 4.11
 * gate 2 wants a second, independent implementation of exactly these rules, by
 * someone who has not read this code.
 *
 * Proposal 4.11 gate 1 asks for the leaf construction to be frozen before the
 * first mainnet batch. Changing anything below after that point is not an edit:
 * it is a new `leafSchemaVersion`, with the affected subjects re-anchored and
 * the old batches left standing as `superseded` (proposal 4.5.1).
 */
import { sha256Hex } from './ingestion';

/** Bumped, never edited in place. See proposal 4.5.1. */
export const ANCHOR_LEAF_SCHEMA_VERSION = 1;

/**
 * One constant per subject, so a leaf built for one purpose can never be
 * presented as a leaf of another (proposal 4.2). The schema version is framed
 * into the preimage as its own field rather than folded in here: the separator
 * stays the fixed constant the proposal calls for, and a v1 leaf still cannot
 * be replayed as v2.
 */
const DOMAIN_SEPARATOR = {
  version: 're0/anchor/version',
  audit_head: 're0/anchor/audit-head',
  earning_statement: 're0/anchor/earning-statement',
} as const;

export type AnchorSubject = keyof typeof DOMAIN_SEPARATOR;

/**
 * The constant a subject's preimage opens with.
 *
 * Published alongside a public preimage so the response is self-describing: a
 * verifier can check it against proposal 4.2.1 rather than having to trust that
 * the field order it was handed is the one that was hashed.
 */
export function anchorDomainSeparator(subject: AnchorSubject): string {
  return DOMAIN_SEPARATOR[subject];
}

const encoder = new TextEncoder();

/**
 * Fields, framed by byte length, before hashing.
 *
 * Plain concatenation is a collision waiting to happen: `assetId` "ab" with
 * `versionId` "c" and "a" with "bc" hash to the same thing, and both are values
 * an attacker who can name an asset gets to choose. Length-prefixing removes
 * the ambiguity without needing a separator no field may contain -- and the
 * length is in UTF-8 bytes, not code units, so a re-implementation in another
 * language agrees about what a Chinese title costs.
 */
function frame(fields: readonly string[]): string {
  return fields.map((field) => `${encoder.encode(field).length}:${field}`).join('|');
}

/**
 * A moment, as it goes into a preimage: ISO 8601 UTC, milliseconds, `Z`.
 *
 * Postgres keeps microseconds and JavaScript does not. Both sides of the
 * comparison go through this, and the proof API publishes the same string, so
 * the truncation is part of the format rather than a discrepancy waiting to
 * surface the first time someone verifies a leaf.
 */
export function anchorInstant(value: Date): string {
  return value.toISOString();
}

export interface VersionLeafInput {
  assetId: string;
  versionId: string;
  sourceDigest: string;
  /** `asset_version.content_merkle_root` -- the proposal's `manifest_digest`. */
  contentMerkleRoot: string;
  publishedAt: Date;
  /** Empty for a public asset, whose preimage is publishable in full. */
  salt: string;
}

export function versionLeaf(input: VersionLeafInput): Promise<string> {
  return sha256Hex(
    frame([
      DOMAIN_SEPARATOR.version,
      String(ANCHOR_LEAF_SCHEMA_VERSION),
      input.assetId,
      input.versionId,
      input.sourceDigest,
      input.contentMerkleRoot,
      anchorInstant(input.publishedAt),
      input.salt,
    ]),
  );
}

export interface AuditHeadLeafInput {
  /** The UTC day the head closes, `YYYY-MM-DD`. */
  date: string;
  /** `audit_log.hash` of the newest entry that day (architecture.md 14). */
  chainHead: string;
}

/**
 * No salt. The audit chain is the platform's own record of its own actions, so
 * there is no third party whose existence a public preimage could reveal --
 * and the head is already a hash of hashes.
 */
export function auditHeadLeaf(input: AuditHeadLeafInput): Promise<string> {
  return sha256Hex(
    frame([
      DOMAIN_SEPARATOR.audit_head,
      String(ANCHOR_LEAF_SCHEMA_VERSION),
      input.date,
      input.chainHead,
    ]),
  );
}

/**
 * One statement: a publisher account's summed share for one period. The
 * amount is an integer in minor units, so it frames as decimal text with no
 * float on either side; a negative statement (refunds outweighed income)
 * frames with its sign.
 */
export interface EarningLeafInput {
  publisherAccountId: string;
  periodId: string;
  amountMinor: number;
  currency: string;
  /** Covers the statement's full line-by-line detail (proposal 4.2). */
  statementDigest: string;
  /** Never empty: a statement's amount is financial privacy (proposal 3.2). */
  salt: string;
}

export function earningStatementLeaf(input: EarningLeafInput): Promise<string> {
  return sha256Hex(
    frame([
      DOMAIN_SEPARATOR.earning_statement,
      String(ANCHOR_LEAF_SCHEMA_VERSION),
      input.publisherAccountId,
      input.periodId,
      String(input.amountMinor),
      input.currency,
      input.statementDigest,
      input.salt,
    ]),
  );
}

/**
 * A private subject's salt, derived rather than stored per row.
 *
 * The secret stays a parameter: this module is domain code and must not read
 * the environment. `scope` is what the salt is per -- a workspace id for a
 * private asset, a publisher account id for a statement -- so one leaked
 * salt cannot be used to test candidate content against another workspace's
 * leaves.
 *
 * Rotating the secret invalidates every proof derived from it. That is a
 * re-anchor under a new schema version, not a configuration change.
 */
export async function deriveAnchorSalt(secret: string, scope: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(frame(['re0/anchor/salt', scope])));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------ merkle batch */

/**
 * One proof step: the sibling, and which side of the pair it sat on.
 *
 * `l:<hex>` means the sibling is the left half and the node being carried is
 * the right one. The side has to be recorded -- `H(a‖b)` is not `H(b‖a)`, and a
 * proof that leaves the order to the verifier is a proof that verifies both.
 */
export type AnchorProofStep = `l:${string}` | `r:${string}`;

export interface AnchorTree {
  /** Null only for an empty window, which must never be submitted. */
  root: string | null;
  /** One path per input leaf, in the order the leaves were given. */
  proofs: AnchorProofStep[][];
}

const LEAF_PREFIX = 'L:';
const NODE_PREFIX = 'N:';

/**
 * The batch tree, and every leaf's path to its root.
 *
 * Two defences, both the same ones `merkleRoot` in ./ingestion.ts applies, and
 * both required of any second implementation:
 *
 * - leaves and interior nodes are hashed under different prefixes, so an
 *   interior node cannot be presented as a leaf;
 * - an odd node is carried up unchanged rather than duplicated. Duplicating the
 *   last leaf lets two different leaf lists produce one root, which for an
 *   anchor means two different batches that cannot be told apart.
 */
export async function buildAnchorTree(leaves: readonly string[]): Promise<AnchorTree> {
  const proofs: AnchorProofStep[][] = leaves.map(() => []);
  if (leaves.length === 0) return { root: null, proofs };

  let level = await Promise.all(leaves.map((leaf) => sha256Hex(`${LEAF_PREFIX}${leaf}`)));
  /* Which original leaves sit under each node of the current level. */
  let owners: number[][] = leaves.map((_, index) => [index]);

  while (level.length > 1) {
    const next: string[] = [];
    const nextOwners: number[][] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as string;
      const leftOwners = owners[i] as number[];
      const right = level[i + 1];
      if (right === undefined) {
        next.push(left);
        nextOwners.push(leftOwners);
        continue;
      }
      const rightOwners = owners[i + 1] as number[];
      for (const index of leftOwners) proofs[index]?.push(`r:${right}`);
      for (const index of rightOwners) proofs[index]?.push(`l:${left}`);
      next.push(await sha256Hex(`${NODE_PREFIX}${left}${right}`));
      nextOwners.push([...leftOwners, ...rightOwners]);
    }
    level = next;
    owners = nextOwners;
  }

  return { root: level[0] ?? null, proofs };
}

/** Whether `leaf` is under `root` by way of `proof`. */
export async function verifyAnchorProof(
  leaf: string,
  proof: readonly string[],
  root: string,
): Promise<boolean> {
  let node = await sha256Hex(`${LEAF_PREFIX}${leaf}`);
  for (const step of proof) {
    /* A malformed step is a failed proof, never a thrown request. */
    if (!/^[lr]:[0-9a-f]{64}$/.test(step)) return false;
    const sibling = step.slice(2);
    node =
      step[0] === 'l'
        ? await sha256Hex(`${NODE_PREFIX}${sibling}${node}`)
        : await sha256Hex(`${NODE_PREFIX}${node}${sibling}`);
  }
  return node === root;
}

/**
 * anchors use cases: what the anchor tables hold about a version. Reads only
 * -- the signer that fills these tables is its own track
 * (aptos-anchoring-proposal.md 4.3, 4.6); nothing here writes.
 *
 * A Version Leaf's `subject_id` is the `library_version.id` (the `version_id`
 * of the leaf preimage, proposal 4.2). A version may have been anchored more
 * than once under different leaf schemas (4.5.1); the newest confirmed leaf is
 * the one reported, and the status is honest about the rest: `anchored` only
 * with a confirmed batch, `pending` while a batch is open or none exists yet,
 * `unavailable` when every attempt failed or was superseded.
 */
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Anchor, AnchorPreimage } from '@/contracts/schemas';
import {
  ANCHOR_LEAF_SCHEMA_VERSION,
  anchorDomainSeparator,
  anchorInstant,
  versionLeaf,
} from '@/lib/domain/anchor-leaf';
import { isVersionLabelShaped } from '@/lib/domain/library';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { sharedWithEveryone } from '@/lib/application/channels/visibility';


export { anchorHealth, type AnchorHealth } from './health';
export { releaseFailedBatch, type ReleasedBatch } from './release-batch';
export { anchorAlerts, reportAnchorAlerts } from './alerts';

export {
  anchorAuditHead,
  anchorPublishedVersions,
  previousUtcDay,
  runAnchorTick,
  type AnchorRunOptions,
  type AnchorRunResult,
  type SubmitBudget,
} from './run-batch';

export interface VersionAnchorProof extends Anchor {
  subjectType: 'version';
  /** The pinned id the caller asked about, `/owner/repo/label`. */
  pinnedId: string | null;
  batchId: string | null;
  merkleRoot: string | null;
  leafHash: string | null;
  leafIndex: number | null;
  merkleProof: string[] | null;
  leafCount: number | null;
  /** The version's own content root, the input to the leaf (proposal 4.2). */
  contentMerkleRoot: string | null;
  batchStatus: string | null;
  /**
   * What a stranger needs to rebuild the leaf, for public libraries only.
   *
   * Null everywhere else, and not because the data is missing: a private
   * version's preimage is salted and belongs to its workspace (requirement.md
   * 6.4), so it is reached through that workspace's own screens rather than
   * from an endpoint that needs no credential.
   */
  preimage: AnchorPreimage | null;
}

const BATCH_RANK: Record<string, number> = {
  confirmed: 0,
  submitted: 1,
  pending: 2,
  failed: 3,
  superseded: 4,
};

/** What the tables hold for one version id; `pending` with no rows at all. */
export async function versionAnchor(input: {
  versionId: string;
  contentMerkleRoot?: string | null;
  pinnedId?: string | null;
}): Promise<VersionAnchorProof> {
  const rows = await db()
    .select({
      leafHash: schema.anchorLeaf.leafHash,
      leafIndex: schema.anchorLeaf.leafIndex,
      merkleProof: schema.anchorLeaf.merkleProof,
      leafSchemaVersion: schema.anchorLeaf.leafSchemaVersion,
      batchId: schema.anchorBatch.id,
      merkleRoot: schema.anchorBatch.merkleRoot,
      leafCount: schema.anchorBatch.leafCount,
      network: schema.anchorBatch.network,
      txHash: schema.anchorBatch.txHash,
      status: schema.anchorBatch.status,
      confirmedAt: schema.anchorBatch.confirmedAt,
    })
    .from(schema.anchorLeaf)
    .innerJoin(schema.anchorBatch, eq(schema.anchorBatch.id, schema.anchorLeaf.batchId))
    .where(
      and(
        eq(schema.anchorLeaf.subjectType, 'version'),
        eq(schema.anchorLeaf.subjectId, input.versionId),
      ),
    )
    .orderBy(desc(schema.anchorLeaf.leafSchemaVersion));

  const best = [...rows].sort(
    (a, b) => (BATCH_RANK[a.status] ?? 9) - (BATCH_RANK[b.status] ?? 9),
  )[0];

  const base = {
    subjectType: 'version' as const,
    subjectId: input.versionId,
    pinnedId: input.pinnedId ?? null,
    contentMerkleRoot: input.contentMerkleRoot ?? null,
  };

  if (!best) {
    return {
      ...base,
      status: 'pending',
      network: null,
      txHash: null,
      blockTime: null,
      leafSchemaVersion: null,
      batchId: null,
      merkleRoot: null,
      leafHash: null,
      leafIndex: null,
      merkleProof: null,
      leafCount: null,
      batchStatus: null,
      preimage: null,
    };
  }

  const status: Anchor['status'] =
    best.status === 'confirmed'
      ? 'anchored'
      : best.status === 'failed' || best.status === 'superseded'
        ? 'unavailable'
        : 'pending';

  return {
    ...base,
    status,
    network: best.network,
    txHash: best.txHash,
    blockTime: best.confirmedAt?.toISOString() ?? null,
    leafSchemaVersion: best.leafSchemaVersion,
    batchId: best.batchId,
    merkleRoot: best.merkleRoot,
    leafHash: best.leafHash,
    leafIndex: best.leafIndex,
    merkleProof: best.merkleProof ?? null,
    leafCount: best.leafCount,
    batchStatus: best.status,
    preimage: null,
  };
}

/**
 * `/owner/repo/20260101-abcdef12` -> the library's public id and the label.
 * Slugs may never look like a label (requirement.md 6.1), so the last segment
 * decides; null when it is not a label.
 */
export function splitPinnedId(pinnedId: string): { publicId: string; label: string } | null {
  const segments = pinnedId.trim().split('/').filter(Boolean);
  const label = segments.pop();
  if (!label || segments.length === 0 || !isVersionLabelShaped(label)) return null;
  return { publicId: `/${segments.join('/')}`, label };
}

/**
 * The proof for a pinned public version, or null when there is no such
 * routable library or version. Public libraries only: a private version's
 * anchor is reached through the workspace's own screens, never by id
 * (requirement.md 6.4, 私有库…第三方无法判定存在性).
 */
export async function publicVersionAnchor(pinnedId: string): Promise<VersionAnchorProof | null> {
  const split = splitPinnedId(pinnedId);
  if (!split) return null;

  const [row] = await db()
    .select({
      versionId: schema.libraryVersion.id,
      libraryId: schema.libraryVersion.libraryId,
      sourceDigest: schema.libraryVersion.sourceDigest,
      contentMerkleRoot: schema.libraryVersion.contentMerkleRoot,
      publishedAt: schema.libraryVersion.publishedAt,
    })
    .from(schema.libraryVersion)
    .innerJoin(schema.library, eq(schema.library.id, schema.libraryVersion.libraryId))
    /*
     * The routable predicate, in full -- the same one the catalogue and
     * retrieval apply. Two of its clauses were missing here, so a library
     * that is public and published but whose index is not ready (or which has
     * no current version at all) answered about its versions on an endpoint
     * that needs no credential, while every other public surface treats it as
     * not there. "Not routable" and "not found" have to look the same from
     * outside (requirement.md 6.4).
     */
    .where(
      and(
        eq(schema.library.publicId, split.publicId),
        sharedWithEveryone(),
        eq(schema.library.lifecycleStatus, 'published'),
        eq(schema.library.indexStatus, 'ready'),
        isNotNull(schema.library.currentVersionId),
        isNull(schema.library.deletedAt),
        eq(schema.libraryVersion.label, split.label),
      ),
    )
    .limit(1);
  if (!row) return null;

  const anchor = await versionAnchor({
    versionId: row.versionId,
    contentMerkleRoot: row.contentMerkleRoot,
    pinnedId: `${split.publicId}/${split.label}`,
  });

  /*
   * The preimage rides along only when it is complete. A version with no
   * content root or no publish time has nothing a verifier could hash, and
   * handing back a half preimage would look like a leaf that fails to verify
   * rather than like data we never had.
   */
  if (!row.contentMerkleRoot || !row.publishedAt) return anchor;
  /*
   * A version anchored while its asset was its owner's alone carries a
   * salted leaf (run-batch.ts), and an asset is usually moved into a public
   * channel after its first build anchored (agent-first-proposal.md 6.1). The
   * open preimage is handed out only when it actually hashes to the leaf on
   * record; otherwise the anchor is reported without one, rather than with a
   * preimage that would read as a failed verification.
   */
  if (anchor.leafHash && anchor.leafSchemaVersion === ANCHOR_LEAF_SCHEMA_VERSION) {
    const open = await versionLeaf({
      libraryId: row.libraryId,
      versionId: row.versionId,
      sourceDigest: row.sourceDigest,
      contentMerkleRoot: row.contentMerkleRoot,
      publishedAt: row.publishedAt,
      salt: '',
    });
    if (open !== anchor.leafHash) return anchor;
  }
  return {
    ...anchor,
    preimage: {
      domainSeparator: anchorDomainSeparator('version'),
      leafSchemaVersion: anchor.leafSchemaVersion ?? ANCHOR_LEAF_SCHEMA_VERSION,
      libraryId: row.libraryId,
      versionId: row.versionId,
      sourceDigest: row.sourceDigest,
      contentMerkleRoot: row.contentMerkleRoot,
      publishedAt: anchorInstant(row.publishedAt),
      salt: '',
    },
  };
}


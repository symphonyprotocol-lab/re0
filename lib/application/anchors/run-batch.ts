/**
 * The anchor workflow: turn a window of subjects into one transaction.
 *
 * aptos-anchoring-proposal.md 4.3. Nothing here touches the publish or the
 * settlement transaction -- subjects are found by looking back at what those
 * already wrote, so removing this module leaves the rest of the platform
 * behaving identically (4.1).
 *
 * Three steps, deliberately separate, because a worker can die between any two:
 *
 *   plan     rows are written `pending`, with their leaves, in one transaction
 *   submit   the root goes to the chain; the batch becomes `submitted`
 *   confirm  the chain agrees; the batch becomes `confirmed` and proofs land
 *
 * Idempotence comes from the database rather than from remembering anything:
 * `anchor_leaf` is unique on (subject, subject_id, leaf_schema_version), so a
 * subject cannot enter two batches under one schema, and a re-run picks up the
 * open batch instead of starting another.
 *
 * Proofs are backfilled only after confirmation (4.3). A batch that never
 * landed then has no proof data to serve by mistake, and the proofs are
 * recomputable from the leaves in order if the confirming run dies too.
 */
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import {
  ANCHOR_LEAF_SCHEMA_VERSION,
  auditHeadLeaf,
  buildAnchorTree,
  deriveAnchorSalt,
  versionLeaf,
} from '@/lib/domain/anchor-leaf';
import { uuidv7 } from '@/lib/domain/id';
import {
  anchorSigner,
  isAnchorSignerConfigured,
  type AnchorSigner,
} from '@/lib/infrastructure/chain/anchor-signer';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { exposure } from '@/lib/application/channels/visibility';

/** Leaves per batch. One transaction either way; this bounds the run's memory. */
const VERSION_BATCH_LIMIT = 500;

/**
 * Proposal 2.1 budgets one version transaction an hour. The cron drain runs far
 * more often than that, so a batch only starts when the newest one is old
 * enough -- a little under an hour, so clock drift cannot skip a tick.
 */
const VERSION_BATCH_INTERVAL_MS = 55 * 60_000;

/** Submissions before a batch is given up on and reported `unavailable` (4.8). */
const MAX_ATTEMPTS = 5;

/**
 * How many transactions one tick may send, shared across every subject.
 *
 * One signing account, and a node's sequence number does not count what is
 * still in its mempool: build a second transaction before the first commits and
 * both claim the same number, which the fullnode rejects as "already in mempool
 * with a different payload". Rather than track a nonce, a tick sends one
 * transaction and leaves the rest `pending` -- the next tick is minutes away,
 * and anchoring has hours of slack (proposal 4.8).
 */
export interface SubmitBudget {
  left: number;
}

function oneSubmission(): SubmitBudget {
  return { left: 1 };
}

export interface AnchorRunOptions {
  now?: Date;
  /** Shared across subjects within one tick; see `SubmitBudget`. */
  budget?: SubmitBudget;
  /**
   * A signer to use instead of the one the environment describes.
   *
   * The seam exists for the tests, and only for them: the rules worth testing
   * here are the state machine's -- one transaction in flight, confirm before
   * submit, a re-run that continues rather than duplicates -- and none of them
   * should need a funded account and a live chain to exercise. Production never
   * passes this.
   */
  signer?: AnchorSigner;
}

export interface AnchorRunResult {
  /** What the run did, for the cron response and the log line. */
  planned: number;
  submitted: number;
  confirmed: number;
  failed: number;
  skipped: 'not_configured' | 'nothing_due' | 'too_soon' | null;
}

const NOTHING: AnchorRunResult = {
  planned: 0,
  submitted: 0,
  confirmed: 0,
  failed: 0,
  skipped: null,
};

function saltSecret(): string | null {
  const value = process.env.ANCHOR_LEAF_SALT_SECRET?.trim();
  return value ? value : null;
}

/* ------------------------------------------------------------------ version */

/**
 * Anchor the published versions that have never entered a batch.
 *
 * Not "everything published in the last hour": a run that was missed, or a
 * deployment that was down, would strand those versions forever. The window
 * recorded on the batch is the span of what it actually contains, which is also
 * what makes the SLO in 4.8 measure the right thing -- time from the last
 * publish in the batch to its confirmation.
 */
export async function anchorPublishedVersions(
  options: AnchorRunOptions = {},
): Promise<AnchorRunResult> {
  const now = options.now ?? new Date();
  const budget = options.budget ?? oneSubmission();
  if (!options.signer && !isAnchorSignerConfigured()) {
    return { ...NOTHING, skipped: 'not_configured' };
  }
  const secret = saltSecret();
  if (!secret) return { ...NOTHING, skipped: 'not_configured' };

  const database = db();

  /* An open batch is finished before another is planned. */
  const resumed = await advanceOpenBatches('version', now, budget, options.signer);
  if (resumed.submitted > 0 || resumed.confirmed > 0 || resumed.failed > 0) return resumed;

  const [recent] = await database
    .select({ windowEnd: schema.anchorBatch.windowEnd })
    .from(schema.anchorBatch)
    .where(eq(schema.anchorBatch.subjectType, 'version'))
    .orderBy(desc(schema.anchorBatch.windowEnd))
    .limit(1);
  if (recent && now.getTime() - recent.windowEnd.getTime() < VERSION_BATCH_INTERVAL_MS) {
    return { ...NOTHING, skipped: 'too_soon' };
  }

  /*
   * Published, still routable, with a content root to commit to, and not
   * already anchored under this schema. The `not exists` is what makes a second
   * run a no-op rather than a duplicate batch.
   */
  const candidates = await database
    .select({
      versionId: schema.libraryVersion.id,
      libraryId: schema.libraryVersion.libraryId,
      sourceDigest: schema.libraryVersion.sourceDigest,
      contentMerkleRoot: schema.libraryVersion.contentMerkleRoot,
      publishedAt: schema.libraryVersion.publishedAt,
      visibility: exposure(),
      ownerWorkspaceId: schema.library.ownerWorkspaceId,
    })
    .from(schema.libraryVersion)
    .innerJoin(schema.library, eq(schema.library.id, schema.libraryVersion.libraryId))
    .where(
      and(
        isNotNull(schema.libraryVersion.publishedAt),
        isNotNull(schema.libraryVersion.contentMerkleRoot),
        isNull(schema.library.deletedAt),
        /* `subject_id` is text so one column can hold a uuid, a date and a
           period id; the cast is what lets it be compared to a uuid column. */
        sql`not exists (
          select 1 from ${schema.anchorLeaf}
          where ${schema.anchorLeaf.subjectType} = 'version'
            and ${schema.anchorLeaf.subjectId} = ${schema.libraryVersion.id}::text
            and ${schema.anchorLeaf.leafSchemaVersion} = ${ANCHOR_LEAF_SCHEMA_VERSION}
        )`,
      ),
    )
    .orderBy(asc(schema.libraryVersion.publishedAt))
    .limit(VERSION_BATCH_LIMIT);

  if (candidates.length === 0) return { ...NOTHING, skipped: 'nothing_due' };

  const leaves = await Promise.all(
    candidates.map(async (row) => ({
      subjectId: row.versionId,
      hash: await versionLeaf({
        libraryId: row.libraryId,
        versionId: row.versionId,
        sourceDigest: row.sourceDigest,
        contentMerkleRoot: row.contentMerkleRoot as string,
        publishedAt: row.publishedAt as Date,
        /*
         * Assets in a public channel anchor an open preimage so anyone can
         * recompute the leaf; one that is its owner's alone is salted per
         * workspace, so the chain cannot be
         * used to test candidate content against it (proposal 3.2, 4.2). The
         * library id is the fallback scope for the case the schema allows but
         * ownership has not filled in -- still unguessable, still per subject.
         */
        salt:
          row.visibility === 'public'
            ? ''
            : await deriveAnchorSalt(secret, row.ownerWorkspaceId ?? row.libraryId),
      }),
    })),
  );

  const windowStart = candidates[0]?.publishedAt as Date;
  const windowEnd = candidates[candidates.length - 1]?.publishedAt as Date;
  await planBatch('version', leaves, windowStart, windowEnd);
  return {
    ...(await advanceOpenBatches('version', now, budget, options.signer)),
    planned: leaves.length,
  };
}

/* --------------------------------------------------------------- audit head */

/**
 * `YYYY-MM-DD` for the UTC day before `now`, and the instant it ended.
 *
 * Exported for its own test: month, year and leap-day boundaries are where a
 * hand-rolled date walk goes wrong, and getting it wrong here anchors the wrong
 * day's chain head under a subject id that can never be corrected in place.
 */
export function previousUtcDay(now: Date): { date: string; endsAt: Date } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const endsAt = new Date(midnight);
  return { date: new Date(midnight - 86_400_000).toISOString().slice(0, 10), endsAt };
}

/**
 * Anchor yesterday's audit chain head (proposal 2.1: one transaction a day).
 *
 * The subject id is the date, so the unique index on `anchor_leaf` is the whole
 * of the "once a day" rule -- no schedule state to keep, and a run at any hour
 * of the day does the same thing.
 */
export async function anchorAuditHead(
  options: AnchorRunOptions = {},
): Promise<AnchorRunResult> {
  const now = options.now ?? new Date();
  const budget = options.budget ?? oneSubmission();
  if (!options.signer && !isAnchorSignerConfigured()) {
    return { ...NOTHING, skipped: 'not_configured' };
  }
  const database = db();

  const resumed = await advanceOpenBatches('audit_head', now, budget, options.signer);
  if (resumed.submitted > 0 || resumed.confirmed > 0 || resumed.failed > 0) return resumed;

  const { date, endsAt } = previousUtcDay(now);
  const [existing] = await database
    .select({ id: schema.anchorLeaf.id })
    .from(schema.anchorLeaf)
    .where(
      and(
        eq(schema.anchorLeaf.subjectType, 'audit_head'),
        eq(schema.anchorLeaf.subjectId, date),
        eq(schema.anchorLeaf.leafSchemaVersion, ANCHOR_LEAF_SCHEMA_VERSION),
      ),
    )
    .limit(1);
  if (existing) return { ...NOTHING, skipped: 'nothing_due' };

  /*
   * The head is the newest entry that closed inside the day, by `seq`: two
   * entries can share a timestamp to the microsecond, and the chain's order is
   * the insertion order (architecture.md 14).
   */
  const [head] = await database
    .select({ hash: schema.auditLog.hash })
    .from(schema.auditLog)
    .where(lt(schema.auditLog.createdAt, endsAt))
    .orderBy(desc(schema.auditLog.seq))
    .limit(1);
  /* A day with no administrative action anchors nothing, rather than a zero. */
  if (!head?.hash) return { ...NOTHING, skipped: 'nothing_due' };

  const hash = await auditHeadLeaf({ date, chainHead: head.hash });
  await planBatch(
    'audit_head',
    [{ subjectId: date, hash }],
    new Date(endsAt.getTime() - 86_400_000),
    endsAt,
  );
  return {
    ...(await advanceOpenBatches('audit_head', now, budget, options.signer)),
    planned: 1,
  };
}

/**
 * One scheduled tick: versions, then the audit head, sharing one transaction.
 *
 * Sequential and budgeted for the same reason -- see `SubmitBudget`. Running
 * the two concurrently is the reliable way to make them collide.
 */
export async function runAnchorTick(options: AnchorRunOptions = {}): Promise<{
  versions: AnchorRunResult;
  audit: AnchorRunResult;
}> {
  const shared = { ...options, budget: options.budget ?? oneSubmission() };
  const versions = await anchorPublishedVersions(shared);
  const audit = await anchorAuditHead(shared);
  return { versions, audit };
}

/* ----------------------------------------------------------------- plumbing */

interface PlannedLeaf {
  subjectId: string;
  hash: string;
}

type Subject = 'version' | 'audit_head' | 'earning_statement';

/** The batch and its leaves in one transaction, or neither. */
async function planBatch(
  subjectType: Subject,
  leaves: readonly PlannedLeaf[],
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  const { root } = await buildAnchorTree(leaves.map((leaf) => leaf.hash));
  if (!root) return;

  const batchId = uuidv7();
  await db().transaction(async (tx) => {
    await tx.insert(schema.anchorBatch).values({
      id: batchId,
      subjectType,
      leafSchemaVersion: ANCHOR_LEAF_SCHEMA_VERSION,
      merkleRoot: root,
      leafCount: leaves.length,
      windowStart,
      windowEnd,
      network: (process.env.APTOS_NETWORK ?? 'testnet').toLowerCase(),
      status: 'pending',
      attempts: 0,
    });
    await tx.insert(schema.anchorLeaf).values(
      leaves.map((leaf, index) => ({
        id: uuidv7(),
        batchId,
        leafHash: leaf.hash,
        leafSchemaVersion: ANCHOR_LEAF_SCHEMA_VERSION,
        subjectType,
        subjectId: leaf.subjectId,
        leafIndex: index,
        merkleProof: null,
      })),
    );
  });
}

/**
 * Push every open batch of one subject one step further.
 *
 * Confirmations first, then at most one submission -- and only if nothing is
 * left in flight afterwards. One signing account means one transaction at a
 * time: a node reports the sequence number it has committed, not what sits in
 * its mempool, so a second transaction built while the first is unlanded either
 * duplicates a number ("already in mempool") or is beaten to it
 * ("SEQUENCE_NUMBER_TOO_OLD"). Both were observed before this order existed.
 *
 * Waiting costs nothing that matters: the SLO is two hours (proposal 4.8) and
 * the tick is minutes.
 */
async function advanceOpenBatches(
  subjectType: Subject,
  now: Date,
  budget: SubmitBudget,
  injected?: AnchorSigner,
): Promise<AnchorRunResult> {
  const database = db();
  const result: AnchorRunResult = { ...NOTHING };

  const open = await database
    .select({
      id: schema.anchorBatch.id,
      status: schema.anchorBatch.status,
      txHash: schema.anchorBatch.txHash,
      merkleRoot: schema.anchorBatch.merkleRoot,
      windowEnd: schema.anchorBatch.windowEnd,
      attempts: schema.anchorBatch.attempts,
    })
    .from(schema.anchorBatch)
    .where(
      and(
        eq(schema.anchorBatch.subjectType, subjectType),
        inArray(schema.anchorBatch.status, ['pending', 'submitted']),
      ),
    )
    .orderBy(asc(schema.anchorBatch.windowEnd));
  if (open.length === 0) return result;

  let signer: AnchorSigner;
  try {
    signer = injected ?? anchorSigner();
  } catch {
    /* Misconfigured is not failed: the batches stay open for the next run. */
    return { ...result, skipped: 'not_configured' };
  }

  /* ---- confirmations, which cost no transaction ---- */
  for (const batch of open) {
    if (batch.status !== 'submitted' || !batch.txHash) continue;
    const confirmation = await signer.confirmBatch(batch.txHash);
    if (confirmation.status === 'confirmed') {
      await confirmBatch(batch.id, confirmation.confirmedAt ?? now);
      result.confirmed += 1;
    } else if (confirmation.status === 'failed') {
      /*
       * The chain ran it and rejected it. Retrying the identical payload would
       * abort identically, so this batch is over; the subjects it holds are
       * re-anchored under a new schema version (4.5.1), which is an operator's
       * decision rather than this loop's.
       */
      await database
        .update(schema.anchorBatch)
        .set({ status: 'failed' })
        .where(eq(schema.anchorBatch.id, batch.id));
      result.failed += 1;
      console.warn(`anchor: batch ${batch.id} aborted on chain: ${confirmation.vmStatus ?? '?'}`);
    }
  }

  /* ---- one submission, only with an empty flight ---- */
  const pending = open.filter((batch) => batch.status === 'pending');
  if (pending.length === 0 || budget.left <= 0) return result;

  const [inFlight] = await database
    .select({ n: count() })
    .from(schema.anchorBatch)
    .where(eq(schema.anchorBatch.status, 'submitted'));
  if ((inFlight?.n ?? 0) > 0) return result;

  const batch = pending[0] as (typeof open)[number];
  budget.left -= 1;
  try {
    const { txHash } = await signer.submitBatch({
      leafSchemaVersion: ANCHOR_LEAF_SCHEMA_VERSION,
      subjectType,
      merkleRoot: batch.merkleRoot,
      windowEnd: batch.windowEnd,
    });
    await database
      .update(schema.anchorBatch)
      .set({ status: 'submitted', txHash, attempts: batch.attempts + 1 })
      .where(eq(schema.anchorBatch.id, batch.id));
    result.submitted += 1;
  } catch (error) {
    const attempts = batch.attempts + 1;
    await database
      .update(schema.anchorBatch)
      .set({ attempts, ...(attempts >= MAX_ATTEMPTS ? { status: 'failed' as const } : {}) })
      .where(eq(schema.anchorBatch.id, batch.id));
    if (attempts >= MAX_ATTEMPTS) result.failed += 1;
    /* Batch id and a stable message only -- never the payload (4.9). */
    console.warn(
      `anchor: submit failed for ${batch.id}, attempt ${attempts}: ${
        error instanceof Error ? error.message : 'unknown'
      }`,
    );
  }
  return result;
}

/** Mark a batch confirmed and write the proofs its leaves can now carry. */
async function confirmBatch(batchId: string, confirmedAt: Date): Promise<void> {
  const database = db();
  const leaves = await database
    .select({ id: schema.anchorLeaf.id, hash: schema.anchorLeaf.leafHash })
    .from(schema.anchorLeaf)
    .where(eq(schema.anchorLeaf.batchId, batchId))
    .orderBy(asc(schema.anchorLeaf.leafIndex));

  const { proofs } = await buildAnchorTree(leaves.map((leaf) => leaf.hash));

  await database.transaction(async (tx) => {
    for (const [index, leaf] of leaves.entries()) {
      await tx
        .update(schema.anchorLeaf)
        .set({ merkleProof: proofs[index] ?? [] })
        .where(eq(schema.anchorLeaf.id, leaf.id));
    }
    await tx
      .update(schema.anchorBatch)
      .set({ status: 'confirmed', confirmedAt })
      .where(eq(schema.anchorBatch.id, batchId));
  });
}

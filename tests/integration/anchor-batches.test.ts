/**
 * The anchoring state machine, against a real database and a signer that never
 * touches a chain.
 *
 * Everything worth asserting here is a rule about ordering and idempotence --
 * one transaction in flight, confirm before submit, a re-run that continues
 * rather than duplicates, a batch that is given up on after enough attempts --
 * and none of it should need a funded account to exercise. The chain half is
 * verified where it belongs: the contract has its own Move tests, and the
 * signer was exercised against the real testnet object.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database. Integration
 * files are serialised (vitest.config.mts), so clearing the anchor tables
 * between cases cannot interfere with another file's fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
process.env.ANCHOR_LEAF_SALT_SECRET ??= 'test-anchor-salt-secret';
process.env.APTOS_NETWORK ??= 'testnet';

const { anchorAuditHead, anchorPublishedVersions, runAnchorTick } = await import(
  '@/lib/application/anchors'
);
const { releaseFailedBatch } = await import('@/lib/application/anchors');
const { AdminChangeRefused } = await import('@/lib/domain/admin');
const { verifyAnchorProof } = await import('@/lib/domain/anchor-leaf');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { eq, inArray } = await import('drizzle-orm');
import type { AnchorSigner, AnchorSubmission } from '@/lib/infrastructure/chain/anchor-signer';
import { shareInPublicChannel } from '../fixtures/channels';

const stamp = Date.now();
const workspaceId = crypto.randomUUID();
const assetIds: string[] = [];
const versionIds: string[] = [];

interface Fake extends AnchorSigner {
  submissions: AnchorSubmission[];
  /** Set to make the next submit throw, as a node refusing the transaction. */
  failSubmit: boolean;
  /** What the chain says about a submitted transaction. */
  outcome: 'pending' | 'confirmed' | 'failed';
}

function fakeSigner(): Fake {
  const fake: Fake = {
    network: 'testnet',
    accountAddress: '0xsigner',
    objectAddress: '0xobject',
    submissions: [],
    failSubmit: false,
    outcome: 'confirmed',
    async submitBatch(payload) {
      if (fake.failSubmit) throw new Error('node refused');
      fake.submissions.push(payload);
      return { txHash: `0xtx${fake.submissions.length}-${uuidv7()}` };
    },
    async confirmBatch() {
      return {
        status: fake.outcome,
        confirmedAt: fake.outcome === 'confirmed' ? new Date('2026-02-01T00:00:00Z') : null,
        vmStatus: fake.outcome === 'failed' ? 'ABORTED' : null,
      };
    },
    async balanceOctas() {
      return 1_000_000_000;
    },
  };
  return fake;
}

async function publishedVersion(input: {
  slug: string;
  visibility?: 'public' | 'private';
  publishedAt?: Date;
}): Promise<string> {
  const database = db();
  const assetId = crypto.randomUUID();
  assetIds.push(assetId);
  await database.insert(schema.asset).values({
    id: assetId,
    publicId: `/batches-${stamp}/${input.slug}`,
    title: `Batch fixture ${input.slug}`,
    ownerWorkspaceId: workspaceId,
    kind: 'website',
    lifecycleStatus: 'published',
    indexStatus: 'ready',
  });
  /* Public means free in a public channel now (agent-first-proposal.md 6.2). */
  if ((input.visibility ?? 'public') === 'public') await shareInPublicChannel(assetId);
  const versionId = uuidv7();
  versionIds.push(versionId);
  await database.insert(schema.assetVersion).values({
    id: versionId,
    assetId,
    label: `2026010${versionIds.length}-aaaaaaaa`,
    sourceDigest: `digest-${stamp}-${input.slug}`,
    parserVersion: 'test',
    chunkerVersion: 'test',
    embeddingModel: 'test',
    indexStatus: 'ready',
    contentMerkleRoot: `root-${input.slug}`,
    publishedAt: input.publishedAt ?? new Date('2026-01-15T12:00:00Z'),
  });
  return versionId;
}

const batches = () =>
  db()
    .select({
      id: schema.anchorBatch.id,
      subjectType: schema.anchorBatch.subjectType,
      status: schema.anchorBatch.status,
      attempts: schema.anchorBatch.attempts,
      leafCount: schema.anchorBatch.leafCount,
      merkleRoot: schema.anchorBatch.merkleRoot,
      windowEnd: schema.anchorBatch.windowEnd,
    })
    .from(schema.anchorBatch);

describeWithDb('anchor batches', () => {
  beforeAll(async () => {
    await db().insert(schema.workspace).values({ id: workspaceId, name: 'anchor-batches-test' });
  });

  beforeEach(async () => {
    await db().delete(schema.anchorLeaf);
    await db().delete(schema.anchorBatch);
  });

  afterAll(async () => {
    await db().delete(schema.anchorLeaf);
    await db().delete(schema.anchorBatch);
    if (versionIds.length > 0) {
      await db()
        .update(schema.asset)
        .set({ currentVersionId: null })
        .where(inArray(schema.asset.id, assetIds));
      await db().delete(schema.assetVersion).where(inArray(schema.assetVersion.id, versionIds));
    }
    if (assetIds.length > 0) {
      await db().delete(schema.asset).where(inArray(schema.asset.id, assetIds));
    }
    await db().delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
  });

  it('plans one batch over the versions that were never anchored', async () => {
    const versionId = await publishedVersion({ slug: 'plan' });
    const signer = fakeSigner();

    const result = await anchorPublishedVersions({ signer });

    expect(result.planned).toBeGreaterThanOrEqual(1);
    expect(result.submitted).toBe(1);
    const [batch] = await batches();
    expect(batch?.status).toBe('submitted');
    expect(batch?.merkleRoot).toMatch(/^[0-9a-f]{64}$/);

    const leaves = await db()
      .select({ subjectId: schema.anchorLeaf.subjectId })
      .from(schema.anchorLeaf);
    expect(leaves.map((leaf) => leaf.subjectId)).toContain(versionId);
  });

  /* The rule the mempool taught us: one signing account, one transaction. */
  it('will not submit while another transaction is in flight', async () => {
    await publishedVersion({ slug: 'inflight-a' });
    const signer = fakeSigner();
    signer.outcome = 'pending';

    await anchorPublishedVersions({ signer });
    expect(signer.submissions).toHaveLength(1);

    /* A second subject with work to do, and a fresh budget: still nothing. */
    await anchorAuditHead({ signer });
    expect(signer.submissions).toHaveLength(1);
  });

  it('confirms and backfills proofs that verify against the root', async () => {
    await publishedVersion({ slug: 'proofs-a' });
    await publishedVersion({ slug: 'proofs-b' });
    await publishedVersion({ slug: 'proofs-c' });
    const signer = fakeSigner();
    signer.outcome = 'pending';
    await anchorPublishedVersions({ signer });

    signer.outcome = 'confirmed';
    const confirmed = await anchorPublishedVersions({ signer });
    expect(confirmed.confirmed).toBe(1);

    const [batch] = await batches();
    expect(batch?.status).toBe('confirmed');
    const leaves = await db()
      .select({ hash: schema.anchorLeaf.leafHash, proof: schema.anchorLeaf.merkleProof })
      .from(schema.anchorLeaf);
    expect(leaves.length).toBeGreaterThanOrEqual(3);
    for (const leaf of leaves) {
      expect(await verifyAnchorProof(leaf.hash, leaf.proof ?? [], batch?.merkleRoot as string)).toBe(
        true,
      );
    }
  });

  /* Idempotence is the unique index, not anything this remembers. */
  it('does not anchor the same version twice', async () => {
    await publishedVersion({ slug: 'once' });
    const signer = fakeSigner();
    await anchorPublishedVersions({ signer });
    await anchorPublishedVersions({ signer });

    const rows = await db()
      .select({ subjectId: schema.anchorLeaf.subjectId })
      .from(schema.anchorLeaf);
    expect(new Set(rows.map((row) => row.subjectId)).size).toBe(rows.length);
  });

  /*
   * Proposal 2.1 budgets one version transaction an hour, and the guard keys
   * off the window rather than the clock. That is what lets a backlog drain:
   * versions published days ago produce a batch whose window closed days ago,
   * so the next one starts immediately instead of taking an hour per batch to
   * catch up.
   */
  it('does not throttle while draining a backlog', async () => {
    await publishedVersion({ slug: 'backlog-a', publishedAt: new Date('2026-01-10T00:00:00Z') });
    const signer = fakeSigner();
    await anchorPublishedVersions({ signer });

    await publishedVersion({ slug: 'backlog-b', publishedAt: new Date('2026-01-11T00:00:00Z') });
    await anchorPublishedVersions({ signer }); // confirms the first
    const next = await anchorPublishedVersions({ signer });

    expect(next.skipped).toBeNull();
    expect(next.planned).toBeGreaterThanOrEqual(1);
  });

  /* Caught up, it goes back to one an hour. */
  it('waits out the interval once the window is current', async () => {
    await publishedVersion({ slug: 'cadence-a', publishedAt: new Date() });
    const signer = fakeSigner();
    await anchorPublishedVersions({ signer });

    await publishedVersion({ slug: 'cadence-b', publishedAt: new Date() });
    const confirming = await anchorPublishedVersions({ signer });
    expect(confirming.confirmed).toBe(1);
    expect(confirming.planned).toBe(0);

    const third = await anchorPublishedVersions({ signer });
    expect(third.skipped).toBe('too_soon');
    expect(third.planned).toBe(0);
  });

  it('counts attempts and gives up after enough of them', async () => {
    await publishedVersion({ slug: 'retry' });
    const signer = fakeSigner();
    signer.failSubmit = true;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await anchorPublishedVersions({ signer });
    }

    const [batch] = await batches();
    expect(batch?.attempts).toBe(5);
    expect(batch?.status).toBe('failed');
    expect(signer.submissions).toHaveLength(0);
  });

  /*
   * An abort is not a retry: the identical payload would abort identically, so
   * the batch is over and the subjects wait for a re-anchor (proposal 4.5.1).
   */
  it('gives up immediately when the chain aborts the transaction', async () => {
    await publishedVersion({ slug: 'abort' });
    const signer = fakeSigner();
    signer.outcome = 'pending';
    await anchorPublishedVersions({ signer });

    signer.outcome = 'failed';
    const result = await anchorPublishedVersions({ signer });

    expect(result.failed).toBe(1);
    const [batch] = await batches();
    expect(batch?.status).toBe('failed');
    expect(batch?.attempts).toBe(1);
  });

  describe('audit head', () => {
    it('anchors the previous UTC day once, keyed by its date', async () => {
      const signer = fakeSigner();
      const now = new Date('2026-03-05T09:00:00Z');

      const first = await anchorAuditHead({ signer, now });
      /* An empty audit log has no head to commit to, and anchors nothing. */
      if (first.skipped === 'nothing_due') return;

      const leaves = await db()
        .select({ subjectId: schema.anchorLeaf.subjectId })
        .from(schema.anchorLeaf)
        .where(eq(schema.anchorLeaf.subjectType, 'audit_head'));
      expect(leaves[0]?.subjectId).toBe('2026-03-04');

      const second = await anchorAuditHead({ signer, now });
      expect(second.planned).toBe(0);
    });
  });

  it('shares one submission across the subjects in a tick', async () => {
    await publishedVersion({ slug: 'tick' });
    const signer = fakeSigner();
    signer.outcome = 'pending';

    await runAnchorTick({ signer });

    expect(signer.submissions).toHaveLength(1);
  });


  /* The operator's one move over anchoring (architecture.md 14). */
  describe('releasing a failed batch', () => {
    async function failedBatch(slug: string): Promise<string> {
      await publishedVersion({ slug });
      const signer = fakeSigner();
      signer.failSubmit = true;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await anchorPublishedVersions({ signer });
      }
      const [batch] = await batches();
      expect(batch?.status).toBe('failed');
      return batch?.id as string;
    }

    it('puts its subjects back in the queue', async () => {
      const batchId = await failedBatch('release-me');

      const released = await releaseFailedBatch({ batchId });
      expect(released.released).toBeGreaterThanOrEqual(1);

      const rows = await batches();
      expect(rows.find((row) => row.id === batchId)?.status).toBe('superseded');
      /* The row stays; the leaves are what had to go, because their uniqueness
         is what kept the workflow from picking the subjects up again. */
      expect(await db().select().from(schema.anchorLeaf)).toHaveLength(0);

      /* Past the cadence window, so the interval guard is not what answers. */
      const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const again = await anchorPublishedVersions({ signer: fakeSigner(), now: later });
      expect(again.planned).toBeGreaterThanOrEqual(1);
      expect(again.submitted).toBe(1);
    });

    /* A confirmed batch's leaves are what a third party checks. */
    it('refuses a batch that landed', async () => {
      await publishedVersion({ slug: 'release-confirmed' });
      const signer = fakeSigner();
      signer.outcome = 'pending';
      await anchorPublishedVersions({ signer });
      signer.outcome = 'confirmed';
      await anchorPublishedVersions({ signer });

      const [batch] = await batches();
      expect(batch?.status).toBe('confirmed');
      await expect(releaseFailedBatch({ batchId: batch?.id as string })).rejects.toBeInstanceOf(
        AdminChangeRefused,
      );
    });

    it('refuses a batch it has never heard of', async () => {
      await expect(
        releaseFailedBatch({ batchId: crypto.randomUUID() }),
      ).rejects.toBeInstanceOf(AdminChangeRefused);
    });
  });
});

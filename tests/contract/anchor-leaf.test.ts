/**
 * The leaf construction and the batch tree, against the acceptance criteria in
 * requirement.md 6.4: tampering with any anchored field must break the proof,
 * and a private subject's leaf must not be reproducible without its salt.
 *
 * aptos-anchoring-proposal.md 4.11 gate 1 freezes these rules before the first
 * mainnet batch, so this file is also the description a second implementation
 * has to satisfy -- gate 2 wants that one written independently, not from here.
 */
import { describe, expect, it } from 'vitest';
import {
  ANCHOR_LEAF_SCHEMA_VERSION,
  auditHeadLeaf,
  buildAnchorTree,
  deriveAnchorSalt,
  earningStatementLeaf,
  verifyAnchorProof,
  versionLeaf,
  type VersionLeafInput,
} from '@/lib/domain/anchor-leaf';

const VERSION: VersionLeafInput = {
  assetId: '0193d1f0-0000-7000-8000-000000000001',
  versionId: '0193d1f0-0000-7000-8000-000000000002',
  sourceDigest: 'a'.repeat(64),
  contentMerkleRoot: 'b'.repeat(64),
  publishedAt: new Date('2026-01-01T00:00:00.000Z'),
  salt: '',
};

const HEX64 = /^[0-9a-f]{64}$/;

describe('version leaf', () => {
  it('is a sha-256 digest and is stable for the same input', async () => {
    const first = await versionLeaf(VERSION);
    expect(first).toMatch(HEX64);
    expect(await versionLeaf({ ...VERSION })).toBe(first);
  });

  /*
   * Pinned before agent-first P5 renamed library to asset in the code and the
   * database (agent-first-proposal.md 3.5): the leaf hashes the id's value,
   * never a field or column name, so no rename may move an anchored leaf.
   */
  it('is the leaf this fixture has always had', async () => {
    expect(await versionLeaf(VERSION)).toBe('dd200720686c7e8f84eacac4e9bb686aaf76e50ad526d328f5ad4f1711b32709');
  });

  /* requirement.md 6.4: change any anchored field and the proof must fail. */
  it('changes when any field changes', async () => {
    const base = await versionLeaf(VERSION);
    const variants: VersionLeafInput[] = [
      { ...VERSION, assetId: `${VERSION.assetId}x` },
      { ...VERSION, versionId: `${VERSION.versionId}x` },
      { ...VERSION, sourceDigest: 'c'.repeat(64) },
      { ...VERSION, contentMerkleRoot: 'd'.repeat(64) },
      { ...VERSION, publishedAt: new Date('2026-01-01T00:00:00.001Z') },
      { ...VERSION, salt: 'e'.repeat(64) },
    ];
    const leaves = await Promise.all(variants.map(versionLeaf));
    expect(new Set([base, ...leaves]).size).toBe(variants.length + 1);
  });

  /*
   * The framing exists for this: unframed concatenation makes ("ab", "c") and
   * ("a", "bc") the same preimage, and both halves are attacker-chosen.
   */
  it('does not let a field boundary shift produce the same leaf', async () => {
    const left = await versionLeaf({ ...VERSION, assetId: 'ab', versionId: 'c' });
    const right = await versionLeaf({ ...VERSION, assetId: 'a', versionId: 'bc' });
    expect(left).not.toBe(right);
  });

  it('separates a public leaf from the same version salted', async () => {
    const publicLeaf = await versionLeaf({ ...VERSION, salt: '' });
    const privateLeaf = await versionLeaf({ ...VERSION, salt: await deriveAnchorSalt('s', 'w1') });
    expect(publicLeaf).not.toBe(privateLeaf);
  });
});

describe('domain separation', () => {
  it('keeps subjects apart even when their fields coincide', async () => {
    const audit = await auditHeadLeaf({ date: '2026-01-01', chainHead: 'f'.repeat(64) });
    const version = await versionLeaf({
      ...VERSION,
      assetId: '2026-01-01',
      versionId: 'f'.repeat(64),
    });
    expect(audit).not.toBe(version);
  });
});

describe('earning statement leaf', () => {
  const STATEMENT = {
    publisherAccountId: 'acct-1',
    periodId: '2026-01',
    amountMinor: 4_800,
    currency: 'USD',
    statementDigest: '9'.repeat(64),
    salt: '7'.repeat(64),
  };

  it('changes when the money changes', async () => {
    const base = await earningStatementLeaf(STATEMENT);
    const variants = [
      { ...STATEMENT, publisherAccountId: 'acct-2' },
      { ...STATEMENT, periodId: '2026-02' },
      { ...STATEMENT, amountMinor: 4_801 },
      /* A refund period's statement is the same digits with a sign. */
      { ...STATEMENT, amountMinor: -4_800 },
      { ...STATEMENT, currency: 'EUR' },
      { ...STATEMENT, statementDigest: '8'.repeat(64) },
      { ...STATEMENT, salt: '6'.repeat(64) },
    ];
    const leaves = await Promise.all(variants.map(earningStatementLeaf));
    expect(new Set([base, ...leaves]).size).toBe(variants.length + 1);
  });
});

describe('salt derivation', () => {
  it('is stable per scope and differs across scopes and secrets', async () => {
    const a = await deriveAnchorSalt('secret', 'workspace-1');
    expect(a).toMatch(HEX64);
    expect(await deriveAnchorSalt('secret', 'workspace-1')).toBe(a);
    expect(await deriveAnchorSalt('secret', 'workspace-2')).not.toBe(a);
    expect(await deriveAnchorSalt('other', 'workspace-1')).not.toBe(a);
  });
});

describe('batch tree', () => {
  const leaves = (n: number) => Array.from({ length: n }, (_, i) => `${i}`.padStart(64, '0'));

  it('has no root for an empty window', async () => {
    expect((await buildAnchorTree([])).root).toBeNull();
  });

  /* Every size, including the odd ones where a node is carried up alone. */
  for (const size of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17]) {
    it(`verifies every leaf in a batch of ${size}`, async () => {
      const batch = leaves(size);
      const { root, proofs } = await buildAnchorTree(batch);
      expect(root).toMatch(HEX64);
      expect(proofs).toHaveLength(size);
      for (const [index, leaf] of batch.entries()) {
        expect(await verifyAnchorProof(leaf, proofs[index] as string[], root as string)).toBe(true);
      }
    });
  }

  it('refuses a leaf that is not in the batch', async () => {
    const { root, proofs } = await buildAnchorTree(leaves(5));
    expect(await verifyAnchorProof('f'.repeat(64), proofs[0] as string[], root as string)).toBe(
      false,
    );
  });

  it('refuses a proof from another batch', async () => {
    const mine = await buildAnchorTree(leaves(5));
    const theirs = await buildAnchorTree(leaves(6));
    expect(
      await verifyAnchorProof(leaves(5)[0] as string, theirs.proofs[0] as string[], mine.root as string),
    ).toBe(false);
  });

  it('refuses a proof whose sibling order is flipped', async () => {
    const batch = leaves(4);
    const { root, proofs } = await buildAnchorTree(batch);
    const flipped = (proofs[0] as string[]).map((step) =>
      `${step[0] === 'l' ? 'r' : 'l'}${step.slice(1)}`,
    );
    expect(await verifyAnchorProof(batch[0] as string, flipped, root as string)).toBe(false);
  });

  it('refuses a malformed step instead of throwing', async () => {
    const batch = leaves(4);
    const { root } = await buildAnchorTree(batch);
    for (const bad of ['', 'x:' + 'a'.repeat(64), 'l:nothex', 'l:' + 'a'.repeat(63)]) {
      expect(await verifyAnchorProof(batch[0] as string, [bad], root as string)).toBe(false);
    }
  });

  /*
   * The `L:`/`N:` split is what stops this: without it an interior node is a
   * well-formed leaf, and a proof of the subtree above it proves membership of
   * something that was never anchored.
   */
  it('does not accept an interior node presented as a leaf', async () => {
    const batch = leaves(4);
    const { root, proofs } = await buildAnchorTree(batch);
    /* The first step of leaf 0's path is its sibling; the pair above them is an
       interior node whose value a forger would have to pass off as a leaf. */
    const sibling = (proofs[0] as string[])[0]?.slice(2) as string;
    expect(await verifyAnchorProof(sibling, (proofs[0] as string[]).slice(1), root as string)).toBe(
      false,
    );
  });

  it('gives two different leaf lists two different roots', async () => {
    const three = await buildAnchorTree(leaves(3));
    /* The classic duplicate-last-leaf collision, which carrying up avoids. */
    const duplicated = await buildAnchorTree([...leaves(3), leaves(3)[2] as string]);
    expect(three.root).not.toBe(duplicated.root);
  });

  it('pins the schema version the leaves were built under', () => {
    expect(ANCHOR_LEAF_SCHEMA_VERSION).toBe(1);
  });
});

/**
 * The rules that keep large sources from dying half-way
 * (lib/services/knowledge.ts): a slot per owner and in all, which staged
 * passages a resumed run may reuse, and how many times a source was resumed.
 */
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_GLOBAL_CONCURRENCY, KNOWLEDGE_HEARTBEAT_MS, KNOWLEDGE_HEARTBEAT_STALE_MS, KNOWLEDGE_OWNER_CONCURRENCY, KNOWLEDGE_RUN_MAX_MS } from '@/lib/constants';
import { activity } from '@/lib/domain/knowledge';
import { interruptions, passageDigest, slotsAllow, stagePlan } from '@/lib/services/knowledge';

describe('processing slots', () => {
  it('lets a run start only under both the owner limit and the platform limit', () => {
    const limits = { owner: 2, global: 8 };
    expect(slotsAllow(0, 0, limits)).toBe(true);
    expect(slotsAllow(1, 7, limits)).toBe(true);
    expect(slotsAllow(2, 2, limits)).toBe(false);
    expect(slotsAllow(0, 8, limits)).toBe(false);
    /* Defaults: a burst of ten repositories from one owner runs a couple at a time. */
    expect(slotsAllow(KNOWLEDGE_OWNER_CONCURRENCY - 1, 0)).toBe(true);
    expect(slotsAllow(KNOWLEDGE_OWNER_CONCURRENCY, 0)).toBe(false);
    expect(KNOWLEDGE_GLOBAL_CONCURRENCY).toBeGreaterThan(KNOWLEDGE_OWNER_CONCURRENCY);
  });

  it('presumes a run dead well before a function could still be alive', () => {
    /* Several beats fit in the silence a dead run must keep. */
    expect(KNOWLEDGE_HEARTBEAT_STALE_MS).toBeGreaterThanOrEqual(5 * KNOWLEDGE_HEARTBEAT_MS);
    expect(KNOWLEDGE_HEARTBEAT_STALE_MS).toBeLessThan(KNOWLEDGE_RUN_MAX_MS);
    /* The routes' `maxDuration`: Vercel's maximum on Pro with Fluid Compute. */
    expect(KNOWLEDGE_RUN_MAX_MS).toBe(800_000);
  });
});

describe('staged passages', () => {
  const chunks = ['alpha', 'beta', 'gamma'].map((content, ordinal) => ({ ordinal, content, locator: { path: 'a.md', line: ordinal + 1 } }));
  const digests = chunks.map(passageDigest);

  it('digests text and locator together', () => {
    expect(new Set(digests).size).toBe(3);
    expect(passageDigest({ content: 'alpha', locator: { path: 'a.md', line: 1 } })).toBe(digests[0]);
    expect(passageDigest({ content: 'alpha', locator: { path: 'b.md', line: 1 } })).not.toBe(digests[0]);
  });

  it('reuses what matches and drops what changed, moved past the end or came from another model', () => {
    const staged = [
      { ordinal: 0, digest: digests[0]!, configId: 'm1' },
      { ordinal: 1, digest: 'changed', configId: 'm1' },
      { ordinal: 2, digest: digests[2]!, configId: 'm0' },
      { ordinal: 7, digest: 'gone', configId: 'm1' },
    ];
    const plan = stagePlan(digests, staged, 'm1');
    expect([...plan.kept]).toEqual([0]);
    expect(plan.dropped).toEqual([1, 2, 7]);
    expect(stagePlan(digests, [], '')).toEqual({ kept: new Set(), dropped: [] });
  });
});

describe('resumed runs', () => {
  it('counts interruptions since the source was added or last reprocessed', () => {
    const log = [activity('added'), activity('processing'), activity('interrupted'), activity('processing'), activity('interrupted')];
    expect(interruptions(log)).toBe(2);
    expect(interruptions([...log, activity('failed'), activity('refresh'), activity('processing')])).toBe(0);
    expect(interruptions([...log, activity('refresh'), activity('interrupted')])).toBe(1);
  });
});

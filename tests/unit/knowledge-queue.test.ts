/**
 * The rules that keep large sources from dying half-way
 * (lib/services/knowledge.ts): a slot per owner and in all, which staged
 * passages a resumed run may reuse, and how many times a source was resumed.
 */
import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_CLAIM_WINDOW_MS, KNOWLEDGE_HEARTBEAT_MS, KNOWLEDGE_HEARTBEAT_STALE_MS, KNOWLEDGE_RUN_MAX_MS, KNOWLEDGE_SLOT_POOLS } from '@/lib/constants';
import { activity } from '@/lib/domain/knowledge';
import { claimOpen, extractToStore, fairQueue, interruptions, passageDigest, slotPool, slotsAllow, stagePlan, type WaitingSource } from '@/lib/services/knowledge';

describe('processing slots', () => {
  it('lets a run start only under both the owner limit and the platform limit', () => {
    const limits = { owner: 2, global: 8 };
    expect(slotsAllow(0, 0, limits)).toBe(true);
    expect(slotsAllow(1, 7, limits)).toBe(true);
    expect(slotsAllow(2, 2, limits)).toBe(false);
    expect(slotsAllow(0, 8, limits)).toBe(false);
    for (const pool of Object.values(KNOWLEDGE_SLOT_POOLS)) expect(pool.global).toBeGreaterThan(pool.owner);
  });

  it('puts every kind that can run for minutes in a pool, and never the quick ones', () => {
    expect(slotPool('github')).toBe('crawl');
    expect(slotPool('site')).toBe('crawl');
    expect(slotPool('audio')).toBe('file');
    expect(slotPool('document')).toBe('file');
    expect(slotPool('text')).toBeNull();
    expect(slotPool('page')).toBeNull();
  });

  it('presumes a run dead well before a function could still be alive', () => {
    /* Several beats fit in the silence a dead run must keep. */
    expect(KNOWLEDGE_HEARTBEAT_STALE_MS).toBeGreaterThanOrEqual(5 * KNOWLEDGE_HEARTBEAT_MS);
    expect(KNOWLEDGE_HEARTBEAT_STALE_MS).toBeLessThan(KNOWLEDGE_RUN_MAX_MS);
    /* The routes' `maxDuration`: Vercel's maximum on Pro with Fluid Compute. */
    expect(KNOWLEDGE_RUN_MAX_MS).toBe(800_000);
  });

  it('claims no new run once the claim window has passed, leaving a run time to finish', () => {
    const start = Date.parse('2026-11-12T00:00:00Z');
    expect(claimOpen(start, start)).toBe(true);
    expect(claimOpen(start, start + KNOWLEDGE_CLAIM_WINDOW_MS - 1)).toBe(true);
    expect(claimOpen(start, start + KNOWLEDGE_CLAIM_WINDOW_MS)).toBe(false);
    expect(KNOWLEDGE_RUN_MAX_MS - KNOWLEDGE_CLAIM_WINDOW_MS).toBeGreaterThanOrEqual(12 * 60_000);
  });
});

describe('the queue', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  /** `owner`'s waiting sources of one kind, oldest first, numbered as the query numbers them. */
  const backlog = (owner: string, kind: string, count: number, since = 60): WaitingSource[] =>
    Array.from({ length: count }, (_, at) => ({ id: `${owner}-${kind}-${at + 1}`, kind, ownerId: owner, createdAt: minutesAgo(since - at), updatedAt: minutesAgo(since - at), place: at + 1 }));

  it('gives every owner a turn: a long backlog does not hide a newer owner', () => {
    const waiting = [...backlog('a', 'github', 30, 120), ...backlog('b', 'github', 1, 5)];
    /* `a` may start two (its limit), `b` one; `a`'s 3rd..30th are not offered at all. */
    expect(fairQueue(waiting, [], 20, now)).toEqual(['a-github-1', 'b-github-1', 'a-github-2']);
    /* With `a` already running two, only `b` is offered. */
    expect(fairQueue(waiting, [{ ownerId: 'a', kind: 'github', n: 2 }], 20, now)).toEqual(['b-github-1']);
  });

  it('keeps pools apart, and offers no pool more than the platform has free', () => {
    const waiting = [...backlog('a', 'github', 3), ...backlog('a', 'audio', 5), ...backlog('c', 'site', 1)];
    expect(new Set(fairQueue(waiting, [], 20, now))).toEqual(new Set(['a-github-1', 'a-audio-1', 'c-site-1', 'a-github-2', 'a-audio-2', 'a-audio-3']));
    const busy = [{ ownerId: 'x', kind: 'github', n: KNOWLEDGE_SLOT_POOLS.crawl.global - 1 }];
    expect(fairQueue(waiting, busy, 20, now).filter((id) => !id.includes('audio'))).toEqual(['a-github-1']);
  });

  it('offers a quick kind only once its own run has had a minute to take it', () => {
    const fresh = { id: 'fresh', kind: 'text', ownerId: 'a', createdAt: now, updatedAt: now, place: 1 };
    const missed = { id: 'missed', kind: 'text', ownerId: 'a', createdAt: minutesAgo(2), updatedAt: minutesAgo(2), place: 2 };
    expect(fairQueue([fresh, missed], [], 20, now)).toEqual(['missed']);
  });

  it('stops at the batch size', () => {
    const waiting = Array.from({ length: 30 }, (_, at) => backlog(`owner${at}`, 'document', 1)[0]!);
    expect(fairQueue(waiting, [], 20, now)).toHaveLength(12);
    expect(fairQueue(waiting, [], 5, now)).toHaveLength(5);
  });
});

describe('what a resumed run reads back', () => {
  const extracted = { sections: [{ text: 'x'.repeat(100), locator: {} }], log: [], pin: { revision: 'abc', scope: { owner: 'acme', name: 'docs' } } };

  it('keeps the whole extraction when it fits, else only the commit to read again', () => {
    expect(extractToStore(extracted)).toEqual({ full: extracted });
    expect(extractToStore(extracted, 50)).toEqual({ pin: extracted.pin });
    expect(extractToStore({ sections: extracted.sections, log: [] }, 50)).toBeNull();
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

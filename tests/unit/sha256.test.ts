import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ResumableSha256 } from '@/lib/domain/sha256';

const node = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('resumable SHA-256', () => {
  it('matches node for lengths around the block and padding edges', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000]) {
      const bytes = randomBytes(length);
      expect(new ResumableSha256().update(bytes).hex()).toBe(node(bytes));
    }
  });

  it('carries over between saves at any cut, as stitching a file a step at a time does', () => {
    const bytes = randomBytes(300_001);
    for (const cuts of [[1], [63, 64, 65], [4096, 8192], [100_000, 200_000, 300_000]]) {
      let state: string | null = null;
      let from = 0;
      for (const cut of [...cuts, bytes.length]) {
        const hash = new ResumableSha256(state).update(bytes.subarray(from, cut));
        state = hash.save();
        from = cut;
      }
      expect(new ResumableSha256(state).hex()).toBe(node(bytes));
    }
  });

  it('is fast enough for 100 MB in one stitching budget', () => {
    const chunk = randomBytes(8 * 1024 * 1024);
    const started = Date.now();
    const hash = new ResumableSha256();
    for (let i = 0; i < 4; i += 1) hash.update(chunk);
    hash.hex();
    /* 32 MB here; the cron and requests share 100 MB over many steps. */
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

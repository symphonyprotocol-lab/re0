/**
 * Which uploads a sweep may delete (architecture.md 7, `uploads/`): old and
 * unreferenced, and nothing else. The store and the database are not here;
 * the decision is.
 */
import { describe, expect, it } from 'vitest';
import { ABANDONED_UPLOAD_AGE_MS, abandonedUploadKeys } from '@/lib/domain/asset';

const NOW = Date.parse('2026-09-05T12:00:00Z');
const old = new Date(NOW - ABANDONED_UPLOAD_AGE_MS - 1);
const fresh = new Date(NOW - 60_000);

describe('abandonedUploadKeys', () => {
  it('deletes only what is both old and unreferenced', () => {
    const keys = abandonedUploadKeys(
      [
        { key: 'uploads/ws/b1/old-orphan.pdf', uploadedAt: old },
        { key: 'uploads/ws/b1/old-kept.pdf', uploadedAt: old },
        { key: 'uploads/ws/b2/fresh-orphan.pdf', uploadedAt: fresh },
      ],
      new Set(['uploads/ws/b1/old-kept.pdf']),
      NOW,
    );
    expect(keys).toEqual(['uploads/ws/b1/old-orphan.pdf']);
  });

  it('keeps an object whose age the store does not report', () => {
    expect(
      abandonedUploadKeys([{ key: 'uploads/ws/b/x.pdf', uploadedAt: null }], new Set(), NOW),
    ).toEqual([]);
  });

  it('honours a custom grace period', () => {
    expect(
      abandonedUploadKeys([{ key: 'uploads/ws/b/x.pdf', uploadedAt: fresh }], new Set(), NOW, 1_000),
    ).toEqual(['uploads/ws/b/x.pdf']);
  });
});

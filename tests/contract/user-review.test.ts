/**
 * The rules behind a user asset's lifecycle after a build and under the
 * platform's hand. requirement.md 6.2 and 7.4: a build publishes an asset
 * in a channel or not (2026-10-23), the platform may suspend and restore,
 * and a suspension is not undone by a rebuild.
 */
import { describe, expect, it } from 'vitest';
import {
  lifecycleAfterBuild,
  reviewActionAvailable,
  reviewTarget,
} from '@/lib/domain/asset';

describe('lifecycleAfterBuild', () => {
  it('publishes a user asset, in a channel or not', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', isPlatformAsset: false })).toBe('published');
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', isPlatformAsset: false })).toBe('published');
    /* An asset the review era left waiting goes live on its next build too. */
    expect(lifecycleAfterBuild({ lifecycleStatus: 'changes_requested', isPlatformAsset: false })).toBe('published');
    expect(lifecycleAfterBuild({ lifecycleStatus: 'submitted', isPlatformAsset: false })).toBe('published');
  });

  it('leaves a published asset alone', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'published', isPlatformAsset: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'published', isPlatformAsset: false })).toBeNull();
  });

  it('never lifts a suspension, and never touches a platform asset', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'suspended', isPlatformAsset: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'suspended', isPlatformAsset: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'archived', isPlatformAsset: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', isPlatformAsset: true })).toBeNull();
  });
});

describe('reviewActionAvailable', () => {
  it('suspends a live asset and restores a suspended one', () => {
    expect(reviewActionAvailable('published', 'reject')).toBe(true);
    expect(reviewActionAvailable('published', 'approve')).toBe(false);
    expect(reviewActionAvailable('suspended', 'approve')).toBe(true);
    expect(reviewActionAvailable('suspended', 'reject')).toBe(false);
  });

  it('decides nothing about a draft or an archived asset', () => {
    for (const action of ['approve', 'reject'] as const) {
      expect(reviewActionAvailable('draft', action)).toBe(false);
      expect(reviewActionAvailable('archived', action)).toBe(false);
    }
  });

  it('lands each verb where the enum can express it', () => {
    expect(reviewTarget('approve')).toBe('published');
    expect(reviewTarget('reject')).toBe('suspended');
  });
});

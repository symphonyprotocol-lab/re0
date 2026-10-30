/**
 * The rules behind a user library's lifecycle after a build and under the
 * platform's hand. requirement.md 6.2 and 7.4: a build publishes an asset
 * in a channel or not (2026-10-23), the platform may suspend and restore,
 * and a suspension is not undone by a rebuild.
 */
import { describe, expect, it } from 'vitest';
import {
  lifecycleAfterBuild,
  reviewActionAvailable,
  reviewTarget,
} from '@/lib/domain/library';

describe('lifecycleAfterBuild', () => {
  it('publishes a user library, in a channel or not', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', isPlatformLibrary: false })).toBe('published');
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', isPlatformLibrary: false })).toBe('published');
    /* A library the review era left waiting goes live on its next build too. */
    expect(lifecycleAfterBuild({ lifecycleStatus: 'changes_requested', isPlatformLibrary: false })).toBe('published');
    expect(lifecycleAfterBuild({ lifecycleStatus: 'submitted', isPlatformLibrary: false })).toBe('published');
  });

  it('leaves a published library alone', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'published', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'published', isPlatformLibrary: false })).toBeNull();
  });

  it('never lifts a suspension, and never touches a platform library', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'suspended', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'suspended', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'archived', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', isPlatformLibrary: true })).toBeNull();
  });
});

describe('reviewActionAvailable', () => {
  it('suspends a live library and restores a suspended one', () => {
    expect(reviewActionAvailable('published', 'reject')).toBe(true);
    expect(reviewActionAvailable('published', 'approve')).toBe(false);
    expect(reviewActionAvailable('suspended', 'approve')).toBe(true);
    expect(reviewActionAvailable('suspended', 'reject')).toBe(false);
  });

  it('decides nothing about a draft or an archived library', () => {
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

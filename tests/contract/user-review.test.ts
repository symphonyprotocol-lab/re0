/**
 * The rules behind a user library's lifecycle after a build and under the
 * platform's hand. requirement.md 6.2 and 7.4: a build publishes under
 * either visibility (2026-10-23), the platform may suspend and restore,
 * and a suspension is not undone by a rebuild.
 */
import { describe, expect, it } from 'vitest';
import {
  lifecycleAfterBuild,
  reviewActionAvailable,
  reviewTarget,
} from '@/lib/domain/library';

describe('lifecycleAfterBuild', () => {
  it('publishes a user library under either visibility', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', visibility: 'private', isPlatformLibrary: false })).toBe('published');
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', visibility: 'public', isPlatformLibrary: false })).toBe('published');
    /* A library the review era left waiting goes live on its next build too. */
    expect(lifecycleAfterBuild({ lifecycleStatus: 'changes_requested', visibility: 'public', isPlatformLibrary: false })).toBe('published');
    expect(lifecycleAfterBuild({ lifecycleStatus: 'submitted', visibility: 'public', isPlatformLibrary: false })).toBe('published');
  });

  it('leaves a published library alone', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'published', visibility: 'public', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'published', visibility: 'private', isPlatformLibrary: false })).toBeNull();
  });

  it('never lifts a suspension, and never touches a platform library', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'suspended', visibility: 'private', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'suspended', visibility: 'public', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'archived', visibility: 'public', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', visibility: 'public', isPlatformLibrary: true })).toBeNull();
  });
});

describe('reviewActionAvailable', () => {
  it('suspends a live library and restores a suspended one, whatever the visibility', () => {
    for (const visibility of ['public', 'private'] as const) {
      expect(reviewActionAvailable('published', visibility, 'reject')).toBe(true);
      expect(reviewActionAvailable('published', visibility, 'approve')).toBe(false);
      expect(reviewActionAvailable('suspended', visibility, 'approve')).toBe(true);
      expect(reviewActionAvailable('suspended', visibility, 'reject')).toBe(false);
    }
  });

  it('decides nothing about a draft or an archived library', () => {
    for (const action of ['approve', 'reject'] as const) {
      expect(reviewActionAvailable('draft', 'public', action)).toBe(false);
      expect(reviewActionAvailable('archived', 'public', action)).toBe(false);
    }
  });

  it('lands each verb where the enum can express it', () => {
    expect(reviewTarget('approve')).toBe('published');
    expect(reviewTarget('reject')).toBe('suspended');
  });
});

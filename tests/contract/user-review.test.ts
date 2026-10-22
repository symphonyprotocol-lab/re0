/**
 * The rules behind a user library's lifecycle after a build and under
 * review. requirement.md 6.2 and 7.4: private is never reviewed, public
 * waits for a person, and a reviewer's decision is not undone by a rebuild.
 */
import { describe, expect, it } from 'vitest';
import {
  lifecycleAfterBuild,
  reviewActionAvailable,
  reviewTarget,
} from '@/lib/domain/library';

describe('lifecycleAfterBuild', () => {
  it('publishes a private library and leaves a public one for its owner to submit', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', visibility: 'private', isPlatformLibrary: false })).toBe('published');
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', visibility: 'public', isPlatformLibrary: false })).toBeNull();
  });

  it('does not resubmit a public library sent back for changes, and leaves a reviewed one alone', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'changes_requested', visibility: 'public', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'submitted', visibility: 'public', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'published', visibility: 'public', isPlatformLibrary: false })).toBeNull();
  });

  it('never lifts a suspension, and never touches a platform library', () => {
    expect(lifecycleAfterBuild({ lifecycleStatus: 'suspended', visibility: 'private', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'suspended', visibility: 'public', isPlatformLibrary: false })).toBeNull();
    expect(lifecycleAfterBuild({ lifecycleStatus: 'draft', visibility: 'public', isPlatformLibrary: true })).toBeNull();
  });
});

describe('reviewActionAvailable', () => {
  it('offers the three verbs over a public library waiting for review', () => {
    expect(reviewActionAvailable('submitted', 'public', 'approve')).toBe(true);
    expect(reviewActionAvailable('submitted', 'public', 'request_changes')).toBe(true);
    expect(reviewActionAvailable('submitted', 'public', 'reject')).toBe(true);
  });

  it('does not offer the state a library is already in', () => {
    expect(reviewActionAvailable('published', 'public', 'approve')).toBe(false);
    expect(reviewActionAvailable('changes_requested', 'public', 'request_changes')).toBe(false);
    expect(reviewActionAvailable('suspended', 'public', 'reject')).toBe(false);
    expect(reviewActionAvailable('suspended', 'public', 'approve')).toBe(true);
  });

  it('offers only a pause and its lifting over a private library', () => {
    expect(reviewActionAvailable('published', 'private', 'reject')).toBe(true);
    expect(reviewActionAvailable('published', 'private', 'request_changes')).toBe(false);
    expect(reviewActionAvailable('suspended', 'private', 'approve')).toBe(true);
    expect(reviewActionAvailable('suspended', 'private', 'reject')).toBe(false);
  });

  it('decides nothing about a draft or an archived library', () => {
    for (const action of ['approve', 'request_changes', 'reject'] as const) {
      expect(reviewActionAvailable('draft', 'public', action)).toBe(false);
      expect(reviewActionAvailable('archived', 'public', action)).toBe(false);
    }
  });

  it('lands each verb where the enum can express it', () => {
    expect(reviewTarget('approve')).toBe('published');
    expect(reviewTarget('request_changes')).toBe('changes_requested');
    expect(reviewTarget('reject')).toBe('suspended');
  });
});

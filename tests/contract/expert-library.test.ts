/**
 * The rules behind the expert tag (expert-library-prd.md 4): who may apply,
 * what an approval re-checks, where each verb lands, and the one revenue
 * rule every call is judged by.
 */
import { describe, expect, it } from 'vitest';
import { isRevenueEligible } from '@/lib/domain';
import { roleAllows } from '@/lib/domain/admin';
import {
  applicationBlocker,
  approvalAllowed,
  approvalChecks,
  EXPERT_NOTE_MAX_LENGTH,
  EXPERT_REAPPLY_COOLDOWN_MS,
  expertChecks,
  expertEarning,
  nextExpertStatus,
  normalizeExpertNote,
  reapplyAllowedAt,
  type ExpertCandidate,
} from '@/lib/domain/expert-library';

const now = new Date('2026-10-17T12:00:00Z');

const eligible: ExpertCandidate = {
  visibility: 'public',
  lifecycleStatus: 'published',
  ownerSubscribed: true,
  expertTaggedAt: null,
  evalReady: true,
};

describe('applicationBlocker', () => {
  it('lets an eligible, untagged library with no open application apply', () => {
    expect(applicationBlocker({ candidate: eligible, hasPending: false, lastDecidedAt: null, now })).toBeNull();
  });

  it('names the first missing condition in the order the owner can act on it', () => {
    expect(
      applicationBlocker({
        candidate: { ...eligible, visibility: 'private', lifecycleStatus: 'draft', ownerSubscribed: false },
        hasPending: false,
        lastDecidedAt: null,
        now,
      }),
    ).toBe('not_public');
    expect(
      applicationBlocker({
        candidate: { ...eligible, lifecycleStatus: 'submitted', ownerSubscribed: false },
        hasPending: false,
        lastDecidedAt: null,
        now,
      }),
    ).toBe('not_published');
    expect(
      applicationBlocker({ candidate: { ...eligible, ownerSubscribed: false }, hasPending: false, lastDecidedAt: null, now }),
    ).toBe('not_subscribed');
  });

  it('refuses a second application while one is open, and a tagged library altogether', () => {
    expect(applicationBlocker({ candidate: eligible, hasPending: true, lastDecidedAt: null, now })).toBe('already_pending');
    expect(
      applicationBlocker({
        candidate: { ...eligible, expertTaggedAt: now },
        hasPending: false,
        lastDecidedAt: null,
        now,
      }),
    ).toBe('already_tagged');
  });

  it('holds a rejected or revoked library to the cooldown, and no longer', () => {
    const justNow = new Date(now.getTime() - 60_000);
    expect(applicationBlocker({ candidate: eligible, hasPending: false, lastDecidedAt: justNow, now })).toBe('cooldown');
    const longAgo = new Date(now.getTime() - EXPERT_REAPPLY_COOLDOWN_MS);
    expect(applicationBlocker({ candidate: eligible, hasPending: false, lastDecidedAt: longAgo, now })).toBeNull();
    expect(reapplyAllowedAt(justNow)?.getTime()).toBe(justNow.getTime() + EXPERT_REAPPLY_COOLDOWN_MS);
    expect(reapplyAllowedAt(null)).toBeNull();
  });
});

describe('expertChecks and expertEarning', () => {
  it('lists each of the four conditions on its own', () => {
    expect(expertChecks({ ...eligible, ownerSubscribed: false })).toEqual({
      public: true,
      published: true,
      subscribed: false,
      eval_ready: true,
    });
    expect(expertChecks({ ...eligible, evalReady: false }).eval_ready).toBe(false);
  });

  it('earns only while tagged and every condition holds', () => {
    expect(expertEarning({ ...eligible, expertTaggedAt: now })).toBe(true);
    expect(expertEarning(eligible)).toBe(false);
    expect(expertEarning({ ...eligible, expertTaggedAt: now, ownerSubscribed: false })).toBe(false);
    expect(expertEarning({ ...eligible, expertTaggedAt: now, visibility: 'private' })).toBe(false);
  });
});

describe('approvalChecks', () => {
  const base = {
    candidate: eligible,
    ownerWorkspaceId: 'ws-a',
    applicantWorkspaceId: 'ws-a',
    hasReadyVersion: true,
  };

  it('passes a library that still qualifies and still belongs to the applicant', () => {
    expect(approvalAllowed(approvalChecks(base))).toBe(true);
  });

  it('fails when the owner changed, the plan lapsed or the index is not ready', () => {
    expect(approvalChecks({ ...base, ownerWorkspaceId: 'ws-b' }).owner_unchanged).toBe(false);
    expect(approvalChecks({ ...base, candidate: { ...eligible, ownerSubscribed: false } }).subscribed).toBe(false);
    expect(approvalChecks({ ...base, hasReadyVersion: false }).ready_version).toBe(false);
    expect(approvalAllowed(approvalChecks({ ...base, hasReadyVersion: false }))).toBe(false);
  });
});

describe('nextExpertStatus', () => {
  it('decides a pending application and revokes an approved one, nothing else', () => {
    expect(nextExpertStatus('pending', 'approve')).toBe('approved');
    expect(nextExpertStatus('pending', 'reject')).toBe('rejected');
    expect(nextExpertStatus('approved', 'revoke')).toBe('revoked');
    expect(nextExpertStatus('approved', 'approve')).toBeNull();
    expect(nextExpertStatus('rejected', 'revoke')).toBeNull();
    expect(nextExpertStatus('withdrawn', 'reject')).toBeNull();
  });
});

describe('normalizeExpertNote', () => {
  it('trims, treats blank as none, and bounds the length', () => {
    expect(normalizeExpertNote(undefined)).toBeNull();
    expect(normalizeExpertNote('   ')).toBeNull();
    expect(normalizeExpertNote('  official docs  ')).toBe('official docs');
    expect(normalizeExpertNote('x'.repeat(EXPERT_NOTE_MAX_LENGTH))).toHaveLength(EXPERT_NOTE_MAX_LENGTH);
    expect(normalizeExpertNote('x'.repeat(EXPERT_NOTE_MAX_LENGTH + 1))).toBeUndefined();
    expect(normalizeExpertNote('bad\u0000note')).toBeUndefined();
    expect(normalizeExpertNote(42)).toBeUndefined();
  });
});

/** prd 4.4: the one revenue rule, with its two new inputs. */
describe('isRevenueEligible', () => {
  const library = {
    visibility: 'public' as const,
    lifecycleStatus: 'published' as const,
    ownerWorkspaceId: 'ws-a',
    isPlatformLibrary: false,
    expertTaggedAt: now,
    ownerSubscribed: true,
  };

  it('requires the expert tag and a paid owner on top of the old four', () => {
    expect(isRevenueEligible(library)).toBe(true);
    expect(isRevenueEligible({ ...library, expertTaggedAt: null })).toBe(false);
    expect(isRevenueEligible({ ...library, ownerSubscribed: false })).toBe(false);
    expect(isRevenueEligible({ ...library, visibility: 'private' })).toBe(false);
    expect(isRevenueEligible({ ...library, ownerWorkspaceId: null })).toBe(false);
    expect(isRevenueEligible({ ...library, isPlatformLibrary: true })).toBe(false);
  });
});

/** prd 3: the operator and the reviewer reach the queue; support does not. */
describe('expertLibraries capability', () => {
  it('is granted to super, operator and reviewer only', () => {
    expect(roleAllows('super', 'expertLibraries')).toBe(true);
    expect(roleAllows('operator', 'expertLibraries')).toBe(true);
    expect(roleAllows('reviewer', 'expertLibraries')).toBe(true);
    expect(roleAllows('support', 'expertLibraries')).toBe(false);
  });
});

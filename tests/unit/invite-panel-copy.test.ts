import { describe, expect, it } from 'vitest';
import { invitePanelCopy, withdrawableInvitesPossible } from '@/lib/domain/invites';

/* The invite tab's notes, decided in one place (components/settings/invite-tab.tsx). */
describe('invite panel copy', () => {
  const open = { state: 'open' as const, inviteCredits: 5_000, withdrawableQuota: 1_000, withdrawableOpen: true, ownWithdrawable: 3, ownCap: 20 };

  it('shows the withdrawable note and progress while withdrawable rewards are possible', () => {
    expect(invitePanelCopy(open)).toEqual({ withdrawableNote: true, progress: true, status: null });
    expect(invitePanelCopy({ ...open, ownWithdrawable: 20 })).toEqual({ withdrawableNote: true, progress: true, status: 'own_cap_reached' });
    /* The site-wide quota is named first when both are reached. */
    expect(invitePanelCopy({ ...open, withdrawableOpen: false, ownWithdrawable: 20 })).toEqual({ withdrawableNote: true, progress: true, status: 'site_quota_used' });
  });

  it('says plainly that rewards are gift credits when either limit is 0, never "first 0" or "limit of 0 reached"', () => {
    for (const panel of [{ ...open, ownCap: 0, ownWithdrawable: 0 }, { ...open, withdrawableQuota: 0, withdrawableOpen: false }]) {
      expect(invitePanelCopy(panel)).toEqual({ withdrawableNote: false, progress: false, status: 'gift_only' });
    }
  });

  it('says nothing about withdrawability with no reward, and that invitations are paused when off', () => {
    expect(invitePanelCopy({ ...open, inviteCredits: 0 })).toEqual({ withdrawableNote: false, progress: false, status: null });
    expect(invitePanelCopy({ ...open, state: 'closed' })).toEqual({ withdrawableNote: false, progress: false, status: 'closed' });
  });

  it('knows when withdrawable invite rewards are possible at all', () => {
    const settings = { inviteCredits: 5_000, withdrawableInvites: 1_000, withdrawableInvitesPerInviter: 20 };
    expect(withdrawableInvitesPossible(settings)).toBe(true);
    expect(withdrawableInvitesPossible({ ...settings, withdrawableInvitesPerInviter: 0 })).toBe(false);
    expect(withdrawableInvitesPossible({ ...settings, withdrawableInvites: 0 })).toBe(false);
    expect(withdrawableInvitesPossible({ ...settings, inviteCredits: 0 })).toBe(false);
  });
});

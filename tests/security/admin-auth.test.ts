import { describe, expect, it } from 'vitest';
import {
  AdminChangeRefused,
  ADMIN_CAPABILITIES,
  ADMIN_LOGIN_ERRORS,
  ADMIN_LOCKOUT_MS,
  ADMIN_MAX_FAILED_ATTEMPTS,
  ADMIN_SESSION_LIFETIME_MS,
  adminSessionExpiryFrom,
  capabilitiesForRoles,
  isAdminLoginError,
  isAdminRoleId,
  isAdminSessionLive,
  isLockedOut,
  lockoutUntil,
  normalizeReason,
  refuseLastSuperAdmin,
  refuseSelfChange,
  roleAllows,
  safeAdminReturnTo,
  shouldTouchAdminSession,
} from '@/lib/domain/admin';

const NOW = new Date('2026-08-26T12:00:00.000Z');

/**
 * requirement.md 3.1 and 5.3: least privilege. Widening a preset role by
 * accident is the kind of change that looks harmless in a diff, so the shape
 * of the matrix is pinned here rather than only drawn on a page.
 */
describe('admin capabilities', () => {
  it('gives the super administrator everything and no one else', () => {
    expect(capabilitiesForRoles(['super'])).toEqual([...ADMIN_CAPABILITIES]);
    for (const role of ['operator', 'reviewer', 'support'] as const) {
      expect(capabilitiesForRoles([role])).not.toEqual([...ADMIN_CAPABILITIES]);
    }
  });

  it('keeps administrators and audit out of every non-super role', () => {
    for (const role of ['operator', 'reviewer', 'support'] as const) {
      expect(roleAllows(role, 'administrators')).toBe(false);
      expect(roleAllows(role, 'audit')).toBe(false);
    }
  });

  /*
   * requirement.md 3.1 splits these between two people: a Reviewer decides
   * whether a *user's* public library ships, an Operator maintains the
   * platform's own. One shared capability would have let a reviewer publish
   * and suspend libraries under re0's name.
   */
  it('keeps platform libraries out of the reviewer role', () => {
    expect(roleAllows('reviewer', 'libraries')).toBe(true);
    expect(roleAllows('reviewer', 'platformLibraries')).toBe(false);
    expect(roleAllows('operator', 'platformLibraries')).toBe(true);
    expect(roleAllows('support', 'platformLibraries')).toBe(false);
  });

  /*
   * Model and retrieval configuration is its own capability: a plan version
   * is a price, a model entry is a provider endpoint that spends money.
   */
  it('names models apart from plans and gives it to the operator only', () => {
    expect(ADMIN_CAPABILITIES).toContain('models');
    expect(roleAllows('operator', 'models')).toBe(true);
    expect(roleAllows('operator', 'plans')).toBe(true);
    expect(roleAllows('reviewer', 'models')).toBe(false);
    expect(roleAllows('support', 'models')).toBe(false);
  });

  it('grants nothing at all when no role is assigned', () => {
    expect(capabilitiesForRoles([])).toEqual([]);
  });

  it('unions roles without inventing a capability', () => {
    const granted = capabilitiesForRoles(['reviewer', 'support']);
    expect(granted).toEqual(['users', 'libraries']);
  });

  it('rejects a role id that is not one of the presets', () => {
    expect(isAdminRoleId('super')).toBe(true);
    expect(isAdminRoleId('root')).toBe(false);
    expect(isAdminRoleId(undefined)).toBe(false);
  });
});

/**
 * A console session slides 30 days past its last use, like a product session
 * (lib/domain/admin.ts records the trade-off), under a 90-day cap from
 * sign-in after which the administrator authenticates again.
 */
describe('admin session lifetime', () => {
  const live = {
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    lastSeenAt: NOW,
    revokedAt: null,
    createdAt: NOW,
  };

  it('accepts a session that is fresh, unexpired and not revoked', () => {
    expect(isAdminSessionLive(live, NOW)).toBe(true);
  });

  it('refuses a revoked session even inside its window', () => {
    expect(isAdminSessionLive({ ...live, revokedAt: NOW }, NOW)).toBe(false);
  });

  it('refuses an expired session', () => {
    expect(isAdminSessionLive({ ...live, expiresAt: NOW }, NOW)).toBe(false);
  });

  it('stays live however long ago it was last seen, while its window is open', () => {
    const old = {
      ...live,
      lastSeenAt: new Date(NOW.getTime() - 29 * 24 * 60 * 60 * 1000),
    };
    expect(isAdminSessionLive(old, NOW)).toBe(true);
  });

  it('slides 30 days out from any use', () => {
    expect(ADMIN_SESSION_LIFETIME_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(adminSessionExpiryFrom(NOW).getTime() - NOW.getTime()).toBe(ADMIN_SESSION_LIFETIME_MS);
  });

  it('never slides past 90 days from sign-in, and dies there however fresh', () => {
    const day = 24 * 60 * 60 * 1000;
    const signedIn = new Date(NOW.getTime() - 75 * day);
    /* A touch on day 75 reaches the cap at day 90, not day 105. */
    expect(adminSessionExpiryFrom(NOW, signedIn).getTime()).toBe(signedIn.getTime() + 90 * day);
    /* A row the cap was not applied to is still refused once it is 90 days old. */
    const capped = {
      ...live,
      createdAt: new Date(NOW.getTime() - 90 * day),
      expiresAt: new Date(NOW.getTime() + 10 * day),
    };
    expect(isAdminSessionLive(capped, NOW)).toBe(false);
    expect(isAdminSessionLive({ ...capped, createdAt: new Date(NOW.getTime() - 89 * day) }, NOW)).toBe(true);
  });

  it('only rewrites last_seen_at once the touch interval has passed', () => {
    expect(shouldTouchAdminSession(live, NOW)).toBe(false);
    expect(
      shouldTouchAdminSession({ ...live, lastSeenAt: new Date(NOW.getTime() - 120_000) }, NOW),
    ).toBe(true);
  });
});

describe('admin lockout', () => {
  it('does not lock before the threshold', () => {
    expect(lockoutUntil(ADMIN_MAX_FAILED_ATTEMPTS - 1, NOW)).toBeNull();
  });

  it('locks at the threshold and stays locked for the window', () => {
    const until = lockoutUntil(ADMIN_MAX_FAILED_ATTEMPTS, NOW);
    expect(until).not.toBeNull();
    expect(isLockedOut(until, NOW)).toBe(true);
    expect(isLockedOut(until, new Date(NOW.getTime() + ADMIN_LOCKOUT_MS + 1))).toBe(false);
  });

  it('treats an absent lock as unlocked', () => {
    expect(isLockedOut(null, NOW)).toBe(false);
  });
});

/**
 * An open redirect out of the console is worth more to an attacker than one out
 * of the dashboard, so the allow list is narrower: `/admin/...` and nothing
 * else, and never back onto the sign-in itself.
 */
describe('safeAdminReturnTo', () => {
  it('keeps a console path', () => {
    expect(safeAdminReturnTo('/admin/users')).toBe('/admin/users');
    expect(safeAdminReturnTo('/admin/audit?page=2')).toBe('/admin/audit?page=2');
  });

  it('refuses anything outside the console', () => {
    for (const input of [
      '/dashboard',
      '/',
      'https://evil.example/admin/users',
      '//evil.example',
      '/admin',
      '\\/admin/users',
      '/admin/users\\..\\..',
      '/adminevil',
      undefined,
      42,
    ]) {
      expect(safeAdminReturnTo(input)).toBe('/admin/overview');
    }
  });

  it('refuses the sign-in page, which would loop', () => {
    expect(safeAdminReturnTo('/admin/login')).toBe('/admin/overview');
    expect(safeAdminReturnTo('/admin/login?error=locked')).toBe('/admin/overview');
  });

  it('refuses a path carrying control characters', () => {
    expect(safeAdminReturnTo('/admin/users\nLocation: https://evil.example')).toBe(
      '/admin/overview',
    );
  });
});

describe('admin login errors', () => {
  it('does not leak which factor failed', () => {
    // A separate "wrong code" reply would confirm the password was right.
    expect(isAdminLoginError('mfa_invalid')).toBe(false);
    expect(isAdminLoginError('invalid_credentials')).toBe(true);
  });

  it('has no code that would reveal an address belongs to an administrator', () => {
    // `locked` would say "this address is one of ours" to an anonymous caller,
    // undoing the decoy-hash work in sign-in-admin.
    expect(isAdminLoginError('locked')).toBe(false);
    expect(ADMIN_LOGIN_ERRORS).toEqual(['invalid_credentials', 'rate_limited', 'unavailable']);
  });
});

/**
 * The two guards that keep the console from being locked shut. Both are pure,
 * so the awkward states -- "you are the last super administrator" -- are
 * reachable here in a way they are not against a shared database.
 */
describe('administrator change guards', () => {
  it('refuses to let anyone edit their own role or status', () => {
    expect(() => refuseSelfChange('same-id', 'same-id')).toThrow(AdminChangeRefused);
    try {
      refuseSelfChange('same-id', 'same-id');
    } catch (error) {
      expect((error as AdminChangeRefused).code).toBe('self_change');
    }
    expect(() => refuseSelfChange('actor', 'target')).not.toThrow();
  });

  it('refuses to demote or disable the last active super administrator', () => {
    expect(() => refuseLastSuperAdmin({ targetIsSuper: true, otherActiveSuperAdmins: 0 })).toThrow(
      AdminChangeRefused,
    );
    try {
      refuseLastSuperAdmin({ targetIsSuper: true, otherActiveSuperAdmins: 0 });
    } catch (error) {
      expect((error as AdminChangeRefused).code).toBe('last_super_admin');
    }
  });

  it('allows the change once another active super administrator exists', () => {
    expect(() =>
      refuseLastSuperAdmin({ targetIsSuper: true, otherActiveSuperAdmins: 1 }),
    ).not.toThrow();
  });

  it('does not stand in the way of changing anyone who is not a super admin', () => {
    expect(() =>
      refuseLastSuperAdmin({ targetIsSuper: false, otherActiveSuperAdmins: 0 }),
    ).not.toThrow();
  });
});

/**
 * requirement.md 5.3 requires a reason on every high-risk action. `required` on
 * an input element is a browser convention, not a rule -- a server action is a
 * public endpoint, so the rule has to live here.
 */
describe('normalizeReason', () => {
  it('refuses an empty or whitespace-only reason', () => {
    for (const input of ['', '   ', '\n\t']) {
      expect(() => normalizeReason(input)).toThrow(AdminChangeRefused);
      try {
        normalizeReason(input);
      } catch (error) {
        expect((error as AdminChangeRefused).code).toBe('reason_required');
      }
    }
  });

  it('trims and keeps a real reason', () => {
    expect(normalizeReason('  left the team  ')).toBe('left the team');
  });

  it('caps the length so an audit row cannot be used as storage', () => {
    expect(normalizeReason('x'.repeat(5_000))).toHaveLength(200);
  });
});

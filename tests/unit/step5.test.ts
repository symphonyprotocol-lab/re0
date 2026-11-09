/**
 * Step 5's pure rules: the reporting calendar (UTC+8, Monday weeks; prototype
 * tests/statistics-time.test.mjs), the verification threshold and who may
 * apply (tests/user-roles.test.mjs), the console's CSV and list URLs
 * (tests/admin-scale.test.mjs), and manual credit adjustments.
 */
import { describe, expect, it } from 'vitest';
import { deductFromBucket, parseAdjustment } from '@/lib/domain/adjustments';
import { csvHref, listHref, purchasesView, usersView, verificationsView, LIST_DEFAULTS } from '@/lib/domain/admin-lists';
import { csvCell, toCsv } from '@/lib/domain/csv';
import type { SpendableGrant } from '@/lib/domain/credits';
import {
  parseRoleReason,
  parseVerificationInput,
  roleAfter,
  verificationAccess,
  verificationChecks,
  type RoleMetrics,
} from '@/lib/domain/roles';
import {
  dateOfSelection,
  fillBuckets,
  periodDays,
  periodFilter,
  periodRange,
  recentRange,
  reportingDate,
  reportingTime,
  reportingWeek,
  selectionOf,
  shiftDate,
  trendBuckets,
  validRange,
} from '@/lib/domain/statistics';

const at = (iso: string) => Date.parse(iso);

describe('reporting calendar', () => {
  it('runs days on UTC+8', () => {
    expect(reportingDate(new Date('2026-11-01T15:59:59Z'))).toBe('2026-11-01');
    expect(reportingDate(new Date('2026-11-01T16:00:00Z'))).toBe('2026-11-02');
    expect(reportingTime(new Date('2026-12-31T16:30:00Z'))).toBe('2027-01-01 00:30');
  });

  it('takes a day from midnight to midnight UTC+8', () => {
    expect(periodRange({ period: 'day', date: '2026-11-02' })).toEqual({ start: at('2026-11-01T16:00:00Z'), end: at('2026-11-02T16:00:00Z') });
  });

  it('starts weeks on Monday, across a month and a year', () => {
    /* Sunday 2026-11-01 belongs to the week of Monday 2026-10-26. */
    expect(periodDays({ period: 'week', date: '2026-11-01' })).toEqual({ first: '2026-10-26', last: '2026-11-01' });
    expect(periodDays({ period: 'week', date: '2026-11-02' })).toEqual({ first: '2026-11-02', last: '2026-11-08' });
    /* Thursday 2026-12-31 → Monday 2026-12-28 to Sunday 2027-01-03. */
    expect(periodDays({ period: 'week', date: '2026-12-31' })).toEqual({ first: '2026-12-28', last: '2027-01-03' });
    expect(reportingWeek('2026-12-31')).toBe('2026-W53');
    expect(reportingWeek('2027-01-04')).toBe('2027-W01');
  });

  it('takes whole months, including December into January', () => {
    expect(periodRange({ period: 'month', date: '2026-12-15' })).toEqual({ start: at('2026-11-30T16:00:00Z'), end: at('2026-12-31T16:00:00Z') });
    expect(periodDays({ period: 'month', date: '2028-02-10' })).toEqual({ first: '2028-02-01', last: '2028-02-29' });
  });

  it('keeps a custom range of whole days, the same day included', () => {
    expect(periodRange({ period: 'custom', date: '2026-11-02', start: '2026-11-02', end: '2026-11-02' })).toEqual({
      start: at('2026-11-01T16:00:00Z'),
      end: at('2026-11-02T16:00:00Z'),
    });
    expect(periodDays({ period: 'custom', date: '2027-01-02', start: '2026-12-30', end: '2027-01-02' })).toEqual({ first: '2026-12-30', last: '2027-01-02' });
  });

  it('reads the URL defensively: unknown period, future date, reversed range', () => {
    const now = new Date('2026-11-02T04:00:00Z');
    expect(periodFilter({ period: 'year' }, now)).toEqual({ period: 'all', date: '2026-11-02' });
    expect(periodFilter({ period: 'day', date: '2030-01-01' }, now)).toEqual({ period: 'day', date: '2026-11-02' });
    expect(periodFilter({ period: 'day', date: '2026-02-30' }, now)).toEqual({ period: 'day', date: '2026-11-02' });
    expect(periodFilter({ period: 'custom', start: '2026-10-20', end: '2026-10-01' }, now)).toEqual({
      period: 'custom',
      date: '2026-10-20',
      start: '2026-10-01',
      end: '2026-10-20',
    });
    expect(periodFilter({ period: 'custom' }, now)).toMatchObject({ start: '2026-11-01', end: '2026-11-02' });
    expect(validRange('2026-11-01', '2026-11-02', now)).toBe(true);
    expect(validRange('2026-11-03', '2026-11-02', now)).toBe(false);
    expect(validRange('2026-11-01', '2026-11-03', now)).toBe(false);
  });

  it('turns picker values back into days and steps periods', () => {
    expect(selectionOf('week', '2026-11-04')).toBe('2026-W45');
    expect(dateOfSelection('week', '2026-W45')).toBe('2026-11-02');
    expect(dateOfSelection('week', '2026-W54')).toBeNull();
    expect(dateOfSelection('month', '2026-13')).toBeNull();
    expect(dateOfSelection('month', '2026-02')).toBe('2026-02-01');
    expect(shiftDate('month', '2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('week', '2026-11-04', -1)).toBe('2026-10-26');
    expect(recentRange(7, new Date('2026-11-02T04:00:00Z'))).toEqual({ start: '2026-10-27', end: '2026-11-02' });
    expect(recentRange(5)).toBeNull();
  });

  it('draws hours for a day, days for a month, and groups a long range into at most 31 bars', () => {
    expect(trendBuckets({ period: 'day', date: '2026-11-02' }).buckets).toHaveLength(24);
    expect(trendBuckets({ period: 'month', date: '2026-02-02' }).buckets).toHaveLength(28);
    const long = trendBuckets({ period: 'custom', date: '2026-11-02', start: '2026-08-05', end: '2026-11-02' });
    expect(long.grouping).toBe('days');
    expect(long.buckets.length).toBeLessThanOrEqual(31);
    expect(long.buckets[long.buckets.length - 1]!.end).toBe(at('2026-11-02T16:00:00Z'));
    const { buckets } = trendBuckets({ period: 'day', date: '2026-11-02' });
    const values = fillBuckets(buckets, [
      [at('2026-11-01T16:00:00Z'), 1],
      [at('2026-11-01T16:59:59Z'), 1],
      [at('2026-11-02T15:59:59Z'), 2],
      [at('2026-11-02T16:00:00Z'), 5],
    ]);
    expect(values[0]).toBe(2);
    expect(values[23]).toBe(2);
    expect(values.reduce((a, b) => a + b, 0)).toBe(4);
  });
});

const met: RoleMetrics = {
  registeredDays: 14,
  publicRees: 1,
  readySources: 5,
  externalQuestions: 100,
  helpful: 80,
  unhelpful: 20,
  feedbackCount: 100,
  helpfulRate: 0.8,
};

describe('verification threshold', () => {
  it('passes at exactly the targets and shows what is missing otherwise', () => {
    expect(verificationChecks(met).every((check) => check.passed)).toBe(true);
    const short = verificationChecks({ ...met, registeredDays: 3, readySources: 2, externalQuestions: 99, helpful: 7995, unhelpful: 2005, helpfulRate: 0.7995 });
    expect(Object.fromEntries(short.map((check) => [check.key, check.missing]))).toEqual({
      registeredDays: 11,
      publicRees: 0,
      readySources: 3,
      externalQuestions: 1,
      helpfulRate: 0.1,
    });
    const none = verificationChecks({ ...met, helpful: 0, unhelpful: 0, feedbackCount: 0, helpfulRate: null });
    expect(none.find((check) => check.key === 'helpfulRate')).toMatchObject({ passed: false, missing: null });
  });

  it('allows one pending request, waits 30 days after a rejection, not after a close by role change', () => {
    const now = new Date('2026-11-30T00:00:00Z');
    const normal = { role: 'normal' as const, disabled: false };
    expect(verificationAccess(normal, [], met, now)).toEqual({ eligible: true, reason: null, retryAt: null });
    expect(verificationAccess(normal, [{ status: 'pending', decidedAt: null, closedByRoleChange: false }], met, now).reason).toBe('pending');
    const rejected = { status: 'rejected', decidedAt: new Date('2026-11-10T00:00:00Z'), closedByRoleChange: false };
    expect(verificationAccess(normal, [rejected], met, now)).toEqual({ eligible: false, reason: 'cooldown', retryAt: new Date('2026-12-10T00:00:00Z') });
    expect(verificationAccess(normal, [rejected], met, new Date('2026-12-10T00:00:01Z')).eligible).toBe(true);
    expect(verificationAccess(normal, [{ ...rejected, status: 'closed', closedByRoleChange: true }], met, now).eligible).toBe(true);
    expect(verificationAccess(normal, [], { ...met, publicRees: 0 }, now).reason).toBe('requirements');
    expect(verificationAccess({ role: 'verified', disabled: false }, [], met, now).reason).toBe('role');
    expect(verificationAccess({ role: 'normal', disabled: true }, [], met, now).reason).toBe('disabled');
  });

  it('takes a 1–500 character statement and up to three http(s) links', () => {
    expect(parseVerificationInput('  hi  ', ['', 'https://example.com/a'])).toEqual({ statement: 'hi', links: ['https://example.com/a'] });
    expect(parseVerificationInput('', [])).toEqual({ error: 'statement' });
    expect(parseVerificationInput('😀'.repeat(500), [])).toMatchObject({ statement: '😀'.repeat(500) });
    expect(parseVerificationInput('x'.repeat(501), [])).toEqual({ error: 'statement' });
    expect(parseVerificationInput('ok', ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'])).toEqual({ error: 'links' });
    expect(parseVerificationInput('ok', ['javascript:alert(1)'])).toEqual({ error: 'links' });
    expect(parseVerificationInput('ok', ['https://user:pw@a.test'])).toEqual({ error: 'links' });
  });

  it('changes roles only where the action applies', () => {
    expect(roleAfter('normal', 'official')).toBe('official');
    expect(roleAfter('verified', 'official')).toBe('official');
    expect(roleAfter('official', 'official')).toBeNull();
    expect(roleAfter('official', 'cancel_official')).toBe('normal');
    expect(roleAfter('verified', 'cancel_official')).toBeNull();
    expect(roleAfter('verified', 'revoke')).toBe('normal');
    expect(roleAfter('normal', 'revoke')).toBeNull();
    expect(parseRoleReason('  ')).toBeNull();
    expect(parseRoleReason('x'.repeat(501))).toBeNull();
    expect(parseRoleReason(' ok ')).toBe('ok');
  });
});

describe('console CSV and list URLs', () => {
  it('quotes every field, doubles quotes, and defuses formulas', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('  +1')).toBe(`"'  +1"`);
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('@me')).toBe(`"'@me"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(12)).toBe('"12"');
    const text = toCsv(['a', 'b'], [['1', '中文']]);
    expect(text.startsWith('﻿"a","b"\r\n"1","中文"')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('reads filters with defaults and writes canonical URLs', () => {
    const view = usersView({ role: 'official', kyc: 'nope', size: '50', page: '3', sort: 'oldest' });
    expect(view).toMatchObject({ role: 'official', kyc: 'all', size: 50, page: 3, sort: 'oldest', status: 'all' });
    expect(listHref('/admin/users', view)).toBe('/admin/users?role=official&sort=oldest&size=50&page=3');
    expect(listHref('/admin/users', view, { status: 'disabled' })).toBe('/admin/users?status=disabled&role=official&sort=oldest&size=50');
    expect(listHref('/admin/users', view, { page: 4 })).toContain('page=4');
    expect(csvHref('/api/admin/users', view)).toBe('/api/admin/users?role=official&sort=oldest&size=50&format=csv');
    const verifications = verificationsView({});
    expect(verifications.status).toBe('pending');
    expect(listHref('/admin/verifications', verifications, {}, { ...LIST_DEFAULTS, status: 'pending' })).toBe('/admin/verifications');
    expect(purchasesView({ tab: 'subscriptions', sort: 'amount-high', status: 'paid' })).toMatchObject({ tab: 'subscriptions', sort: 'newest', status: 'all' });
  });
});

describe('manual credit adjustment', () => {
  it('takes the Pack or Plan bucket, 1 to 10,000,000 credits and a 3–300 character reason', () => {
    expect(parseAdjustment({ bucket: 'pack', direction: 'grant', amount: 500, reason: 'goodwill' })).toEqual({ bucket: 'pack', direction: 'grant', amount: 500, reason: 'goodwill' });
    expect(parseAdjustment({ bucket: 'earned', direction: 'grant', amount: 1, reason: 'abc' })).toEqual({ error: 'bucket' });
    expect(parseAdjustment({ bucket: 'pack', direction: 'grant', amount: 0, reason: 'abc' })).toEqual({ error: 'amount' });
    expect(parseAdjustment({ bucket: 'pack', direction: 'grant', amount: 10_000_001, reason: 'abc' })).toEqual({ error: 'amount' });
    expect(parseAdjustment({ bucket: 'pack', direction: 'grant', amount: 1.5, reason: 'abc' })).toEqual({ error: 'amount' });
    expect(parseAdjustment({ bucket: 'pack', direction: 'deduct', amount: '1,000', reason: 'abc' })).toMatchObject({ amount: 1000 });
    expect(parseAdjustment({ bucket: 'plan', direction: 'deduct', amount: 1, reason: 'ab' })).toEqual({ error: 'reason' });
    expect(parseAdjustment({ bucket: 'plan', direction: 'deduct', amount: 1, reason: 'x'.repeat(301) })).toEqual({ error: 'reason' });
  });

  it('deducts only what the bucket holds, soonest-expiring first', () => {
    const now = new Date('2026-11-10T00:00:00Z');
    const grants: SpendableGrant[] = [
      { id: 'p1', source: 'pack', remaining: 300, expiresAt: null, createdAt: new Date('2026-10-01') },
      { id: 'p2', source: 'pack', remaining: 200, expiresAt: null, createdAt: new Date('2026-10-05') },
      { id: 'w', source: 'welcome', remaining: 2000, expiresAt: null, createdAt: new Date('2026-09-01') },
      { id: 'old', source: 'plan', remaining: 900, expiresAt: new Date('2026-11-01'), createdAt: new Date('2026-10-01') },
      { id: 'now', source: 'plan', remaining: 100, expiresAt: new Date('2026-12-01'), createdAt: new Date('2026-11-01') },
    ];
    expect(deductFromBucket(grants, 'pack', 400, now)).toEqual([
      { grantId: 'p1', source: 'pack', amount: 300 },
      { grantId: 'p2', source: 'pack', amount: 100 },
    ]);
    expect(deductFromBucket(grants, 'pack', 501, now)).toBeNull();
    /* An expired Plan period is not there to take from. */
    expect(deductFromBucket(grants, 'plan', 101, now)).toBeNull();
    expect(deductFromBucket(grants, 'plan', 100, now)).toEqual([{ grantId: 'now', source: 'plan', amount: 100 }]);
  });
});

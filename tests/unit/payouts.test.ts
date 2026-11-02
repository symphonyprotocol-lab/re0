/**
 * Step 6's rules without the database (8.4 step 6, prototype
 * tests/manual-kyc.test.mjs, workspace.test.mjs): the identity form, who may
 * submit, approval needs, image retention, the PayPal address and its hold,
 * where a user stands, the request amount, the recorded payment and fee,
 * and the status machine.
 */
import { describe, expect, it } from 'vitest';
import { approvalBlocker, canSubmitKyc, documentValid, filesDueAt, kycPathname, kycState, parseKycSubmission } from '@/lib/domain/kyc';
import {
  canMove,
  creditsToCents,
  formatCentsUsd,
  formatCreditsUsd,
  liveFeeCents,
  normalizePaypalEmail,
  parsePaidAmount,
  parsePayoutCredits,
  parseTransferId,
  payoutStage,
  paypalOnHold,
  releasesHold,
} from '@/lib/domain/payouts';

const DAY = 24 * 60 * 60 * 1000;
const USER = '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const file = (ext = 'png') => `kyc/${USER}/0e8f6a2b-1c3d-4e5f-9a7b-8c9d0e1f2a3b.${ext}`;

describe('identity submission', () => {
  const valid = {
    legalName: '  Mei   Lin ',
    country: 'Malaysia',
    documentKind: 'passport',
    documentLast4: 'ab12',
    documentExpires: '2030-12-31',
    taxForm: 'W-8BEN',
    declared: true,
    consent: true,
    documentBlob: file('png'),
    selfieBlob: `kyc/${USER}/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.jpg`,
  };

  it('accepts a complete form, normalising name and the last four characters', () => {
    expect(parseKycSubmission(USER, valid, '2026-11-02')).toMatchObject({ legalName: 'Mei Lin', documentLast4: 'AB12', taxForm: 'W-8BEN' });
  });

  it('answers the first failing field', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ legalName: 'x'.repeat(101) }, 'legal_name'],
      [{ legalName: 'tab\u0007' }, 'legal_name'],
      [{ country: '' }, 'country'],
      [{ country: 'y'.repeat(81) }, 'country'],
      [{ documentKind: 'driving' }, 'document_kind'],
      [{ documentLast4: '12345' }, 'last4'],
      [{ documentLast4: '12-4' }, 'last4'],
      [{ documentExpires: '2026-11-01' }, 'expires'],
      [{ documentExpires: '2026-02-30' }, 'expires'],
      [{ taxForm: '1099' }, 'tax_form'],
      [{ declared: 'yes' }, 'declared'],
      [{ consent: false }, 'consent'],
      [{ documentBlob: `kyc/${USER}/../../x.png` }, 'document'],
      [{ documentBlob: 'knowledge/abc/file.png' }, 'document'],
      [{ selfieBlob: file('png') }, 'selfie'],
      [{ selfieBlob: `kyc/${USER}/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.gif` }, 'selfie'],
    ];
    for (const [change, error] of cases) expect(parseKycSubmission(USER, { ...valid, ...change }, '2026-11-02')).toEqual({ error });
  });

  it('a document expiring today is still valid today, not tomorrow', () => {
    expect(documentValid('2026-11-02', '2026-11-02')).toBe(true);
    expect(documentValid('2026-11-02', '2026-11-03')).toBe(false);
    expect(documentValid(null, '2026-11-02')).toBe(false);
  });

  it('only pathnames under the user', () => {
    expect(kycPathname(USER, file('webp'))).toBe(file('webp'));
    expect(kycPathname('someone-else', file())).toBeNull();
  });

  it('submits first, after a rejection or a reset; never while pending or verified', () => {
    expect(kycState(null)).toBe('none');
    expect(kycState({ status: 'reset' })).toBe('reset');
    expect(['none', 'rejected', 'reset'].every((state) => canSubmitKyc(state as never))).toBe(true);
    expect(canSubmitKyc('pending')).toBe(false);
    expect(canSubmitKyc('verified')).toBe(false);
  });
});

describe('identity review', () => {
  const pending = {
    status: 'pending' as const,
    documentExpires: '2030-01-01',
    taxDeclaredAt: new Date(),
    documentBlob: file(),
    selfieBlob: file('jpg'),
    filesDeletedAt: null,
    resetAt: null,
  };

  it('approves the newest pending submission with the tick, an unexpired document, the declaration and both images', () => {
    expect(approvalBlocker(pending, true, true, '2026-11-02')).toBeNull();
    expect(approvalBlocker(pending, false, true, '2026-11-02')).toBe('stale');
    expect(approvalBlocker({ ...pending, status: 'verified' }, true, true, '2026-11-02')).toBe('stale');
    expect(approvalBlocker(pending, true, false, '2026-11-02')).toBe('matched');
    expect(approvalBlocker({ ...pending, documentExpires: '2026-11-01' }, true, true, '2026-11-02')).toBe('expired');
    expect(approvalBlocker({ ...pending, taxDeclaredAt: null }, true, true, '2026-11-02')).toBe('declared');
    expect(approvalBlocker({ ...pending, selfieBlob: null }, true, true, '2026-11-02')).toBe('files');
    expect(approvalBlocker({ ...pending, filesDeletedAt: new Date() }, true, true, '2026-11-02')).toBe('files');
  });

  it('images are due exactly 30 days after approval, rejection or a reset; pending ones are kept', () => {
    const decidedAt = new Date('2026-10-01T12:00:00Z');
    const verified = { status: 'verified' as const, decidedAt, resetAt: null, documentBlob: file(), selfieBlob: file('jpg'), filesDeletedAt: null };
    expect(filesDueAt(verified)).toEqual(new Date('2026-10-31T12:00:00Z'));
    expect(filesDueAt({ ...verified, status: 'rejected' })).toEqual(new Date('2026-10-31T12:00:00Z'));
    expect(filesDueAt({ ...verified, status: 'pending', decidedAt: null })).toBeNull();
    expect(filesDueAt({ ...verified, status: 'pending', decidedAt: null, resetAt: decidedAt })).toEqual(new Date('2026-10-31T12:00:00Z'));
    /* Approved earlier, reset later: the earlier start counts. */
    expect(filesDueAt({ ...verified, resetAt: new Date('2026-10-20T00:00:00Z') })).toEqual(new Date('2026-10-31T12:00:00Z'));
    expect(filesDueAt({ ...verified, filesDeletedAt: new Date() })).toBeNull();
    expect(filesDueAt({ ...verified, documentBlob: null, selfieBlob: null })).toBeNull();
  });
});

describe('PayPal address', () => {
  it('normalises and caps at 254 characters', () => {
    expect(normalizePaypalEmail('  Creator@Example.COM ')).toBe('creator@example.com');
    expect(normalizePaypalEmail('no-at-sign')).toBeNull();
    expect(normalizePaypalEmail('a b@example.com')).toBeNull();
    expect(normalizePaypalEmail(`${'a'.repeat(242)}@example.com`)).toHaveLength(254);
    expect(normalizePaypalEmail(`${'a'.repeat(243)}@example.com`)).toBeNull();
  });

  it('holds payouts for seven days after a change, not after the first address', () => {
    const changed = new Date('2026-11-01T00:00:00Z');
    expect(paypalOnHold(null, new Date())).toBe(false);
    expect(paypalOnHold(changed, new Date(changed.getTime() + 7 * DAY - 1))).toBe(true);
    expect(paypalOnHold(changed, new Date(changed.getTime() + 7 * DAY))).toBe(false);
  });
});

describe('where a user stands', () => {
  const base = { official: false, kyc: 'verified' as const, open: null, paypalEmail: 'a@b.co', paypalChangedAt: null, withdrawable: 500_000, now: new Date() };
  it('follows the prototype order', () => {
    expect(payoutStage(base)).toBe('eligible');
    expect(payoutStage({ ...base, official: true })).toBe('official');
    expect(payoutStage({ ...base, open: 'pending' })).toBe('review');
    expect(payoutStage({ ...base, open: 'approved' })).toBe('payment');
    expect(payoutStage({ ...base, kyc: 'pending' })).toBe('identity_pending');
    expect(payoutStage({ ...base, kyc: 'rejected' })).toBe('identity_required');
    expect(payoutStage({ ...base, kyc: 'reset' })).toBe('identity_required');
    expect(payoutStage({ ...base, paypalEmail: null })).toBe('paypal');
    expect(payoutStage({ ...base, paypalChangedAt: new Date() })).toBe('hold');
    expect(payoutStage({ ...base, withdrawable: 499_999 })).toBe('threshold');
  });
});

describe('requests and payments', () => {
  it('a whole number from 500,000 to the earned balance, all of it by default', () => {
    expect(parsePayoutCredits(undefined, 600_000)).toBe(600_000);
    expect(parsePayoutCredits('550,000', 600_000)).toBe(550_000);
    expect(parsePayoutCredits(499_999, 600_000)).toEqual({ error: 'below_minimum' });
    expect(parsePayoutCredits(600_001, 600_000)).toEqual({ error: 'over_balance' });
    expect(parsePayoutCredits(500_000.5, 600_000)).toEqual({ error: 'amount' });
    expect(parsePayoutCredits('abc', 600_000)).toEqual({ error: 'amount' });
  });

  it('records 55.00 against 60.00 as a 5.00 fee, exact in credits', () => {
    expect(parsePaidAmount('55.00', 600_000)).toEqual({ paidCents: 5_500, feeCredits: 50_000 });
    expect(parsePaidAmount('60', 600_000)).toEqual({ paidCents: 6_000, feeCredits: 0 });
    expect(parsePaidAmount(55.5, 600_000)).toEqual({ paidCents: 5_550, feeCredits: 45_000 });
    expect(liveFeeCents('55', 600_000)).toBe(500);
    /* Not more than requested, more than zero, two decimals at most. */
    for (const raw of ['60.01', '0', '0.00', '55.001', '-5', '', 'ten']) expect(parsePaidAmount(raw, 600_000)).toEqual({ error: 'paid_amount' });
    /* A request that is not a whole number of cents: the most that can be paid is the cents below it. */
    expect(parsePaidAmount('50.00', 500_001)).toEqual({ paidCents: 5_000, feeCredits: 1 });
    expect(parsePaidAmount('50.01', 500_001)).toEqual({ error: 'paid_amount' });
    expect(creditsToCents(600_000)).toBe(6_000);
    expect(formatCreditsUsd(10_000_000)).toBe('$1,000.00');
    expect(formatCentsUsd(5_500)).toBe('$55.00');
  });

  it('a transfer id is printable, without blanks, at most 100 characters', () => {
    expect(parseTransferId(' 5TY12345AB678901C ')).toBe('5TY12345AB678901C');
    expect(parseTransferId('two words')).toBeNull();
    expect(parseTransferId('')).toBeNull();
    expect(parseTransferId('x'.repeat(101))).toBeNull();
  });

  it('moves pending → approved | rejected, approved → paid | failed, and nowhere from a final status', () => {
    expect(canMove('pending', 'approved')).toBe(true);
    expect(canMove('pending', 'rejected')).toBe(true);
    expect(canMove('pending', 'paid')).toBe(false);
    expect(canMove('approved', 'paid')).toBe(true);
    expect(canMove('approved', 'failed')).toBe(true);
    expect(canMove('approved', 'rejected')).toBe(false);
    for (const final of ['paid', 'failed', 'rejected'] as const) {
      for (const to of ['approved', 'rejected', 'paid', 'failed'] as const) expect(canMove(final, to)).toBe(false);
    }
    expect(releasesHold('rejected') && releasesHold('failed')).toBe(true);
    expect(releasesHold('approved') || releasesHold('paid')).toBe(false);
  });
});

/**
 * Acceptance (8.4 step 6), against the database: identity is submitted once
 * and reviewed by hand (approval needs the comparison tick and an unexpired
 * document; rejection a reason); every signed image link is audited; images
 * go 30 days after approval, rejection or a re-verification request, and
 * unsubmitted uploads after a day; the PayPal address waits seven days after
 * a change; a request holds earned credits only, one at a time; rejection and
 * failure release the hold once, approval keeps it, payment settles it with
 * the fee recorded; official accounts are kept out throughout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, desc, eq, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const blobs = vi.hoisted(() => ({
  files: new Map<string, { size: number; contentType: string }>(),
  listed: [] as { pathname: string; uploadedAt: Date }[],
  deleted: [] as string[],
}));

vi.mock('@/lib/infra/blob-access', () => ({
  blobInfo: async (pathname: string) => blobs.files.get(pathname) ?? null,
  signedReadUrl: async (pathname: string, ttlSeconds: number, now = Date.now()) => ({
    url: `https://store.private.blob.vercel-storage.com/${pathname}?signed=1`,
    expiresAt: new Date(now + ttlSeconds * 1000),
  }),
  listByPrefix: async () => ({ blobs: blobs.listed, cursor: null }),
  deleteBlobs: async (pathnames: string[]) => {
    blobs.deleted.push(...pathnames);
    for (const pathname of pathnames) blobs.files.delete(pathname);
  },
}));
vi.mock('@/lib/infra/blob', () => ({
  uploadTicket: async (pathname: string) => ({ pathname, token: 'client-token' }),
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { db, schema } = await import('@/lib/infra/db');
const kyc = await import('@/lib/services/kyc');
const payouts = await import('@/lib/services/payouts');
const roles = await import('@/lib/services/roles');
const adminAudit = await import('@/lib/services/admin-audit');
const adminUsers = await import('@/lib/services/admin-users');
const { addGrant, balanceOf } = await import('@/lib/services/credits');
const { auditView, kycView, payoutHistoryView, payoutQueueView, usersView } = await import('@/lib/domain/admin-lists');
const { reportingDate } = await import('@/lib/domain/statistics');

const DAY = 24 * 60 * 60 * 1000;

async function newUser(name = 'Creator'): Promise<string> {
  const subject = uniqueName('s6');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: name, avatarUrl: null }, 'zh', '/');
  return userId;
}

async function newAdministrator(): Promise<string> {
  const [row] = await db()
    .insert(schema.administrator)
    .values({ name: 'Reviewer', email: `${uniqueName('admin')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x' })
    .returning({ id: schema.administrator.id });
  return row!.id;
}

async function earn(userId: string, amount: number): Promise<void> {
  await db().transaction((tx) => addGrant(tx, { userId, source: 'earned', amount, reason: 'query_fee_earned', refId: crypto.randomUUID() }));
}

async function pack(userId: string, amount: number): Promise<void> {
  await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount, reason: 'purchase', refId: crypto.randomUUID() }));
}

/** Two "uploaded" images for the user, as the upload ticket would name them. */
function upload(userId: string, contentType = 'image/png', size = 200_000): string {
  const pathname = `kyc/${userId}/${crypto.randomUUID()}.${contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'}`;
  blobs.files.set(pathname, { size, contentType });
  return pathname;
}

function form(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    legalName: 'Mei Lin',
    country: 'Malaysia',
    documentKind: 'passport',
    documentLast4: '2048',
    documentExpires: reportingDate(Date.now() + 365 * DAY),
    taxForm: 'W-8BEN',
    declared: true,
    consent: true,
    documentBlob: upload(userId),
    selfieBlob: upload(userId, 'image/jpeg'),
    ...overrides,
  };
}

/** A user with verified identity, a PayPal address and `earned` credits. */
async function verifiedCreator(reviewer: string, earned = 700_000): Promise<string> {
  const userId = await newUser();
  const record = await kyc.submitKyc(userId, form(userId));
  await kyc.decideKyc(reviewer, record.id, 'verified', { matched: true });
  await payouts.setPaypalEmail(userId, 'Creator@Example.com');
  if (earned) await earn(userId, earned);
  return userId;
}

async function entries(userId: string, refId: string) {
  return db()
    .select()
    .from(schema.creditEntry)
    .where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.refId, refId)))
    .orderBy(schema.creditEntry.createdAt);
}

async function earnedRemaining(userId: string): Promise<number> {
  return payouts.withdrawable(db(), userId);
}

beforeEach(() => {
  blobs.listed = [];
  blobs.deleted = [];
});

describeWithDb('identity verification', () => {
  it('validates the form, checks the images, and allows one submission at a time', async () => {
    const userId = await newUser();
    await expect(kyc.submitKyc(userId, form(userId, { legalName: ' ' }))).rejects.toMatchObject({ code: 'legal_name' });
    await expect(kyc.submitKyc(userId, form(userId, { legalName: 'x'.repeat(101) }))).rejects.toMatchObject({ code: 'legal_name' });
    await expect(kyc.submitKyc(userId, form(userId, { country: 'y'.repeat(81) }))).rejects.toMatchObject({ code: 'country' });
    await expect(kyc.submitKyc(userId, form(userId, { documentKind: 'licence' }))).rejects.toMatchObject({ code: 'document_kind' });
    await expect(kyc.submitKyc(userId, form(userId, { documentLast4: '204' }))).rejects.toMatchObject({ code: 'last4' });
    await expect(kyc.submitKyc(userId, form(userId, { documentExpires: reportingDate(Date.now() - DAY) }))).rejects.toMatchObject({ code: 'expires' });
    await expect(kyc.submitKyc(userId, form(userId, { taxForm: 'W-8' }))).rejects.toMatchObject({ code: 'tax_form' });
    await expect(kyc.submitKyc(userId, form(userId, { declared: false }))).rejects.toMatchObject({ code: 'declared' });
    await expect(kyc.submitKyc(userId, form(userId, { consent: false }))).rejects.toMatchObject({ code: 'consent' });
    /* Someone else's upload, a file never uploaded, a file over 10 MB, the same file twice. */
    const other = await newUser();
    await expect(kyc.submitKyc(userId, form(userId, { documentBlob: upload(other) }))).rejects.toMatchObject({ code: 'document' });
    await expect(kyc.submitKyc(userId, form(userId, { documentBlob: `kyc/${userId}/${crypto.randomUUID()}.png` }))).rejects.toMatchObject({ code: 'document' });
    await expect(kyc.submitKyc(userId, form(userId, { selfieBlob: upload(userId, 'image/png', 10 * 1024 * 1024 + 1) }))).rejects.toMatchObject({ code: 'selfie' });
    const same = upload(userId);
    await expect(kyc.submitKyc(userId, form(userId, { documentBlob: same, selfieBlob: same }))).rejects.toMatchObject({ code: 'selfie' });
    await expect(kyc.kycUploadTicket(userId, { contentType: 'image/gif', size: 100 })).rejects.toMatchObject({ code: 'invalid_image' });
    await expect(kyc.kycUploadTicket(userId, { contentType: 'image/png', size: 10 * 1024 * 1024 + 1 })).rejects.toMatchObject({ code: 'invalid_image' });
    expect((await kyc.kycUploadTicket(userId, { contentType: 'image/webp', size: 1000 })).pathname).toMatch(new RegExp(`^kyc/${userId}/[0-9a-f-]{36}\\.webp$`));

    const record = await kyc.submitKyc(userId, form(userId, { documentLast4: 'ab12' }));
    expect(record).toMatchObject({ status: 'pending', documentLast4: 'AB12', provider: 'manual' });
    expect((await kyc.kycOverview(userId)).state).toBe('pending');
    /* Pending: no second submission, no new upload, no PayPal address. */
    await expect(kyc.submitKyc(userId, form(userId))).rejects.toMatchObject({ code: 'kyc_pending' });
    await expect(kyc.kycUploadTicket(userId, { contentType: 'image/png', size: 1000 })).rejects.toMatchObject({ code: 'kyc_pending' });
    await expect(payouts.setPaypalEmail(userId, 'me@example.com')).rejects.toMatchObject({ code: 'kyc_pending' });
  });

  it('approves only with the comparison tick and an unexpired document, rejects only with a reason; audited and noticed', async () => {
    const reviewer = await newAdministrator();
    const userId = await newUser();
    const first = await kyc.submitKyc(userId, form(userId));
    await expect(kyc.decideKyc(reviewer, first.id, 'verified', { matched: false })).rejects.toMatchObject({ code: 'matched' });
    await expect(kyc.decideKyc(reviewer, first.id, 'rejected', { reason: 'no' })).rejects.toMatchObject({ code: 'reason' });
    await expect(kyc.decideKyc(reviewer, first.id, 'rejected', { reason: 'x'.repeat(301) })).rejects.toMatchObject({ code: 'reason' });
    await kyc.decideKyc(reviewer, first.id, 'rejected', { reason: 'The selfie is blurred.' });
    await expect(kyc.decideKyc(reviewer, first.id, 'verified', { matched: true })).rejects.toMatchObject({ code: 'stale' });
    expect((await kyc.kycOverview(userId)).record).toMatchObject({ status: 'rejected', reason: 'The selfie is blurred.' });

    /* Resubmitted with a document that expires today; approved after it expired. */
    const second = await kyc.submitKyc(userId, form(userId, { documentExpires: reportingDate(new Date()) }));
    await expect(kyc.decideKyc(reviewer, second.id, 'verified', { matched: true }, new Date(Date.now() + 2 * DAY))).rejects.toMatchObject({ code: 'expired' });
    const approved = await kyc.decideKyc(reviewer, second.id, 'verified', { matched: true });
    expect(approved).toMatchObject({ status: 'verified', reviewedBy: reviewer });

    const notices = await db().select().from(schema.notice).where(eq(schema.notice.userId, userId)).orderBy(schema.notice.createdAt);
    expect(notices.map((notice) => [notice.kind, notice.params.decision])).toEqual([
      ['kyc', 'rejected'],
      ['kyc', 'verified'],
    ]);
    const audits = await adminAudit.listAudit(auditView({ q: second.id }));
    expect(audits.items.map((row) => row.action)).toEqual(['kyc.verified']);
    expect((await kyc.listKyc(kycView({ q: userId }))).items.map((row) => row.status)).toEqual(['rejected', 'verified']);
    const users = await adminUsers.listUsers(usersView({ q: userId, kyc: 'verified' }));
    expect(users.items.map((row) => [row.id, row.kyc])).toEqual([[userId, 'verified']]);
  });

  it('audits every signed link, 60 seconds each', async () => {
    const reviewer = await newAdministrator();
    const userId = await newUser();
    const record = await kyc.submitKyc(userId, form(userId));
    const now = new Date();
    const first = await kyc.kycFiles(reviewer, record.id, now);
    expect(first.deleted).toBe(false);
    expect(first.files.document!.url).toContain(`kyc/${userId}/`);
    expect(Date.parse(first.files.selfie!.expiresAt) - now.getTime()).toBe(60_000);
    await kyc.kycFiles(reviewer, record.id);
    const views = await adminAudit.listAudit(auditView({ action: 'kyc.files.view', q: record.id }));
    expect(views.total).toBe(4);
    expect(views.items.map((row) => (row.after as { file: string }).file).sort()).toEqual(['document', 'document', 'selfie', 'selfie']);
  });

  it('asks for re-verification on the newest decided record only, and the user may submit again', async () => {
    const reviewer = await newAdministrator();
    const userId = await newUser();
    const record = await kyc.submitKyc(userId, form(userId));
    await expect(kyc.requestReverification(reviewer, record.id, 'Please renew')).rejects.toMatchObject({ code: 'kyc_pending' });
    await kyc.decideKyc(reviewer, record.id, 'verified', { matched: true });
    await expect(kyc.requestReverification(reviewer, record.id, 'no')).rejects.toMatchObject({ code: 'reason' });
    const reset = await kyc.requestReverification(reviewer, record.id, 'Document photo unreadable');
    expect(reset).toMatchObject({ status: 'reset', reason: 'Document photo unreadable', documentBlob: null });
    const [old] = await db().select().from(schema.kycRecord).where(eq(schema.kycRecord.id, record.id));
    expect(old!.status).toBe('verified');
    expect(old!.resetAt).not.toBeNull();
    expect((await kyc.kycOverview(userId)).state).toBe('reset');
    await expect(kyc.requestReverification(reviewer, record.id, 'Twice over')).rejects.toMatchObject({ code: 'stale' });
    const again = await kyc.submitKyc(userId, form(userId));
    expect(again.status).toBe('pending');
    const audits = await adminAudit.listAudit(auditView({ action: 'kyc.reset', q: record.id }));
    expect(audits.total).toBe(1);
  });

  it('deletes images 30 days after approval, rejection or reset, keeping the record; then unsubmitted uploads', async () => {
    const reviewer = await newAdministrator();
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    const make = async (decision: 'verified' | 'rejected' | 'pending', decidedDaysAgo: number) => {
      const userId = await newUser();
      const record = await kyc.submitKyc(userId, form(userId));
      if (decision !== 'pending') await kyc.decideKyc(reviewer, record.id, decision, { matched: true, reason: decision === 'rejected' ? 'Unclear image' : '' }, at(decidedDaysAgo));
      return { userId, record };
    };
    const approvedOld = await make('verified', 31);
    const approvedRecent = await make('verified', 29);
    const rejectedOld = await make('rejected', 30);
    const pendingOld = await make('pending', 0);
    await db().update(schema.kycRecord).set({ createdAt: at(90) }).where(eq(schema.kycRecord.id, pendingOld.record.id));
    const resetOld = await make('verified', 10);
    await kyc.requestReverification(reviewer, resetOld.record.id, 'Re-check identity', at(31));

    const result = await kyc.purgeKycFiles(now);
    expect(result.records).toBeGreaterThanOrEqual(3);
    const state = async (id: string) => (await db().select().from(schema.kycRecord).where(eq(schema.kycRecord.id, id)))[0]!;
    for (const gone of [approvedOld, rejectedOld, resetOld]) {
      const row = await state(gone.record.id);
      expect(row).toMatchObject({ documentBlob: null, selfieBlob: null, legalName: 'Mei Lin', documentLast4: '2048' });
      expect(row.filesDeletedAt).not.toBeNull();
      expect(blobs.deleted).toContain(gone.record.documentBlob);
      expect(blobs.deleted).toContain(gone.record.selfieBlob);
    }
    for (const kept of [approvedRecent, pendingOld]) expect((await state(kept.record.id)).filesDeletedAt).toBeNull();
    expect((await kyc.kycFiles(reviewer, approvedOld.record.id)).deleted).toBe(true);
    /* Idempotent. */
    blobs.deleted = [];
    await kyc.purgeKycFiles(now);
    expect(blobs.deleted).not.toContain(approvedOld.record.documentBlob);

    /* Orphans: an old unsubmitted upload of a user here goes; a submitted one, a recent one and another environment's stay. */
    const userId = await newUser();
    const orphan = upload(userId);
    const recent = upload(userId);
    const foreign = `kyc/${crypto.randomUUID()}/${crypto.randomUUID()}.png`;
    blobs.listed = [
      { pathname: orphan, uploadedAt: at(2) },
      { pathname: recent, uploadedAt: new Date(now.getTime() - 60 * 60 * 1000) },
      { pathname: foreign, uploadedAt: at(5) },
      { pathname: approvedRecent.record.documentBlob!, uploadedAt: at(40) },
    ];
    blobs.deleted = [];
    const second = await kyc.purgeKycFiles(now);
    expect(second.orphans).toBe(1);
    expect(blobs.deleted).toEqual([orphan]);
  });

  it('keeps official accounts out of identity verification', async () => {
    const reviewer = await newAdministrator();
    const userId = await newUser('Official');
    await roles.changeRole(reviewer, userId, 'official', 'Platform account');
    await expect(kyc.submitKyc(userId, form(userId))).rejects.toMatchObject({ code: 'official' });
    await expect(kyc.kycUploadTicket(userId, { contentType: 'image/png', size: 100 })).rejects.toMatchObject({ code: 'official' });
    expect((await kyc.kycOverview(userId)).official).toBe(true);
  });
});

describeWithDb('payouts', () => {
  it('waits seven days after a PayPal address change, not after the first', async () => {
    const reviewer = await newAdministrator();
    const userId = await newUser();
    await expect(payouts.setPaypalEmail(userId, 'me@example.com')).rejects.toMatchObject({ code: 'kyc_required' });
    const record = await kyc.submitKyc(userId, form(userId));
    await kyc.decideKyc(reviewer, record.id, 'verified', { matched: true });
    await expect(payouts.setPaypalEmail(userId, 'not an email')).rejects.toMatchObject({ code: 'invalid_email' });
    await expect(payouts.setPaypalEmail(userId, `${'a'.repeat(250)}@b.co`)).rejects.toMatchObject({ code: 'invalid_email' });
    expect(await payouts.setPaypalEmail(userId, ' First@Example.com ')).toEqual({ email: 'first@example.com', holdUntil: null });
    await earn(userId, 600_000);
    expect((await payouts.payoutOverview(userId)).stage).toBe('eligible');

    const changed = new Date();
    const { holdUntil } = await payouts.setPaypalEmail(userId, 'second@example.com', changed);
    expect(holdUntil!.getTime() - changed.getTime()).toBe(7 * DAY);
    expect((await payouts.payoutOverview(userId)).stage).toBe('hold');
    await expect(payouts.requestPayout(userId, 600_000)).rejects.toMatchObject({ code: 'paypal_hold' });
    await expect(payouts.requestPayout(userId, 600_000, new Date(changed.getTime() + 7 * DAY - 1000))).rejects.toMatchObject({ code: 'paypal_hold' });
    const payout = await payouts.requestPayout(userId, 600_000, new Date(changed.getTime() + 7 * DAY + 1000));
    expect(payout.paypalEmail).toBe('second@example.com');
  });

  it('holds earned credits only, one request at a time, at least 500,000 and at most the earned balance', async () => {
    const reviewer = await newAdministrator();
    const userId = await verifiedCreator(reviewer, 0);
    await pack(userId, 2_000_000);
    /* Pack and welcome credits are never withdrawable. */
    expect((await payouts.payoutOverview(userId)).stage).toBe('threshold');
    await expect(payouts.requestPayout(userId, 500_000)).rejects.toMatchObject({ code: 'over_balance' });
    await earn(userId, 700_000);
    await expect(payouts.requestPayout(userId, 499_999)).rejects.toMatchObject({ code: 'below_minimum' });
    await expect(payouts.requestPayout(userId, 700_001)).rejects.toMatchObject({ code: 'over_balance' });
    await expect(payouts.requestPayout(userId, 600_000.5)).rejects.toMatchObject({ code: 'amount' });
    const before = await balanceOf(db(), userId);

    const payout = await payouts.requestPayout(userId, 600_000);
    expect(payout).toMatchObject({ status: 'pending', credits: 600_000, paypalEmail: 'creator@example.com' });
    expect(await balanceOf(db(), userId)).toBe(before - 600_000);
    expect(await earnedRemaining(userId)).toBe(100_000);
    const [hold] = await entries(userId, payout.id);
    expect(hold).toMatchObject({ reason: 'payout_hold', delta: -600_000 });
    expect(hold!.allocations.every((allocation) => allocation.source === 'earned')).toBe(true);
    expect((await payouts.payoutOverview(userId)).stage).toBe('review');
    await expect(payouts.requestPayout(userId, 500_000)).rejects.toMatchObject({ code: 'payout_open' });
    /* Step 5's checkpoint: no official role while a payout is in progress. */
    await expect(roles.changeRole(reviewer, userId, 'official', 'Platform account')).rejects.toMatchObject({ code: 'payout_pending' });

    /* Default: everything withdrawable. */
    const other = await verifiedCreator(reviewer, 512_345);
    expect((await payouts.requestPayout(other, undefined)).credits).toBe(512_345);
  });

  it('rejection releases the hold once; approval keeps it; payment settles it and records the fee', async () => {
    const reviewer = await newAdministrator();
    const userId = await verifiedCreator(reviewer, 700_000);
    const first = await payouts.requestPayout(userId, 600_000);
    await expect(payouts.decidePayout(reviewer, first.id, 'rejected', 'no')).rejects.toMatchObject({ code: 'reason' });
    await expect(payouts.recordPayment(reviewer, first.id, { transferId: 'TX1', paid: '1' })).rejects.toMatchObject({ code: 'stale' });
    await payouts.decidePayout(reviewer, first.id, 'rejected', 'Earnings under review');
    await expect(payouts.decidePayout(reviewer, first.id, 'rejected', 'Earnings under review')).rejects.toMatchObject({ code: 'stale' });
    expect((await entries(userId, first.id)).map((entry) => [entry.reason, entry.delta])).toEqual([
      ['payout_hold', -600_000],
      ['payout_release', 600_000],
    ]);
    expect(await earnedRemaining(userId)).toBe(700_000);

    const second = await payouts.requestPayout(userId, 600_000);
    const balance = await balanceOf(db(), userId);
    await payouts.decidePayout(reviewer, second.id, 'approved', '');
    expect(await balanceOf(db(), userId)).toBe(balance);
    expect((await payouts.payoutOverview(userId)).stage).toBe('payment');
    await expect(payouts.decidePayout(reviewer, second.id, 'approved', '')).rejects.toMatchObject({ code: 'stale' });

    await expect(payouts.recordPayment(reviewer, second.id, { transferId: '', paid: '55.00' })).rejects.toMatchObject({ code: 'transfer_id' });
    for (const paid of ['0', '60.01', '55.001', '-1', 'abc']) {
      await expect(payouts.recordPayment(reviewer, second.id, { transferId: '5TY12345AB678901C', paid })).rejects.toMatchObject({ code: 'paid_amount' });
    }
    const paid = await payouts.recordPayment(reviewer, second.id, { transferId: '5TY12345AB678901C', paid: '55.00' });
    expect(paid).toMatchObject({ status: 'paid', paidCents: 5_500, feeCredits: 50_000, transferId: '5TY12345AB678901C', resolvedBy: reviewer });
    expect((await entries(userId, second.id)).map((entry) => [entry.reason, entry.delta])).toEqual([
      ['payout_hold', -600_000],
      ['payout_paid', 0],
    ]);
    expect(await balanceOf(db(), userId)).toBe(balance);
    expect(await earnedRemaining(userId)).toBe(100_000);
    await expect(payouts.failPayout(reviewer, second.id, 'Returned by PayPal')).rejects.toMatchObject({ code: 'stale' });
    await expect(payouts.recordPayment(reviewer, second.id, { transferId: 'OTHER', paid: '55.00' })).rejects.toMatchObject({ code: 'stale' });

    const audits = await adminAudit.listAudit(auditView({ q: second.id }));
    expect(audits.items.map((row) => row.action).sort()).toEqual(['payout.approved', 'payout.paid']);
    const notices = await db().select().from(schema.notice).where(and(eq(schema.notice.userId, userId), eq(schema.notice.kind, 'payout'))).orderBy(desc(schema.notice.createdAt));
    expect(notices[0]!.params).toMatchObject({ status: 'paid', credits: 600_000, paidCents: 5_500 });
  });

  it('a failed transfer releases the hold once; a transfer id is used once', async () => {
    const reviewer = await newAdministrator();
    const userId = await verifiedCreator(reviewer, 1_300_000);
    const first = await payouts.requestPayout(userId, 600_000);
    await payouts.decidePayout(reviewer, first.id, 'approved', 'Looks right');
    await payouts.recordPayment(reviewer, first.id, { transferId: 'DUPLICATE-1', paid: '60' });
    const second = await payouts.requestPayout(userId, 700_000);
    await payouts.decidePayout(reviewer, second.id, 'approved', '');
    await expect(payouts.recordPayment(reviewer, second.id, { transferId: 'DUPLICATE-1', paid: '70' })).rejects.toMatchObject({ code: 'transfer_used' });
    await expect(payouts.failPayout(reviewer, second.id, '')).rejects.toMatchObject({ code: 'reason' });
    /* A malformed id is "not found", not a database error. */
    await expect(payouts.failPayout(reviewer, 'not-a-uuid', 'Returned: account closed')).rejects.toMatchObject({ code: 'not_found' });
    await expect(kyc.kycFiles(reviewer, 'not-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
    await payouts.failPayout(reviewer, second.id, 'Returned: account closed');
    await expect(payouts.failPayout(reviewer, second.id, 'Returned: account closed')).rejects.toMatchObject({ code: 'stale' });
    expect((await entries(userId, second.id)).map((entry) => [entry.reason, entry.delta])).toEqual([
      ['payout_hold', -700_000],
      ['payout_release', 700_000],
    ]);
    expect(await earnedRemaining(userId)).toBe(700_000);
    const [row] = await db().select().from(schema.payout).where(eq(schema.payout.id, first.id));
    expect(row).toMatchObject({ paidCents: 6_000, feeCredits: 0 });
  });

  it('approval and payment need verified identity and a non-official account', async () => {
    const reviewer = await newAdministrator();
    const userId = await verifiedCreator(reviewer, 600_000);
    const payout = await payouts.requestPayout(userId, 600_000);
    const [current] = await db().select().from(schema.kycRecord).where(eq(schema.kycRecord.userId, userId)).orderBy(desc(schema.kycRecord.createdAt)).limit(1);
    await kyc.requestReverification(reviewer, current!.id, 'Document expired early');
    await expect(payouts.decidePayout(reviewer, payout.id, 'approved', '')).rejects.toMatchObject({ code: 'kyc_required' });
    expect((await payouts.payoutDetail(payout.id))!.payable).toBe(false);
    /* Rejection stays possible, and releases. */
    await payouts.decidePayout(reviewer, payout.id, 'rejected', 'Identity must be verified again');
    expect(await earnedRemaining(userId)).toBe(600_000);

    const official = await newUser('Official');
    await roles.changeRole(reviewer, official, 'official', 'Platform account');
    await earn(official, 900_000);
    expect((await payouts.payoutOverview(official)).stage).toBe('official');
    await expect(payouts.requestPayout(official, 600_000)).rejects.toMatchObject({ code: 'official' });
    await expect(payouts.setPaypalEmail(official, 'o@example.com')).rejects.toMatchObject({ code: 'official' });
  });

  it('lists the queue and the history with the same filters as their CSV', async () => {
    const reviewer = await newAdministrator();
    const userId = await verifiedCreator(reviewer, 1_500_000);
    const paid = await payouts.requestPayout(userId, 500_000);
    await payouts.decidePayout(reviewer, paid.id, 'approved', '');
    await payouts.recordPayment(reviewer, paid.id, { transferId: `T-${paid.id.slice(0, 8)}`, paid: '49.50' });
    const open = await payouts.requestPayout(userId, 600_000);

    const queue = await payouts.listPayouts(payoutQueueView({ q: userId }), 'queue');
    expect(queue.items.map((row) => row.id)).toEqual([open.id]);
    expect(queue.items[0]).toMatchObject({ kyc: 'verified', taxForm: 'W-8BEN', status: 'pending' });
    const history = await payouts.listPayouts(payoutHistoryView({ q: userId }), 'history');
    expect(history.items.map((row) => row.id)).toEqual([open.id, paid.id]);
    const onlyPaid = await payouts.listPayouts(payoutHistoryView({ q: userId, status: 'paid' }), 'history', { all: true });
    expect(onlyPaid.items).toHaveLength(1);
    expect(onlyPaid.items[0]).toMatchObject({ paidCents: 4_950, feeCredits: 5_000, resolver: expect.stringContaining('@example.test') });
    const byAmount = await payouts.listPayouts(payoutHistoryView({ q: userId, sort: 'amount-high' }), 'history');
    expect(byAmount.items.map((row) => row.credits)).toEqual([600_000, 500_000]);
    const counted = await db().execute(sql`select count(*)::int as n from payout where status in ('pending', 'approved')`);
    expect(queue.counts.open).toBe((counted.rows[0] as { n: number }).n);
  });
});

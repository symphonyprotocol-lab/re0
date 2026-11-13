/**
 * The payout minimum (lib/services/payout-minimum.ts): a site-wide value an
 * administrator sets, and an optional per-account value that replaces it
 * for that account, read inside the payout request's transaction.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

vi.mock('@/lib/infra/blob-access', () => ({
  blobInfo: async () => ({ size: 200_000, contentType: 'image/png' }),
  signedReadUrl: async (pathname: string) => ({ url: `https://blob.test/${pathname}`, expiresAt: new Date(Date.now() + 60_000) }),
  listByPrefix: async () => ({ blobs: [], cursor: null }),
}));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { db, schema } = await import('@/lib/infra/db');
const { addGrant } = await import('@/lib/services/credits');
const kyc = await import('@/lib/services/kyc');
const payouts = await import('@/lib/services/payouts');
const minimum = await import('@/lib/services/payout-minimum');
const { reportingDate } = await import('@/lib/domain/statistics');
const { PAYOUT_MIN_CREDITS } = await import('@/lib/constants');

const DAY = 86_400_000;

describeWithDb('the payout minimum: site-wide, or the account’s own', () => {
  let admin: string;
  beforeAll(async () => {
    await db().delete(schema.payoutSettings);
    const [row] = await db()
      .insert(schema.administrator)
      .values({ email: `${uniqueName('min-admin')}@example.test`, name: 'Min admin', role: 'owner', passwordHash: 'test', totpSecretCipher: 'test' })
      .returning();
    admin = row!.id;
  });
  afterAll(async () => {
    await db().delete(schema.payoutSettings);
  });

  /** Verified, with a PayPal address and `earned` matured withdrawable credits. */
  async function payable(earned: number): Promise<string> {
    const subject = uniqueName('payee');
    const [user] = await db().insert(schema.user).values({ name: 'Payee', email: `${subject}@example.test`, provider: 'github', providerSubject: subject }).returning();
    const userId = user!.id;
    const record = await kyc.submitKyc(userId, {
      legalName: 'Mei Lin',
      country: 'Malaysia',
      documentKind: 'passport',
      documentLast4: '2048',
      documentExpires: reportingDate(Date.now() + 365 * DAY),
      taxForm: 'W-8BEN',
      declared: true,
      consent: true,
      documentBlob: `kyc/${userId}/${randomUUID()}.png`,
      selfieBlob: `kyc/${userId}/${randomUUID()}.png`,
    });
    await kyc.decideKyc(admin, record.id, 'verified', { matched: true });
    await payouts.setPaypalEmail(userId, `${subject}@example.com`);
    await db().transaction((tx) => addGrant(tx, { userId, source: 'earned', amount: earned, reason: 'query_fee_earned', refId: randomUUID(), withdrawableAt: new Date(Date.now() - DAY) }));
    return userId;
  }
  const save = async (credits: unknown) => minimum.saveSitePayoutMinimum(admin, { credits, revision: (await minimum.sitePayoutMinimum()).revision });

  it('defaults to the constant and behaves as before', async () => {
    expect(await minimum.sitePayoutMinimum()).toEqual({ credits: PAYOUT_MIN_CREDITS, revision: 'default' });
    const short = await payable(PAYOUT_MIN_CREDITS - 1);
    expect(await payouts.payoutOverview(short)).toMatchObject({ stage: 'threshold', minimum: PAYOUT_MIN_CREDITS, minimumOverride: false });
    await expect(payouts.requestPayout(short, PAYOUT_MIN_CREDITS - 1)).rejects.toMatchObject({ code: 'below_minimum' });
    const enough = await payable(PAYOUT_MIN_CREDITS);
    expect(await payouts.requestPayout(enough, PAYOUT_MIN_CREDITS)).toMatchObject({ status: 'pending' });
  });

  it('a site-wide change applies to the next request, and does not re-judge one already made', async () => {
    const before = await payable(300_000);
    await expect(payouts.requestPayout(before, 300_000)).rejects.toMatchObject({ code: 'below_minimum' });
    await save(300_000);
    expect((await payouts.payoutOverview(before)).minimum).toBe(300_000);
    const made = await payouts.requestPayout(before, 300_000);
    /* Raised again after the request: approval still goes ahead, as approval never re-checks the minimum. */
    await save(900_000);
    expect(await payouts.decidePayout(admin, made.id, 'approved', '')).toMatchObject({ status: 'approved' });
    await save(PAYOUT_MIN_CREDITS);
  });

  it('an account’s own minimum replaces the site-wide one, lower or higher, until cleared', async () => {
    /* Lower: this account may request what others cannot. */
    const low = await payable(150_000);
    const other = await payable(150_000);
    await minimum.setUserPayoutMinimum(admin, low, { credits: 100_000 });
    expect(await payouts.payoutOverview(low)).toMatchObject({ stage: 'eligible', minimum: 100_000, minimumOverride: true });
    expect(await payouts.payoutStanding(low)).toMatchObject({ stage: 'eligible', minimum: 100_000 });
    await expect(payouts.requestPayout(low, 99_999)).rejects.toMatchObject({ code: 'below_minimum' });
    expect(await payouts.requestPayout(low, 120_000)).toMatchObject({ credits: 120_000, status: 'pending' });
    await expect(payouts.requestPayout(other, 150_000)).rejects.toMatchObject({ code: 'below_minimum' });

    /* Higher: this account is blocked while others with the same earnings are not. */
    const high = await payable(600_000);
    const peer = await payable(600_000);
    await minimum.setUserPayoutMinimum(admin, high, { credits: 800_000 });
    expect(await payouts.payoutOverview(high)).toMatchObject({ stage: 'threshold', minimum: 800_000, minimumOverride: true });
    await expect(payouts.requestPayout(high, 600_000)).rejects.toMatchObject({ code: 'below_minimum' });
    expect(await payouts.requestPayout(peer, 600_000)).toMatchObject({ status: 'pending' });

    /* Cleared: back to the site-wide value. */
    await minimum.setUserPayoutMinimum(admin, high, { credits: null });
    expect(await payouts.payoutOverview(high)).toMatchObject({ stage: 'eligible', minimum: PAYOUT_MIN_CREDITS, minimumOverride: false });
    expect(await payouts.requestPayout(high, 600_000)).toMatchObject({ status: 'pending' });

    /* An own minimum grants no exemption from the other gates. */
    const unverifiedSubject = uniqueName('unverified');
    const [unverified] = await db().insert(schema.user).values({ name: 'U', email: `${unverifiedSubject}@example.test`, provider: 'github', providerSubject: unverifiedSubject }).returning();
    await db().transaction((tx) => addGrant(tx, { userId: unverified!.id, source: 'earned', amount: 10_000, reason: 'query_fee_earned', refId: randomUUID(), withdrawableAt: new Date(Date.now() - DAY) }));
    await minimum.setUserPayoutMinimum(admin, unverified!.id, { credits: 1 });
    await expect(payouts.requestPayout(unverified!.id, 10_000)).rejects.toMatchObject({ code: 'kyc_required' });

    const audits = await db().select().from(schema.adminAudit).where(and(eq(schema.adminAudit.action, 'user.payout_minimum'), eq(schema.adminAudit.target, high)));
    expect(audits.map((row) => [row.before, row.after])).toEqual(
      expect.arrayContaining([
        [{ credits: null }, { credits: 800_000 }],
        [{ credits: 800_000 }, { credits: null }],
      ]),
    );
  });

  it('validates both settings, refuses a stale revision, and audits the site-wide change', async () => {
    const current = await minimum.sitePayoutMinimum();
    for (const credits of [0, -1, 1.5, 100_000_001, '500000', null]) {
      await expect(minimum.saveSitePayoutMinimum(admin, { credits, revision: current.revision })).rejects.toMatchObject({ code: 'invalid_payout_minimum' });
    }
    await expect(minimum.saveSitePayoutMinimum(admin, { credits: 400_000, revision: 'stale' })).rejects.toMatchObject({ code: 'pricing_conflict' });
    const results = await Promise.allSettled([
      minimum.saveSitePayoutMinimum(admin, { credits: 400_000, revision: current.revision }),
      minimum.saveSitePayoutMinimum(admin, { credits: 450_000, revision: current.revision }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const user = await payable(1);
    for (const credits of [0, -5, 2.5, 100_000_001, '100']) {
      await expect(minimum.setUserPayoutMinimum(admin, user, { credits })).rejects.toMatchObject({ code: 'invalid_payout_minimum' });
    }
    await expect(minimum.setUserPayoutMinimum(admin, randomUUID(), { credits: 10 })).rejects.toMatchObject({ code: 'not_found' });
    const [entry] = await db()
      .select()
      .from(schema.adminAudit)
      .where(and(eq(schema.adminAudit.action, 'payout.minimum.update'), eq(schema.adminAudit.administratorId, admin)))
      .limit(1);
    expect(entry).toMatchObject({ target: 'payout_minimum' });
    await save(PAYOUT_MIN_CREDITS);
  });
});

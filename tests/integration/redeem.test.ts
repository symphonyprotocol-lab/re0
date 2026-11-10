/**
 * Redeem codes against the database (docs/design/redeem-codes.md 8): a batch
 * and its codes, a Pack's credits, a redeemed Plan's months and what it
 * unlocks, how it lines up behind Paddle and earlier redeemed Plans, uses
 * never past a code's limit under concurrency, per-user limits, replays,
 * windows and status, wrong-guess limits, and a ledger every row of which
 * traces to its grants.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import { REDEEM_RATE_LIMIT } from '@/lib/constants';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createSession } = await import('@/lib/services/auth');
const { balanceOf } = await import('@/lib/services/credits');
const billing = await import('@/lib/services/billing');
const redeem = await import('@/lib/services/redeem');
const adminRedeem = await import('@/lib/services/admin-redeem');
const { redeemBatchView, redeemBatchesView } = await import('@/lib/domain/admin-lists');
const { openCredential } = await import('@/lib/infra/crypto/credentials');
const { db, schema } = await import('@/lib/infra/db');

const PRICES = { planPriceId: 'pri_test_plan', packPriceId: 'pri_test_pack' };
const CONFIG = {
  apiKey: 'test',
  webhookSecret: 'pdl_ntfset_test_secret',
  clientToken: 'test_client',
  environment: 'sandbox' as const,
  ...PRICES,
  checkoutUrl: 'http://localhost/checkout',
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = new Date('2027-03-10T08:00:00Z');

let administratorId = '';

async function newUser(): Promise<string> {
  const subject = uniqueName('redeemer');
  const session = await createSession(
    { provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'Redeemer', avatarUrl: null },
    'zh',
    '/dashboard',
    new Date('2027-01-01T00:00:00Z'),
  );
  return session.userId;
}

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26)}`;

function batch(raw: Record<string, unknown>, now = t0) {
  return adminRedeem.createBatch(administratorId, { name: uniqueName('batch'), ...raw }, now);
}

/** A redemption with a fresh IP, so wrong-guess limits from other cases never interfere. */
function use(userId: string, code: string, now = t0, extra: { requestId?: string; ip?: string } = {}) {
  return redeem.redeemCode(userId, { code, requestId: extra.requestId }, { now, ip: extra.ip ?? `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`, userAgent: 'vitest', cancelCheckout: async () => {} });
}

async function grantsOf(userId: string) {
  return db().select().from(schema.creditGrant).where(eq(schema.creditGrant.userId, userId)).orderBy(schema.creditGrant.createdAt);
}

async function entriesOf(userId: string) {
  return db().select().from(schema.creditEntry).where(eq(schema.creditEntry.userId, userId)).orderBy(schema.creditEntry.createdAt);
}

/** Every ledger row's allocations name this user's grants, and every grant holds exactly what its rows put there. */
async function expectLedgerTraceable(userId: string) {
  const grants = new Map((await grantsOf(userId)).map((grant) => [grant.id, grant]));
  const net = new Map<string, number>();
  for (const entry of await entriesOf(userId)) {
    expect(entry.allocations.reduce((sum, allocation) => sum + allocation.amount, 0), `${entry.reason} ${entry.delta}`).toBe(Math.abs(entry.delta));
    for (const allocation of entry.allocations) {
      expect(grants.get(allocation.grantId)?.source).toBe(allocation.source);
      net.set(allocation.grantId, (net.get(allocation.grantId) ?? 0) + Math.sign(entry.delta) * allocation.amount);
    }
  }
  for (const [grantId, grant] of grants) expect(net.get(grantId) ?? 0, grant.source).toBe(grant.remaining);
}

/** A Plan checkout row, as `startCheckout` writes it; a new subscription is mirrored only from one (review M5). */
async function planCheckout(userId: string): Promise<string> {
  const transactionId = id('txn');
  await db().insert(schema.paddleCheckout).values({ paddleTransactionId: transactionId, userId, kind: 'plan', quantity: 1, unitCredits: 50_000 });
  return transactionId;
}

function subscriptionEvent(userId: string, options: { subscriptionId: string; status?: string; period: [Date, Date]; cancel?: boolean; type?: string; transactionId?: string }) {
  return {
    event_id: id('evt'),
    event_type: options.type ?? 'subscription.updated',
    occurred_at: new Date().toISOString(),
    data: {
      id: options.subscriptionId,
      status: options.status ?? 'active',
      customer_id: 'ctm_test',
      custom_data: { re0_user_id: userId, re0_kind: 'plan' },
      current_billing_period: { starts_at: options.period[0].toISOString(), ends_at: options.period[1].toISOString() },
      scheduled_change: options.cancel ? { action: 'cancel', effective_at: options.period[1].toISOString() } : null,
      items: [{ price: { id: PRICES.planPriceId } }],
      updated_at: new Date(options.period[0].getTime() + (options.cancel ? 1_000 : 0)).toISOString(),
      transaction_id: options.transactionId ?? null,
    },
  };
}

describeWithDb('redeem codes', () => {
  beforeAll(async () => {
    const [admin] = await db()
      .insert(schema.administrator)
      .values({ email: `${uniqueName('redeem-admin')}@example.test`, name: 'Redeem admin', role: 'owner', passwordHash: 'test', totpSecretCipher: 'test' })
      .returning();
    administratorId = admin!.id;
  });

  it('generates a batch of unique codes, sealed for export, findable by whole code, and audited', async () => {
    const { batch: created, codes } = await batch({ kind: 'pack', packQuantity: 2, codeCount: 25, prefix: 'spring' });
    expect(codes).toHaveLength(25);
    expect(new Set(codes).size).toBe(25);
    for (const code of codes) expect(code).toMatch(/^SPRING-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}-[A-HJKMNP-TV-Z2-9]{4}$/);
    const unitPack = await (await import('@/lib/services/pricing')).currentUnitCredits(db(), 'pack');
    expect(created).toMatchObject({ kind: 'pack', packQuantity: 2, credits: unitPack * 2, codeCount: 25, maxRedemptions: 1, perUserLimit: 1, phase: 'active' });
    expect(created.expiresAt?.getTime()).toBe(t0.getTime() + 90 * DAY);

    const rows = await db().select().from(schema.redeemCode).where(eq(schema.redeemCode.batchId, created.id));
    expect(rows).toHaveLength(25);
    /* No plaintext at rest: only the digest, a sealed copy and the last four. */
    for (const row of rows) {
      expect(codes).not.toContain(row.codeSealed);
      expect(codes).toContain(await openCredential(row.codeSealed, 'redeem_code'));
    }

    const found = await adminRedeem.listBatches(redeemBatchesView({ q: codes[7]!.toLowerCase() }), {}, t0);
    expect(found.items.map((item) => item.id)).toEqual([created.id]);

    const exported = await adminRedeem.exportCodes(administratorId, created.id, redeemBatchView({}));
    expect(exported.rows.map((row) => row.code).sort()).toEqual([...codes].sort());
    const audits = await db().select().from(schema.adminAudit).where(eq(schema.adminAudit.target, created.id));
    expect(audits.map((row) => row.action).sort()).toEqual(['redeem.batch.create', 'redeem.batch.export']);

    /* A code that will not open fails the whole export, as "显示" does, and no export is recorded. */
    await db().update(schema.redeemCode).set({ codeSealed: 'bad.seal' }).where(eq(schema.redeemCode.id, rows[3]!.id));
    await expect(adminRedeem.exportCodes(administratorId, created.id, redeemBatchView({}))).rejects.toMatchObject({ code: 'sealed' });
    await expect(adminRedeem.revealCode(administratorId, rows[3]!.id)).rejects.toMatchObject({ code: 'sealed' });
    const after = await db().select().from(schema.adminAudit).where(eq(schema.adminAudit.target, created.id));
    expect(after.filter((row) => row.action === 'redeem.batch.export')).toHaveLength(1);
  });

  it('refuses a custom code that is taken, and bad settings', async () => {
    const custom = `RE0${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
    await batch({ kind: 'pack', packQuantity: 1, codeCount: 1, maxRedemptions: null, customCode: custom });
    await expect(batch({ kind: 'pack', packQuantity: 1, codeCount: 1, maxRedemptions: 5, customCode: custom.toLowerCase() })).rejects.toMatchObject({ code: 'custom_code_taken' });
    await expect(batch({ kind: 'plan', planMonths: 0, codeCount: 1 })).rejects.toMatchObject({ code: 'invalid_target' });
    await expect(batch({ kind: 'pack', packQuantity: 1, codeCount: 2, maxRedemptions: null })).rejects.toMatchObject({ code: 'invalid_limits' });
  });

  it('credits a Pack that never expires, without needing a Plan, and pays debts first', async () => {
    const userId = await newUser();
    const { batch: created, codes } = await batch({ kind: 'pack', packQuantity: 1, codeCount: 2 });
    await db().insert(schema.creditDebt).values({ userId, amount: 1_000, remaining: 1_000 });
    const before = await balanceOf(db(), userId, t0);
    const result = await use(userId, codes[0]!.toLowerCase().replace(/-/g, ' '));
    expect(result).toMatchObject({ ok: true, kind: 'pack', credits: created.credits, plan: null, balance: before + created.credits - 1_000 });
    const [grant] = (await grantsOf(userId)).filter((row) => row.source === 'pack');
    expect(grant).toMatchObject({ amount: created.credits, remaining: created.credits - 1_000, expiresAt: null, purchaseId: null, redemptionPeriod: 0 });
    const reasons = (await entriesOf(userId)).map((entry) => entry.reason);
    expect(reasons).toContain('redeem');
    expect(reasons).toContain('debt_offset');
    const entry = (await entriesOf(userId)).find((row) => row.reason === 'redeem');
    expect(entry?.note).toBe(`redeem ····${codes[0]!.slice(-4)} · pack x1`);
    /* Once per user per batch, even with another of its codes. */
    expect(await use(userId, codes[1]!)).toMatchObject({ ok: false, error: 'already_redeemed' });
    expect(await billing.hasActivePlan(db(), userId, t0)).toBe(false);
    await expectLedgerTraceable(userId);
  });

  it('gives a redeemed Plan month by month, with everything a Plan unlocks', async () => {
    const userId = await newUser();
    const { batch: created, codes } = await batch({ kind: 'plan', planMonths: 3, codeCount: 1 });
    const result = await use(userId, codes[0]!);
    expect(result).toMatchObject({ ok: true, kind: 'plan', plan: { startsAt: t0.toISOString(), endsAt: '2027-06-10T08:00:00.000Z', months: 3, queued: false } });

    const plans = () => grantsOf(userId).then((rows) => rows.filter((row) => row.source === 'plan'));
    expect(await plans()).toHaveLength(1);
    expect((await plans())[0]).toMatchObject({ amount: created.credits, remaining: created.credits, redemptionPeriod: 0 });
    expect((await plans())[0]!.expiresAt?.toISOString()).toBe('2027-04-10T08:00:00.000Z');

    expect(await billing.hasActivePlan(db(), userId, t0)).toBe(true);
    const summary = await billing.billingSummary(userId, t0);
    expect(summary.plan).toMatchObject({ active: true, source: 'redeemed', allowance: created.credits, used: 0, periodEnd: '2027-04-10T08:00:00.000Z', redeemedUntil: '2027-06-10T08:00:00.000Z' });

    /* Packs open up; a Paddle Plan does not, while the redeemed one lasts. */
    const create = async () => ({ id: id('txn') });
    expect((await billing.startCheckout(userId, { kind: 'pack', quantity: 1, consent: true }, { config: CONFIG, create, now: t0 })).ok).toBe(true);
    expect(await billing.startCheckout(userId, { kind: 'plan', consent: true }, { config: CONFIG, create, now: t0 })).toEqual({ ok: false, error: 'plan_redeemed_active' });

    /* The cron: the second month when it begins, the first written off; running again changes nothing. */
    const second = new Date('2027-04-10T09:00:00Z');
    await redeem.issueRedeemedPlanMonths(second);
    await redeem.issueRedeemedPlanMonths(second);
    expect((await plans()).map((row) => [row.redemptionPeriod, row.remaining])).toEqual([
      [0, 0],
      [1, created.credits],
    ]);
    expect((await entriesOf(userId)).filter((row) => row.reason === 'expire')).toHaveLength(1);
    expect((await billing.billingSummary(userId, second)).plan).toMatchObject({ active: true, source: 'redeemed', periodEnd: '2027-05-10T08:00:00.000Z' });

    /* Months the cron never saw are not back-filled; the current one is. */
    await redeem.issueRedeemedPlanMonths(new Date('2027-05-20T00:00:00Z'));
    expect((await plans()).map((row) => row.redemptionPeriod)).toEqual([0, 1, 2]);

    const after = new Date('2027-06-10T08:00:01Z');
    await redeem.issueRedeemedPlanMonths(after);
    expect(await plans()).toHaveLength(3);
    expect(await billing.hasActivePlan(db(), userId, after)).toBe(false);
    await billing.expireDuePlans(after);
    expect((await plans()).every((row) => row.remaining === 0)).toBe(true);
    await expectLedgerTraceable(userId);
  });

  it('issues a month as soon as it is due, then moves on; the meter keeps the snapshot until it arrives', async () => {
    const userId = await newUser();
    const { codes } = await batch({ kind: 'plan', planMonths: 2, codeCount: 1 });
    const result = await use(userId, codes[0]!);
    if (!result.ok) throw new Error(result.error);
    const row = async () => (await db().select().from(schema.redeemRedemption).where(eq(schema.redeemRedemption.id, result.redemptionId)))[0]!;
    /* Month 0 went out with the redemption; the cron's next stop is month 1. */
    expect((await row()).nextPeriodAt?.toISOString()).toBe('2027-04-10T08:00:00.000Z');

    /* A snapshot unlike today's Plan price: the one the code was issued at. */
    await db().update(schema.redeemRedemption).set({ credits: 12_345 }).where(eq(schema.redeemRedemption.id, result.redemptionId));
    const due = new Date('2027-04-10T08:00:30Z');
    expect((await billing.billingSummary(userId, due)).plan).toMatchObject({ active: true, source: 'redeemed', allowance: 12_345, used: 0, remaining: 12_345 });

    /* Not yet due: nothing happens. */
    await redeem.issueRedeemedPlanMonths(new Date('2027-04-10T07:59:00Z'));
    expect((await grantsOf(userId)).filter((grant) => grant.redemptionId)).toHaveLength(1);

    await redeem.issueRedeemedPlanMonths(due);
    expect((await grantsOf(userId)).filter((grant) => grant.redemptionId).map((grant) => [grant.redemptionPeriod, grant.amount])).toEqual([
      [0, expect.any(Number)],
      [1, 12_345],
    ]);
    /* That was the last month: the row leaves the cron's index. */
    expect((await row()).nextPeriodAt).toBeNull();
    await redeem.issueRedeemedPlanMonths(new Date('2027-05-01T00:00:00Z'));
    expect((await grantsOf(userId)).filter((grant) => grant.redemptionId)).toHaveLength(2);
    await expectLedgerTraceable(userId);
  });

  it('lines a redeemed Plan up behind earlier ones and a Paddle Plan whose renewal is off; refuses a renewing one', async () => {
    const months = await batch({ kind: 'plan', planMonths: 2, codeCount: 3 });
    const more = await batch({ kind: 'plan', planMonths: 1, codeCount: 3 });

    /* Back to back. */
    const stacker = await newUser();
    await use(stacker, months.codes[0]!);
    const second = await use(stacker, more.codes[0]!);
    expect(second).toMatchObject({ ok: true, plan: { startsAt: '2027-05-10T08:00:00.000Z', endsAt: '2027-06-10T08:00:00.000Z', queued: true } });
    expect((await billing.billingSummary(stacker, t0)).plan.redeemedUntil).toBe('2027-06-10T08:00:00.000Z');

    /* A Paddle Plan that renews: refused, nothing written. */
    const periodStart = new Date('2027-03-01T00:00:00Z');
    const periodEnd = new Date('2027-04-01T00:00:00Z');
    const subscriber = await newUser();
    const subscriptionId = id('sub');
    await billing.applyPaddleEvent(subscriptionEvent(subscriber, { subscriptionId, period: [periodStart, periodEnd], type: 'subscription.created', transactionId: await planCheckout(subscriber) }), PRICES, t0);
    expect(await use(subscriber, months.codes[1]!)).toEqual({ ok: false, error: 'plan_subscription_renewing' });
    expect((await db().select().from(schema.redeemCode).where(eq(schema.redeemCode.batchId, months.batch.id))).reduce((sum, row) => sum + row.redemptionCount, 0)).toBe(1);

    /* Renewal off: the redeemed Plan waits for the period's end, and an open Plan checkout is closed. */
    await billing.applyPaddleEvent(subscriptionEvent(subscriber, { subscriptionId, period: [periodStart, periodEnd], cancel: true }), PRICES, t0);
    const checkoutId = id('txn');
    await db().insert(schema.paddleCheckout).values({ paddleTransactionId: checkoutId, userId: subscriber, kind: 'plan', quantity: 1, createdAt: new Date(t0.getTime() - 10 * 60_000) });
    const cancelled: string[] = [];
    const queued = await redeem.redeemCode(subscriber, { code: months.codes[1] }, { now: t0, ip: '10.9.9.9', cancelCheckout: async (txn) => void cancelled.push(txn) });
    expect(queued).toMatchObject({ ok: true, plan: { startsAt: periodEnd.toISOString(), queued: true } });
    expect(cancelled).toEqual([checkoutId]);
    const [checkout] = await db().select().from(schema.paddleCheckout).where(eq(schema.paddleCheckout.paddleTransactionId, checkoutId));
    expect(checkout?.supersededAt).not.toBeNull();
    /* Nothing granted yet; the Paddle Plan is still the one in force. */
    expect((await grantsOf(subscriber)).filter((row) => row.source === 'plan' && row.redemptionId)).toHaveLength(0);
    expect((await billing.billingSummary(subscriber, t0)).plan).toMatchObject({ source: 'paddle', redeemedNext: periodEnd.toISOString() });
    /* Turning renewal back on would charge for a second Plan over the redeemed months: refused before Paddle is asked. */
    let resumed = false;
    const resume = async () => {
      resumed = true;
      throw new Error('Paddle must not be asked');
    };
    expect(await billing.setRenewal(subscriber, 'resume', { config: CONFIG, resume, now: t0 })).toEqual({ ok: false, error: 'plan_redeemed_queued' });
    expect(resumed).toBe(false);
    expect((await billing.subscriptionOf(db(), subscriber))?.cancelAtPeriodEnd).toBe(true);

    /* The cron starts it as soon as the Paddle period ends. */
    expect((await db().select().from(schema.redeemRedemption).where(eq(schema.redeemRedemption.userId, subscriber)))[0]?.nextPeriodAt?.toISOString()).toBe(periodEnd.toISOString());
    const handover = new Date(periodEnd.getTime() + 60_000);
    await redeem.issueRedeemedPlanMonths(handover);
    const [first] = (await grantsOf(subscriber)).filter((row) => row.redemptionId);
    expect(first).toMatchObject({ source: 'plan', redemptionPeriod: 0 });
    expect(first!.expiresAt?.toISOString()).toBe('2027-05-01T00:00:00.000Z');
    expect(await billing.planStateOf(db(), subscriber, handover)).toMatchObject({ active: true, source: 'redeemed' });

    /* Paddle still trying to collect: refused as checkout refuses it. */
    const lapsed = await newUser();
    await billing.applyPaddleEvent(subscriptionEvent(lapsed, { subscriptionId: id('sub'), status: 'past_due', period: [periodStart, periodEnd], type: 'subscription.created', transactionId: await planCheckout(lapsed) }), PRICES, t0);
    expect(await use(lapsed, months.codes[2]!)).toEqual({ ok: false, error: 'plan_renewal_pending' });
    for (const userId of [stacker, subscriber]) await expectLedgerTraceable(userId);
  });

  it('never lets a code go past its uses, however many redeem it at once', async () => {
    const { batch: created, codes } = await batch({ kind: 'pack', packQuantity: 1, codeCount: 1, maxRedemptions: 3 });
    const users = await Promise.all(Array.from({ length: 10 }, () => newUser()));
    const results = await Promise.all(users.map((userId) => use(userId, codes[0]!)));
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(results.filter((result) => !result.ok).map((result) => !result.ok && result.error)).toEqual(Array(7).fill('code_exhausted'));
    const [code] = await db().select().from(schema.redeemCode).where(eq(schema.redeemCode.batchId, created.id));
    expect(code?.redemptionCount).toBe(3);
    const [row] = await db().select().from(schema.redeemBatch).where(eq(schema.redeemBatch.id, created.id));
    expect(row?.redemptionCount).toBe(3);
    expect(await db().select().from(schema.redeemRedemption).where(eq(schema.redeemRedemption.batchId, created.id))).toHaveLength(3);
    /* Someone who got one of the uses and enters the code again is told they already have it, not that it ran out. */
    const winner = users[results.findIndex((result) => result.ok)]!;
    expect(await use(winner, codes[0]!)).toEqual({ ok: false, error: 'already_redeemed' });
  });

  it('answers a replayed request with the first answer, and counts per-user limits across the batch', async () => {
    const userId = await newUser();
    const { codes } = await batch({ kind: 'pack', packQuantity: 1, codeCount: 3, maxRedemptions: 5, perUserLimit: 2 });
    const requestId = randomUUID();
    const [first, again] = await Promise.all([use(userId, codes[0]!, t0, { requestId }), use(userId, codes[0]!, t0, { requestId })]);
    expect(first.ok && again.ok && first.redemptionId === again.redemptionId).toBe(true);
    expect(await db().select().from(schema.redeemRedemption).where(and(eq(schema.redeemRedemption.userId, userId), eq(schema.redeemRedemption.requestId, requestId)))).toHaveLength(1);
    /* The same id sent with another code is not a replay: that code is redeemed in its own right. */
    const other = await use(userId, codes[1]!, t0, { requestId });
    expect(other.ok && first.ok && other.redemptionId !== first.redemptionId).toBe(true);
    expect(await use(userId, codes[2]!)).toMatchObject({ ok: false, error: 'already_redeemed' });
    await expectLedgerTraceable(userId);
  });

  it('honours the window and the switches, and leaves what was redeemed alone', async () => {
    const userId = await newUser();
    const later = await batch({ kind: 'pack', packQuantity: 1, codeCount: 1, startsAt: new Date(t0.getTime() + DAY).toISOString() });
    expect(await use(userId, later.codes[0]!)).toEqual({ ok: false, error: 'code_not_started', startsAt: new Date(t0.getTime() + DAY).toISOString() });
    expect(await use(userId, later.codes[0]!, new Date(t0.getTime() + 91 * DAY + DAY))).toEqual({ ok: false, error: 'code_expired' });

    const { batch: created, codes } = await batch({ kind: 'pack', packQuantity: 1, codeCount: 3, perUserLimit: 3 });
    expect((await use(userId, codes[0]!)).ok).toBe(true);
    const balance = await balanceOf(db(), userId, t0);
    await adminRedeem.updateBatch(administratorId, created.id, { status: 'disabled' }, t0);
    expect(await use(userId, codes[1]!)).toEqual({ ok: false, error: 'code_disabled' });
    expect(await balanceOf(db(), userId, t0)).toBe(balance);
    await adminRedeem.updateBatch(administratorId, created.id, { status: 'active' }, t0);
    const [code] = await db().select().from(schema.redeemCode).where(and(eq(schema.redeemCode.batchId, created.id), eq(schema.redeemCode.codeLast4, codes[1]!.slice(-4))));
    await adminRedeem.setCodeStatus(administratorId, code!.id, 'disabled');
    expect(await use(userId, codes[1]!)).toEqual({ ok: false, error: 'code_disabled' });
    expect((await use(userId, codes[2]!)).ok).toBe(true);
    const actions = (await db().select().from(schema.adminAudit).where(eq(schema.adminAudit.target, created.id))).map((row) => row.action);
    expect(actions.filter((action) => action === 'redeem.batch.update')).toHaveLength(2);
    expect(actions).toContain('redeem.code.disable');
  });

  it('stops wrong guesses before the lookup, without counting real codes that cannot be used', async () => {
    const userId = await newUser();
    const ip = `10.77.${Math.floor(Math.random() * 255)}.1`;
    const now = new Date('2027-03-10T08:01:00Z');
    const userLimit = REDEEM_RATE_LIMIT.find((rule) => rule.scope === 'user')!.limit;
    const { codes } = await batch({ kind: 'pack', packQuantity: 1, codeCount: 1, expiresAt: new Date(t0.getTime() + HOUR).toISOString() });
    /* A real code past its expiry is not a guess. */
    for (let at = 0; at < userLimit + 2; at += 1) expect(await use(userId, codes[0]!, new Date(t0.getTime() + 2 * HOUR), { ip })).toMatchObject({ error: 'code_expired' });
    for (let at = 0; at < userLimit; at += 1) expect(await use(userId, `NOPE-${at}AAA-AAAA`, now, { ip })).toMatchObject({ error: 'code_not_found' });
    const { codes: good } = await batch({ kind: 'pack', packQuantity: 1, codeCount: 1 });
    const blocked = await use(userId, good[0]!, now, { ip });
    expect(blocked).toMatchObject({ ok: false, error: 'too_many_attempts' });
    expect(!blocked.ok && blocked.retryAfter).toBeGreaterThan(0);
    /* Another user on the same IP is still under the IP's limit; the window passing lets this user back in. */
    expect((await use(await newUser(), good[0]!, now, { ip })).ok).toBe(true);
    expect(await use(userId, good[0]!, new Date(now.getTime() + 16 * 60_000), { ip })).toMatchObject({ error: 'code_exhausted' });
  });

  it('lets no more wrong guesses reach the lookup than the limit, however many arrive at once', async () => {
    const now = new Date('2027-03-10T08:02:00Z');
    const userLimit = REDEEM_RATE_LIMIT.find((rule) => rule.scope === 'user')!.limit;
    const ipLimit = REDEEM_RATE_LIMIT.find((rule) => rule.scope === 'ip')!.limit;
    const guesser = await newUser();
    const guesses = await Promise.all(Array.from({ length: userLimit * 3 }, (_, at) => use(guesser, `NOPE-${at}BBB-BBBB`, now)));
    expect(guesses.filter((result) => !result.ok && result.error === 'code_not_found')).toHaveLength(userLimit);
    expect(guesses.filter((result) => !result.ok && result.error === 'too_many_attempts')).toHaveLength(userLimit * 2);

    /* One IP behind many accounts, each under its own limit. */
    const ip = `10.78.${Math.floor(Math.random() * 255)}.1`;
    const accounts = await Promise.all(Array.from({ length: Math.ceil((ipLimit * 2) / userLimit) }, () => newUser()));
    const fromIp = await Promise.all(accounts.flatMap((userId) => Array.from({ length: userLimit }, (_, at) => use(userId, `NOPE-${at}CCC-CCCC`, now, { ip }))));
    expect(fromIp.filter((result) => !result.ok && result.error === 'code_not_found')).toHaveLength(ipLimit);

    /* Codes that work give their slots back: a user can redeem past the guess limit. */
    const honest = await newUser();
    const { codes: shared } = await batch({ kind: 'pack', packQuantity: 1, codeCount: 1, maxRedemptions: userLimit * 2, perUserLimit: userLimit * 2 });
    for (let at = 0; at < userLimit * 2; at += 1) expect((await use(honest, shared[0]!, now)).ok).toBe(true);
  });
});

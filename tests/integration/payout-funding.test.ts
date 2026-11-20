/**
 * Where a payout's money came from (review H2, the rest of it): the review
 * page traces the earned credits a payout draws on back to the askers who
 * paid the query fees and to what they paid them from, and raises plain
 * signals -- one dominant payer, fresh accounts, askers who ask no one else,
 * a shared e-mail, fees at the maximum, refunded purchases. Read-only.
 *
 * Conversation answers (before migration 0070) are settled here with the
 * same calls, in the same order, as the conversations settled an answered
 * question's query fee (hold, settle, `paidShare`, one earned grant per
 * paying purchase plus one for the free part), and traced as 0070 left them
 * (`payout_trace_legacy`); private-post answers through posts.ts
 * `closeAnswer` itself.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

vi.mock('@/lib/infra/blob-access', () => ({
  blobInfo: async () => ({ size: 200_000, contentType: 'image/png' }),
  signedReadUrl: async (pathname: string) => ({ url: `https://blob.test/${pathname}`, expiresAt: new Date(Date.now() + 60_000) }),
  listByPrefix: async () => ({ blobs: [], cursor: null }),
  deleteBlobs: async () => undefined,
}));
vi.mock('@/lib/infra/blob', () => ({ uploadTicket: async (pathname: string) => ({ pathname, token: 'client-token' }) }));

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { addGrant, paidShare, placeHold, settleHold } = await import('@/lib/services/credits');
const kyc = await import('@/lib/services/kyc');
const payouts = await import('@/lib/services/payouts');
const { payoutFunding, payoutFundingLines } = await import('@/lib/services/payout-funding');
const { reportingDate } = await import('@/lib/domain/statistics');
const { EARNED_MATURITY_DAYS, QUERY_BASE_FEE, QUERY_FEE } = await import('@/lib/constants');
const { closeAnswer } = await import('@/lib/services/posts');
const { db, schema } = await import('@/lib/infra/db');

const DAY = 24 * 60 * 60 * 1000;

async function newUser(prefix: string, options: { createdAt?: Date; paypalEmail?: string; email?: string } = {}) {
  const subject = uniqueName(prefix);
  const [row] = await db()
    .insert(schema.user)
    .values({ name: prefix, email: options.email ?? `${subject}@example.test`, provider: 'github', providerSubject: subject, paypalEmail: options.paypalEmail ?? null, createdAt: options.createdAt ?? new Date() })
    .returning();
  return row!;
}

async function newAdministrator() {
  const [row] = await db()
    .insert(schema.administrator)
    .values({ name: 'Reviewer', email: `${uniqueName('admin')}@example.test`, passwordHash: 'x', totpSecretCipher: 'x' })
    .returning();
  return row!;
}

async function newRee(ownerId: string, queryFee: number) {
  const [row] = await db().insert(schema.ree).values({ ownerId, name: 'Funded', slug: uniqueName('funded'), queryFee, isPublic: true, isPublished: true }).returning();
  return row!;
}

/** A Pack bought through Paddle: the purchase and its grant. */
async function boughtPack(userId: string, credits: number) {
  const [purchase] = await db()
    .insert(schema.purchase)
    .values({ userId, kind: 'pack', paddleTransactionId: `txn_${randomUUID().replace(/-/g, '')}`, amountMinor: 1000, credits })
    .returning();
  await db().transaction((tx) => addGrant(tx, { userId, source: 'pack', amount: credits, reason: 'purchase', refId: purchase!.id, purchaseId: purchase!.id }));
  return purchase!;
}

/**
 * One answered conversation question from before migration 0070, its query
 * fee settled the way the conversations settled it, and its reply traced as
 * 0070 kept it (`payout_trace_legacy`) once the messages were gone.
 */
async function ask(askerId: string, ree: { id: string; ownerId: string; name: string }, fee: number) {
  const questionId = randomUUID();
  const replyId = randomUUID();
  /* A `chat` hold then; nothing places one now, and the kind plays no part in the trace. */
  const holdId = await db().transaction((tx) => placeHold(tx, { userId: askerId, kind: 'post', amount: fee, refId: questionId, reeId: ree.id, ledger: 'chat_fee' }));
  await db().transaction(async (tx) => {
    const paid = await settleHold(tx, holdId, fee, { reeId: ree.id, note: ree.name, ledger: 'chat_fee' });
    const share = await paidShare(tx, paid!.chargedAllocations);
    const matures = new Date(Date.now() + EARNED_MATURITY_DAYS * DAY);
    const credit = (amount: number, withdrawableAt: Date | null, fundingPurchaseId: string | null) =>
      addGrant(tx, { userId: ree.ownerId, source: 'earned', amount, reason: 'query_fee_earned', refId: replyId, reeId: ree.id, note: ree.name, withdrawableAt, fundingPurchaseId });
    for (const [purchaseId, amount] of share.byPurchase) if (amount > 0) await credit(amount, matures, purchaseId);
    if (share.free > 0) await credit(share.free, null, null);
    await tx.insert(schema.payoutTraceLegacy).values({ replyId, requestId: questionId, reeId: ree.id, askerId, askedAt: new Date() });
  });
}

/**
 * One answered private-post question (private-posts.ts): the base fee and the
 * query fee held against the answer row, then settled by posts.ts
 * `closeAnswer`, which credits the owner with the answer as the reference.
 */
async function askPost(askerId: string, ree: { id: string; ownerId: string; name: string }, fee: number) {
  const postId = randomUUID();
  const answerId = randomUUID();
  await db().transaction(async (tx) => {
    await tx.insert(schema.post).values({ id: postId, userId: askerId, source: 'post', visibility: 'private', question: 'question', lang: 'en', status: 'published', publishedAt: new Date(), answerState: 'answering' });
    await tx.insert(schema.postAnswer).values({ id: answerId, postId, reeId: ree.id, state: 'answering', mentioned: true });
    const baseHoldId = await placeHold(tx, { userId: askerId, kind: 'post', ledger: 'post_answer', amount: QUERY_BASE_FEE, refId: answerId, reeId: ree.id, note: 'post answer' });
    const feeHoldId = await placeHold(tx, { userId: askerId, kind: 'post', ledger: 'chat_fee', amount: fee, refId: answerId, reeId: ree.id, note: ree.name });
    await tx.update(schema.postAnswer).set({ baseHoldId, feeHoldId, price: QUERY_BASE_FEE + fee }).where(eq(schema.postAnswer.id, answerId));
  });
  await closeAnswer(answerId, { state: 'answered', text: 'answer', citations: [], model: 'stub' }, new Date());
}

/** The asker asked a Ree of another owner once (its base fee entry), so they are active elsewhere. */
async function askedElsewhere(askerId: string, otherReeId: string) {
  await db().insert(schema.creditEntry).values({ userId: askerId, delta: -20, reason: 'query_base', refId: randomUUID(), reeId: otherReeId });
}

async function verifiedOwner(reviewer: string, paypal: string) {
  const owner = await newUser('owner', { createdAt: new Date(Date.now() - 400 * DAY) });
  const record = await kyc.submitKyc(owner.id, {
    legalName: 'Mei Lin',
    country: 'Malaysia',
    documentKind: 'passport',
    documentLast4: '2048',
    documentExpires: reportingDate(Date.now() + 365 * DAY),
    taxForm: 'W-8BEN',
    declared: true,
    consent: true,
    documentBlob: `kyc/${owner.id}/${randomUUID()}.png`,
    selfieBlob: `kyc/${owner.id}/${randomUUID()}.png`,
  });
  await kyc.decideKyc(reviewer, record.id, 'verified', { matched: true });
  await payouts.setPaypalEmail(owner.id, paypal);
  /* The PayPal change hold does not apply to a first address set long ago. */
  await db().update(schema.user).set({ paypalEmailChangedAt: new Date(Date.now() - 30 * DAY) }).where(eq(schema.user.id, owner.id));
  return owner;
}

describeWithDb('the payout review page shows where the money came from (review H2)', () => {
  it('traces one dominant fresh payer, a spread of normal payers, mixed funding and a refunded purchase', async () => {
    const administrator = await newAdministrator();
    const paypal = `${uniqueName('payee')}@example.com`;
    const owner = await verifiedOwner(administrator.id, paypal);
    const ree = await newRee(owner.id, QUERY_FEE.max);
    const cheap = await newRee(owner.id, 5_000);
    const other = await newRee((await newUser('elsewhere')).id, 100);

    /* The dominant payer: signed up today, asks only this owner, 45 questions at the highest fee. */
    const dominant = await newUser('dominant');
    await boughtPack(dominant.id, 450_000);
    for (let i = 0; i < 45; i += 1) await ask(dominant.id, ree, QUERY_FEE.max);

    /* Eight ordinary payers, a hundred days old, who ask elsewhere too: two questions of 5 000 each. */
    const old = new Date(Date.now() - 100 * DAY);
    const normal: Awaited<ReturnType<typeof newUser>>[] = [];
    for (let i = 0; i < 8; i += 1) {
      const shared = i === 0;
      const user = await newUser(`normal${i}`, { createdAt: old, paypalEmail: shared ? paypal.replace('@', '+alt@').toUpperCase() : undefined });
      await askedElsewhere(user.id, other.id);
      normal.push(user);
    }
    /* normal[1] pays 2 000 of its first fee from welcome credits; normal[2]'s Pack is refunded later. */
    await db().transaction((tx) => addGrant(tx, { userId: normal[1]!.id, source: 'welcome', amount: 2_000, reason: 'welcome', refId: normal[1]!.id }));
    let refundedPurchase = '';
    for (const [index, user] of normal.entries()) {
      const purchase = await boughtPack(user.id, index === 1 ? 8_000 : 10_000);
      if (index === 2) refundedPurchase = purchase.id;
      await ask(user.id, cheap, 5_000);
      await ask(user.id, cheap, 5_000);
    }
    await db().update(schema.purchase).set({ status: 'refunded', reversedCredits: 10_000 }).where(eq(schema.purchase.id, refundedPurchase));

    /* Everything paid for has matured; the free part never does. */
    await db()
      .update(schema.creditGrant)
      .set({ withdrawableAt: new Date(Date.now() - DAY) })
      .where(and(eq(schema.creditGrant.userId, owner.id), eq(schema.creditGrant.source, 'earned'), isNotNull(schema.creditGrant.withdrawableAt)));

    const drawn = 450_000 + 80_000 - 2_000;
    const payout = await payouts.requestPayout(owner.id, drawn);
    /* One more question after the request: maturing, and not part of this payout. */
    await boughtPack(normal[3]!.id, 5_000);
    await ask(normal[3]!.id, cheap, 5_000);

    const funding = await payoutFunding(administrator, payout.id, owner.id, 7);
    const s = funding.summary;
    expect(s).toMatchObject({ drawn, traced: drawn, payers: 9, questions: 61, drawnRefunded: 10_000, sharedIdentity: 1 });
    expect(s.topShare).toBeCloseTo(450_000 / drawn, 6);
    expect(s.top3Share).toBeCloseTo((450_000 + 10_000 + 10_000) / drawn, 6);
    expect(s.fresh).toEqual({ payers: 1, share: 450_000 / drawn });
    expect(s.exclusive).toEqual({ payers: 1, share: 450_000 / drawn });
    expect(s.maxFee).toEqual({ questions: 45, share: 45 / 61 });
    expect(s.sources).toEqual({ paid: drawn, invite: 0, welcome: 2_000, redeemed: 0, console: 0, earnedFree: 0, refunded: 10_000 });
    expect(s.flags.sort()).toEqual(['exclusive_payers', 'fresh_payers', 'max_fee', 'refunded', 'shared_identity', 'top_payer']);

    const [top, ...rest] = s.ranked;
    expect(top).toMatchObject({ userId: dominant.id, credits: 450_000, questions: 45, maxFeeQuestions: 45, fresh: true, exclusive: true, disabled: false, sharesIdentity: false });
    expect(rest.every((payer) => !payer.fresh && !payer.exclusive)).toBe(true);
    expect(rest.find((payer) => payer.userId === normal[0]!.id)).toMatchObject({ sharesIdentity: true });
    expect(rest.find((payer) => payer.userId === normal[1]!.id)).toMatchObject({ credits: 8_000, questions: 2 });
    /* A page past the end lands on the last one. */
    expect(funding.payers).toMatchObject({ total: 9, page: 1 });
    expect(funding.payers.items).toHaveLength(9);

    expect(funding.maturity).toMatchObject({ withdrawable: 0, maturing: 5_000, later: 0, locked: 2_000 });
    expect(funding.maturity.schedule).toHaveLength(1);

    const lines = await payoutFundingLines(administrator, [payout.id]);
    expect(lines.get(payout.id)).toMatchObject({ payers: 9, flags: expect.arrayContaining(['top_payer', 'refunded']) });
    expect(lines.get(payout.id)!.topShare).toBeCloseTo(450_000 / drawn, 6);

    /* The existing refusal is untouched: signals never block, the review rules still decide. */
    expect((await payouts.payoutDetail(payout.id))!.payable).toBe(true);
  });

  it('a spread of ordinary payers raises no signal', async () => {
    const administrator = await newAdministrator();
    const owner = await verifiedOwner(administrator.id, `${uniqueName('calm')}@example.com`);
    const ree = await newRee(owner.id, 5_000);
    const other = await newRee((await newUser('elsewhere')).id, 100);
    const old = new Date(Date.now() - 200 * DAY);
    for (let i = 0; i < 10; i += 1) {
      const user = await newUser(`calm${i}`, { createdAt: old });
      await askedElsewhere(user.id, other.id);
      await boughtPack(user.id, 50_000);
      for (let q = 0; q < 10; q += 1) await ask(user.id, ree, 5_000);
    }
    await db()
      .update(schema.creditGrant)
      .set({ withdrawableAt: new Date(Date.now() - DAY) })
      .where(and(eq(schema.creditGrant.userId, owner.id), eq(schema.creditGrant.source, 'earned'), isNotNull(schema.creditGrant.withdrawableAt)));
    const payout = await payouts.requestPayout(owner.id, 500_000);
    const { summary } = await payoutFunding(administrator, payout.id, owner.id);
    expect(summary).toMatchObject({ drawn: 500_000, traced: 500_000, payers: 10, questions: 100, flags: [] });
    expect(summary.topShare).toBeCloseTo(0.1, 6);
    expect(summary.top3Share).toBeCloseTo(0.3, 6);
    /* A hundred settled questions: about five seconds on a laptop, at the default limit even before this change. */
  }, 20_000);

  it('traces earnings from private-post answers next to those from conversations, to whoever asked', async () => {
    const administrator = await newAdministrator();
    const owner = await verifiedOwner(administrator.id, `${uniqueName('posts')}@example.com`);
    const ree = await newRee(owner.id, QUERY_FEE.max);
    const other = await newRee((await newUser('elsewhere')).id, 100);
    const old = new Date(Date.now() - 200 * DAY);
    const chatter = await newUser('chatter', { createdAt: old });
    const poster = await newUser('poster', { createdAt: old });
    for (const user of [chatter, poster]) {
      await askedElsewhere(user.id, other.id);
      await boughtPack(user.id, 30 * (QUERY_FEE.max + QUERY_BASE_FEE));
    }
    for (let q = 0; q < 25; q += 1) await ask(chatter.id, ree, QUERY_FEE.max);
    for (let q = 0; q < 25; q += 1) await askPost(poster.id, ree, QUERY_FEE.max);
    await db()
      .update(schema.creditGrant)
      .set({ withdrawableAt: new Date(Date.now() - DAY) })
      .where(and(eq(schema.creditGrant.userId, owner.id), eq(schema.creditGrant.source, 'earned'), isNotNull(schema.creditGrant.withdrawableAt)));
    const drawn = 50 * QUERY_FEE.max;
    const payout = await payouts.requestPayout(owner.id, drawn);
    const { summary } = await payoutFunding(administrator, payout.id, owner.id);
    expect(summary).toMatchObject({ drawn, traced: drawn, payers: 2, questions: 50 });
    expect(summary.sources).toMatchObject({ paid: drawn });
    expect(summary.ranked.map((payer) => [payer.userId, payer.credits, payer.questions, payer.maxFeeQuestions]).sort()).toEqual(
      [
        [chatter.id, 25 * QUERY_FEE.max, 25, 25],
        [poster.id, 25 * QUERY_FEE.max, 25, 25],
      ].sort(),
    );
  }, 20_000);

  it('earned credits granted in the console count as drawn but not traced', async () => {
    const administrator = await newAdministrator();
    const owner = await verifiedOwner(administrator.id, `${uniqueName('granted')}@example.com`);
    await db().transaction((tx) => addGrant(tx, { userId: owner.id, source: 'earned', amount: 600_000, reason: 'admin_adjust', refId: randomUUID(), withdrawableAt: new Date(Date.now() - DAY) }));
    const payout = await payouts.requestPayout(owner.id, 600_000);
    const { summary } = await payoutFunding(administrator, payout.id, owner.id);
    expect(summary).toMatchObject({ drawn: 600_000, traced: 0, payers: 0, flags: [] });
  });
});

/**
 * The channel money rules the P1-P5 review found open (docs/reviews/
 * agent-first-p1-p5-review.md H3-H5, M15-M17), against a real database:
 *
 * - a channel with a subscriber who still reads or may still be billed is
 *   not deleted; once they have ended it is, and a refund arriving after
 *   that still reaches the creator's ledger;
 * - a payout or a redeem never takes more than the balance, so income a
 *   chargeback already took back (booked in a period not yet settled) stays;
 * - one Paddle subscription is one row, whichever of its notices names the
 *   subscription first, and a refund then revokes access;
 * - a channel-tagged transaction for another product, another currency or
 *   less than the plan's price is recorded and grants nothing;
 * - a refund of the current period cancels the provider subscription, and a
 *   checkout is refused while one may still renew;
 * - an event dated into a locked period lands in the open one.
 *
 * Paddle is replaced by fabricated, already-verified notifications fed to
 * the webhook use case, and by a recording adapter.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';
process.env.APP_BASE_URL ??= 'https://app.example.test';

const channels = await import('@/lib/application/channels');
const subscriptions = await import('@/lib/application/channels/subscriptions');
const { applyPaymentNotification } = await import('@/lib/application/billing/webhook');
const { requestPayout, redeemEarningsAsCalls, creatorBalance, periodIdOf } = await import('@/lib/application/revenue');
const { generateSettlements } = await import('@/lib/application/administration');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
const { PaymentProviderError } = await import('@/lib/infrastructure/payment/provider');

const stamp = Date.now().toString(36);
const workspaces: string[] = [];
const users: string[] = [];
const administratorId = uuidv7();
const OPERATOR = { administratorId, email: 'money-ops@example.test' };
const DAY = 86_400_000;

interface Person {
  userId: string;
  workspaceId: string;
}

async function person(label: string): Promise<Person> {
  const database = db();
  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  users.push(userId);
  workspaces.push(workspaceId);
  await database.insert(schema.user).values({ id: userId, email: `money-${label}-${stamp}@example.test`, displayName: `Money ${label}` });
  await database.insert(schema.workspace).values({ id: workspaceId, name: `Money ${label}`, handle: `money-${label}-${stamp}` });
  await database.insert(schema.workspaceMember).values({ workspaceId, userId, role: 'owner' });
  return { userId, workspaceId };
}

function owner(p: Person) {
  return { workspaceId: p.workspaceId, role: 'owner' as const, userId: p.userId };
}

/** A selling channel of `creator`'s: $6 a month, $60 a year. */
async function sellingChannel(creator: Person, slug: string) {
  const channel = await channels.createChannel({ ...owner(creator), slug: `${slug}-${stamp}`, title: `Money ${slug}` });
  await subscriptions.enableSubscriptions({ ...owner(creator), channelId: channel.id, confirmRights: true });
  const monthly = await subscriptions.setChannelPlan({ ...owner(creator), channelId: channel.id, interval: 'month', price: '6' });
  const yearly = await subscriptions.setChannelPlan({ ...owner(creator), channelId: channel.id, interval: 'year', price: '60' });
  return { ...channel, monthly, yearly };
}

/** A Paddle adapter that records what it was asked to do. */
function recordingAdapter(options: { cancelFails?: number } = {}) {
  const cancels: { id: string; options: unknown }[] = [];
  const checkouts: unknown[] = [];
  const adapter = {
    provider: 'paddle',
    async cancelSubscription(id: string, cancelOptions?: unknown) {
      if (options.cancelFails) throw new PaymentProviderError('paddle POST cancel: refused', options.cancelFails);
      cancels.push({ id, options: cancelOptions });
    },
    async createChannelCheckout(input: unknown) {
      checkouts.push(input);
      return { externalId: `txn_checkout_${checkouts.length}`, url: 'https://pay.example.test' };
    },
  };
  return { adapter: adapter as never, cancels, checkouts };
}

let sequence = 0;

/** What Paddle's verified `transaction.*` notice looks like to the use case. */
function sale(input: {
  planVersionId: string;
  subscriber: Person;
  subscriptionId: string | null;
  transactionId: string;
  exTaxMinor: number;
  listPriceMinor?: number;
  discountMinor?: number;
  currency?: string;
  onChannelProduct?: boolean;
  collectedAt?: Date;
  periodEnd?: Date;
  adjustments?: { id: string; action: 'refund' | 'chargeback'; exTaxMinor: number; at?: Date }[];
}) {
  sequence += 1;
  const collectedAt = input.collectedAt ?? new Date();
  return {
    provider: 'paddle',
    externalEventId: `evt_money_${stamp}_${sequence}`,
    eventType: 'transaction.completed',
    payload: {},
    subject: 'channel_transaction' as const,
    channel: {
      transactionId: input.transactionId,
      subscriptionExternalId: input.subscriptionId,
      customerId: `ctm_money_${stamp}`,
      state: 'collected' as const,
      channelPlanVersionId: input.planVersionId,
      userId: input.subscriber.userId,
      workspaceId: input.subscriber.workspaceId,
      exTaxMinor: input.exTaxMinor,
      currency: input.currency ?? 'USD',
      onChannelProduct: input.onChannelProduct ?? true,
      listPriceMinor: input.listPriceMinor ?? input.exTaxMinor,
      discountMinor: input.discountMinor ?? 0,
      collectedAt,
      periodEnd: input.periodEnd ?? new Date(collectedAt.getTime() + 30 * DAY),
      adjustments: (input.adjustments ?? []).map((adjustment) => ({
        id: adjustment.id,
        action: adjustment.action,
        status: 'approved',
        exTaxMinor: adjustment.exTaxMinor,
        observedAt: adjustment.at ?? new Date(),
      })),
      observedAt: new Date(),
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  return 'resolved';
}

async function rowsOf(subscriber: Person, channelId: string) {
  return db()
    .select()
    .from(schema.channelSubscription)
    .where(and(eq(schema.channelSubscription.userId, subscriber.userId), eq(schema.channelSubscription.channelId, channelId)));
}

async function verifiedProfile(creator: Person) {
  await db()
    .update(schema.publisherAccount)
    .set({ taxFormKind: 'W-9', taxFormStatus: 'verified', payeeEmail: 'creator@example.test' })
    .where(eq(schema.publisherAccount.workspaceId, creator.workspaceId));
}

describeWithDb('channel money: deletion, balance caps, one row per subscription, sale checks, refunds, late events', () => {
  beforeAll(async () => {
    await db().insert(schema.administrator).values({
      id: administratorId,
      email: OPERATOR.email,
      username: `money-ops-${stamp}`,
      passwordHash: 'unused',
      status: 'active',
    });
  });

  afterAll(async () => {
    const database = db();
    if (workspaces.length > 0) {
      const accounts = (await database.select({ id: schema.publisherAccount.id }).from(schema.publisherAccount).where(inArray(schema.publisherAccount.workspaceId, workspaces))).map((row) => row.id);
      if (accounts.length > 0) {
        await database.delete(schema.settlement).where(inArray(schema.settlement.publisherAccountId, accounts));
        await database.delete(schema.payout).where(inArray(schema.payout.publisherAccountId, accounts));
        await database.delete(schema.addonGrant).where(inArray(schema.addonGrant.publisherAccountId, accounts));
        await database.delete(schema.publisherAccount).where(inArray(schema.publisherAccount.id, accounts));
      }
      await database.delete(schema.earningEvent).where(inArray(schema.earningEvent.ownerWorkspaceId, workspaces));
      await database.delete(schema.channelSubscription).where(inArray(schema.channelSubscription.workspaceId, workspaces));
      await database.delete(schema.workspaceMember).where(inArray(schema.workspaceMember.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    await database.delete(schema.revenuePeriod).where(like(schema.revenuePeriod.id, '2018-%'));
    await database.delete(schema.paymentEvent).where(like(schema.paymentEvent.externalEventId, `evt_money_${stamp}_%`));
    if (users.length > 0) await database.delete(schema.user).where(inArray(schema.user.id, users));
    await database.delete(schema.auditLog).where(eq(schema.auditLog.administratorId, administratorId));
    await database.delete(schema.administrator).where(eq(schema.administrator.id, administratorId));
  });

  it('H3: refuses to delete a channel while a subscriber reads or may be billed, then deletes it, and a late refund still reaches the ledger', async () => {
    const creator = await person('del');
    const reader = await person('delr');
    const channel = await sellingChannel(creator, 'money-del');
    const { adapter, cancels } = recordingAdapter();
    const transactionId = `txn_money_${stamp}_del`;
    const subscriptionId = `sub_money_${stamp}_del`;
    const paid = () => sale({ planVersionId: channel.monthly.id, subscriber: reader, subscriptionId, transactionId, exTaxMinor: 600 });
    expect(await applyPaymentNotification(paid(), adapter)).toBe('applied');

    expect(await refusal(channels.deleteChannel({ ...owner(creator), channelId: channel.id }))).toBe('has_subscribers');
    /* Cancelled at the period's end: still reading, so still refused. */
    await db().update(schema.channelSubscription).set({ cancelAtPeriodEnd: true }).where(eq(schema.channelSubscription.providerSubscriptionId, subscriptionId));
    expect(await refusal(channels.deleteChannel({ ...owner(creator), channelId: channel.id }))).toBe('has_subscribers');
    /* Past due with the period over: no access, but the provider may still collect. */
    await db()
      .update(schema.channelSubscription)
      .set({ status: 'past_due', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() - DAY) })
      .where(eq(schema.channelSubscription.providerSubscriptionId, subscriptionId));
    expect(await refusal(channels.deleteChannel({ ...owner(creator), channelId: channel.id }))).toBe('has_subscribers');

    /* It ends at the provider: now the channel goes, and nothing was asked of Paddle. */
    await db().update(schema.channelSubscription).set({ status: 'canceled' }).where(eq(schema.channelSubscription.providerSubscriptionId, subscriptionId));
    expect(await channels.deleteChannel({ ...owner(creator), channelId: channel.id })).toEqual({ releasedAssets: 0 });
    expect(cancels).toEqual([]);

    /* A refund of that last payment, after the channel is gone, still takes the creator's share back. */
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(480);
    const refunded = sale({
      planVersionId: channel.monthly.id,
      subscriber: reader,
      subscriptionId,
      transactionId,
      exTaxMinor: 600,
      adjustments: [{ id: `adj_money_${stamp}_del`, action: 'refund', exTaxMinor: 600 }],
    });
    expect(await applyPaymentNotification(refunded, adapter)).toBe('applied');
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(0);
  });

  it('H4: a payout and a redeem stop at the balance when a chargeback is booked in a period not yet settled', async () => {
    const creator = await person('cap');
    const first = await person('capa');
    const second = await person('capb');
    const channel = await sellingChannel(creator, 'money-cap');
    const { adapter } = recordingAdapter();
    const year = (subscriber: Person, tag: string, collectedAt: Date, adjustments: Parameters<typeof sale>[0]['adjustments'] = []) =>
      sale({
        planVersionId: channel.yearly.id,
        subscriber,
        subscriptionId: `sub_money_${stamp}_${tag}`,
        transactionId: `txn_money_${stamp}_${tag}`,
        exTaxMinor: 6_000,
        collectedAt,
        periodEnd: new Date(Date.now() + 300 * DAY),
        adjustments,
      });
    await applyPaymentNotification(year(first, 'cap1', new Date(Date.UTC(2018, 0, 10))), adapter);
    await applyPaymentNotification(year(second, 'cap2', new Date(Date.UTC(2018, 1, 10))), adapter);
    for (const periodId of ['2018-01', '2018-02']) {
      await generateSettlements({ actor: OPERATOR, periodId, reason: 'money fixture close' });
    }
    await db().update(schema.revenuePeriod).set({ lockedAt: new Date(Date.now() - 200 * DAY) }).where(inArray(schema.revenuePeriod.id, ['2018-01', '2018-02']));
    await verifiedProfile(creator);

    /* January's sale is charged back today: booked into the open month, in no statement yet. */
    await applyPaymentNotification(year(first, 'cap1', new Date(Date.UTC(2018, 0, 10)), [{ id: `adj_money_${stamp}_cap1`, action: 'chargeback', exTaxMinor: 6_000 }]), adapter);
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(4_800);

    /* Two released statements of 4,800 each, a balance of 4,800: the redeem takes one, not both. */
    const redeemed = await redeemEarningsAsCalls({ workspaceId: creator.workspaceId, actor: { kind: 'user', id: creator.userId } });
    expect(redeemed.amountMinor).toBe(4_800);
    expect(redeemed.statements).toBe(1);
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(0);

    /* Nothing is left that the balance covers: the other statement stays accrued. */
    expect(await refusal(requestPayout({ workspaceId: creator.workspaceId, actor: { kind: 'user', id: creator.userId } }))).toBe('below_threshold');
    expect(await refusal(redeemEarningsAsCalls({ workspaceId: creator.workspaceId, actor: { kind: 'user', id: creator.userId } }))).toBe('nothing_redeemable');
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(0);
  });

  it('H4: a payout stops at the balance too', async () => {
    const creator = await person('capp');
    const first = await person('cappa');
    const second = await person('cappb');
    const channel = await sellingChannel(creator, 'money-capp');
    const { adapter } = recordingAdapter();
    const year = (subscriber: Person, tag: string, collectedAt: Date, adjustments: Parameters<typeof sale>[0]['adjustments'] = []) =>
      sale({
        planVersionId: channel.yearly.id,
        subscriber,
        subscriptionId: `sub_money_${stamp}_${tag}`,
        transactionId: `txn_money_${stamp}_${tag}`,
        exTaxMinor: 6_000,
        collectedAt,
        periodEnd: new Date(Date.now() + 300 * DAY),
        adjustments,
      });
    await applyPaymentNotification(year(first, 'capp1', new Date(Date.UTC(2018, 2, 10))), adapter);
    await applyPaymentNotification(year(second, 'capp2', new Date(Date.UTC(2018, 3, 10))), adapter);
    for (const periodId of ['2018-03', '2018-04']) {
      await generateSettlements({ actor: OPERATOR, periodId, reason: 'money fixture close' });
    }
    await db().update(schema.revenuePeriod).set({ lockedAt: new Date(Date.now() - 200 * DAY) }).where(inArray(schema.revenuePeriod.id, ['2018-03', '2018-04']));
    await verifiedProfile(creator);
    await applyPaymentNotification(year(first, 'capp1', new Date(Date.UTC(2018, 2, 10)), [{ id: `adj_money_${stamp}_capp1`, action: 'chargeback', exTaxMinor: 6_000 }]), adapter);

    const requested = await requestPayout({ workspaceId: creator.workspaceId, actor: { kind: 'user', id: creator.userId } });
    expect(requested.amountMinor).toBe(4_800);
    expect(requested.statements).toBe(1);
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(0);
  });

  it('H5: one row per Paddle subscription when the first notice does not name it yet, and a refund then revokes access', async () => {
    const creator = await person('key');
    const reader = await person('keyr');
    const channel = await sellingChannel(creator, 'money-key');
    const { adapter } = recordingAdapter();
    const transactionId = `txn_money_${stamp}_key`;
    const subscriptionId = `sub_money_${stamp}_key`;
    const notice = (subscription: string | null, adjustments: Parameters<typeof sale>[0]['adjustments'] = []) =>
      sale({ planVersionId: channel.monthly.id, subscriber: reader, subscriptionId: subscription, transactionId, exTaxMinor: 600, adjustments });

    await applyPaymentNotification(notice(null), adapter);
    expect((await rowsOf(reader, channel.id)).map((row) => row.providerSubscriptionId)).toEqual([`txn:${transactionId}`]);
    await applyPaymentNotification(notice(subscriptionId), adapter);
    expect((await rowsOf(reader, channel.id)).map((row) => row.providerSubscriptionId)).toEqual([subscriptionId]);
    expect(await subscriptions.subscribesTo(reader.workspaceId, channel.id)).toBe(true);

    await applyPaymentNotification(notice(subscriptionId, [{ id: `adj_money_${stamp}_key`, action: 'refund', exTaxMinor: 600 }]), adapter);
    expect(await subscriptions.subscribesTo(reader.workspaceId, channel.id)).toBe(false);
    expect(await rowsOf(reader, channel.id)).toHaveLength(1);
  });

  it('H5: the same, when the notice naming the subscription is processed first', async () => {
    const creator = await person('key2');
    const reader = await person('key2r');
    const channel = await sellingChannel(creator, 'money-key2');
    const { adapter } = recordingAdapter();
    const transactionId = `txn_money_${stamp}_key2`;
    const subscriptionId = `sub_money_${stamp}_key2`;
    const notice = (subscription: string | null, adjustments: Parameters<typeof sale>[0]['adjustments'] = []) =>
      sale({ planVersionId: channel.monthly.id, subscriber: reader, subscriptionId: subscription, transactionId, exTaxMinor: 600, adjustments });

    await applyPaymentNotification(notice(subscriptionId), adapter);
    await applyPaymentNotification(notice(null), adapter);
    expect((await rowsOf(reader, channel.id)).map((row) => row.providerSubscriptionId)).toEqual([subscriptionId]);

    await applyPaymentNotification(notice(null, [{ id: `adj_money_${stamp}_key2`, action: 'refund', exTaxMinor: 600 }]), adapter);
    expect(await subscriptions.subscribesTo(reader.workspaceId, channel.id)).toBe(false);
    expect(await rowsOf(reader, channel.id)).toHaveLength(1);
  });

  it('M15: a channel-tagged transaction that does not pay for the plan is recorded and grants nothing; a renewal still works', async () => {
    const creator = await person('chk');
    const reader = await person('chkr');
    const channel = await sellingChannel(creator, 'money-chk');
    const { adapter } = recordingAdapter();
    const attempt = (tag: string, overrides: Partial<Parameters<typeof sale>[0]>) =>
      sale({
        planVersionId: channel.monthly.id,
        subscriber: reader,
        subscriptionId: `sub_money_${stamp}_${tag}`,
        transactionId: `txn_money_${stamp}_${tag}`,
        exTaxMinor: 600,
        ...overrides,
      });

    expect(await applyPaymentNotification(attempt('chk1', { onChannelProduct: false }), adapter)).toBe('refused');
    expect(await applyPaymentNotification(attempt('chk2', { currency: 'JPY' }), adapter)).toBe('refused');
    expect(await applyPaymentNotification(attempt('chk3', { exTaxMinor: 1, listPriceMinor: 1 }), adapter)).toBe('refused');
    expect(await applyPaymentNotification(attempt('chk4', { exTaxMinor: 300, discountMinor: 300 }), adapter)).toBe('refused');
    expect(await subscriptions.subscribesTo(reader.workspaceId, channel.id)).toBe(false);
    expect(await rowsOf(reader, channel.id)).toHaveLength(0);
    const events = await db().select().from(schema.earningEvent).where(eq(schema.earningEvent.ownerWorkspaceId, creator.workspaceId));
    expect(events).toHaveLength(0);
    /* Recorded, for an operator to reconcile from. */
    const recorded = await db().select().from(schema.paymentEvent).where(like(schema.paymentEvent.externalEventId, `evt_money_${stamp}_%`));
    expect(recorded.length).toBeGreaterThanOrEqual(4);

    /* The real sale and its renewal, a month on, at the version's price. */
    const start = new Date(Date.now() - 20 * DAY);
    expect(await applyPaymentNotification(attempt('chk5', { subscriptionId: `sub_money_${stamp}_chk`, collectedAt: start }), adapter)).toBe('applied');
    const renewal = await applyPaymentNotification(
      attempt('chk6', { subscriptionId: `sub_money_${stamp}_chk`, collectedAt: new Date(start.getTime() + 30 * DAY), periodEnd: new Date(start.getTime() + 60 * DAY) }),
      adapter,
    );
    expect(renewal).toBe('applied');
    const [row] = await rowsOf(reader, channel.id);
    expect(row?.currentPeriodEnd.getTime()).toBe(start.getTime() + 60 * DAY);
  });

  it('M16: a refund of the running period cancels the Paddle subscription, and checkout waits while one may still renew', async () => {
    const creator = await person('rfd');
    const reader = await person('rfdr');
    const channel = await sellingChannel(creator, 'money-rfd');
    const { adapter, cancels } = recordingAdapter();
    const subscriptionId = `sub_money_${stamp}_rfd`;
    const transactionId = `txn_money_${stamp}_rfd`;
    const notice = (adjustments: Parameters<typeof sale>[0]['adjustments'] = []) =>
      sale({ planVersionId: channel.monthly.id, subscriber: reader, subscriptionId, transactionId, exTaxMinor: 600, adjustments });
    const checkout = () =>
      subscriptions.startChannelCheckout({ userId: reader.userId, workspaceId: reader.workspaceId, channelId: channel.id, interval: 'month' }, adapter);

    await applyPaymentNotification(notice(), adapter);
    expect(await refusal(checkout())).toBe('already_subscribed');

    /* Dunning after the period: no access, but Paddle may still collect -- a second checkout would double-bill. */
    await db()
      .update(schema.channelSubscription)
      .set({ status: 'past_due', currentPeriodEnd: new Date(Date.now() - DAY) })
      .where(eq(schema.channelSubscription.providerSubscriptionId, subscriptionId));
    expect(await subscriptions.subscribesTo(reader.workspaceId, channel.id)).toBe(false);
    expect(await refusal(checkout())).toBe('already_subscribed');
    await db()
      .update(schema.channelSubscription)
      .set({ status: 'active', currentPeriodEnd: new Date(Date.now() + 30 * DAY) })
      .where(eq(schema.channelSubscription.providerSubscriptionId, subscriptionId));

    /* The refund revokes access and stops the subscription at Paddle now, not at the period's end. */
    await applyPaymentNotification(notice([{ id: `adj_money_${stamp}_rfd`, action: 'refund', exTaxMinor: 600 }]), adapter);
    expect(await subscriptions.subscribesTo(reader.workspaceId, channel.id)).toBe(false);
    expect(cancels).toEqual([{ id: subscriptionId, options: { immediately: true } }]);
    /* A redelivery cancels nothing twice. */
    await applyPaymentNotification(notice([{ id: `adj_money_${stamp}_rfd`, action: 'refund', exTaxMinor: 600 }]), adapter);
    expect(cancels).toHaveLength(1);
    /* Nothing renews any more, so the reader may subscribe again. */
    expect(await checkout()).toBe('https://pay.example.test');
  });

  it('M16: a provider outage on the cancel rolls the refund back for a retry', async () => {
    const creator = await person('rfo');
    const reader = await person('rfor');
    const channel = await sellingChannel(creator, 'money-rfo');
    const subscriptionId = `sub_money_${stamp}_rfo`;
    const transactionId = `txn_money_${stamp}_rfo`;
    const notice = (adjustments: Parameters<typeof sale>[0]['adjustments'] = []) =>
      sale({ planVersionId: channel.monthly.id, subscriber: reader, subscriptionId, transactionId, exTaxMinor: 600, adjustments });
    await applyPaymentNotification(notice(), recordingAdapter().adapter);
    const refund = notice([{ id: `adj_money_${stamp}_rfo`, action: 'refund', exTaxMinor: 600 }]);
    await expect(applyPaymentNotification(refund, recordingAdapter({ cancelFails: 503 }).adapter)).rejects.toThrow();
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(480);
    const { adapter, cancels } = recordingAdapter();
    expect(await applyPaymentNotification(refund, adapter)).toBe('applied');
    expect(cancels).toHaveLength(1);
    expect((await creatorBalance(creator.workspaceId)).balanceMinor).toBe(0);
  });

  it('M17: an event dated into a locked period is booked into the open one', async () => {
    const creator = await person('late');
    const reader = await person('later');
    const channel = await sellingChannel(creator, 'money-late');
    await db().insert(schema.revenuePeriod).values({ id: '2018-06', currency: 'USD', totalAmountMinor: 0, lockedAt: new Date(Date.UTC(2018, 6, 1)) });
    const late = sale({
      planVersionId: channel.monthly.id,
      subscriber: reader,
      subscriptionId: `sub_money_${stamp}_late`,
      transactionId: `txn_money_${stamp}_late`,
      exTaxMinor: 600,
      collectedAt: new Date(Date.UTC(2018, 5, 15)),
    });
    expect(await applyPaymentNotification(late, recordingAdapter().adapter)).toBe('applied');
    const [event] = await db().select().from(schema.earningEvent).where(eq(schema.earningEvent.ownerWorkspaceId, creator.workspaceId));
    expect(event?.periodId).toBe(periodIdOf(new Date()));
    /* Still dated when it happened. */
    expect(event?.createdAt.toISOString()).toBe('2018-06-15T00:00:00.000Z');
  });
});

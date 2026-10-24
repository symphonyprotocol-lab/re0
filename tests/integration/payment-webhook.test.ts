/**
 * Applying Payment Provider notifications against a real database.
 *
 * Everything that matters here is a conditional write -- the event key, the
 * subscription's ordering guard, the pack grant's order key -- so it is tested
 * against Postgres rather than a mock of it. The notifications are built in
 * the adapter's output shape, which is what the use case accepts; the Paddle
 * mapping that produces them is covered in tests/contract/paddle.test.ts.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { applyPaymentNotification } = await import('@/lib/application/billing/webhook');
const { hasPaidSubscription, planWindow } = await import('@/lib/application/plans/quota');
const { workspacePlanVersion } = await import('@/lib/application/plans/billing');
const { PLAN_VERSION_NEWEST_FIRST } = await import('@/lib/application/plans/configuration');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
type Notification = import('@/lib/infrastructure/payment/provider').PaymentNotification;
type DocumentNotice = import('@/lib/infrastructure/payment/provider').ProviderDocumentNotice;
type SubscriptionNotice = import('@/lib/infrastructure/payment/provider').ProviderSubscriptionNotice;

const workspaceId = uuidv7();
const tag = workspaceId.slice(0, 8);
/* A provider name of its own, so cleanup cannot touch another file's rows. */
const provider = `test-${tag}`;
const subscriptionId = `sub_${tag}`;

const DAY = 86_400_000;
const T0 = new Date(Date.now() - DAY);

let proVersion = '';
let addonVersion = '';
let addonCalls = 0;
let eventCounter = 0;

function subscriptionEvent(notice: Partial<SubscriptionNotice>, eventId?: string): Notification {
  return {
    provider,
    externalEventId: eventId ?? `evt_${tag}_${++eventCounter}`,
    eventType: 'subscription.updated',
    payload: { test: true },
    subject: 'subscription',
    subscription: {
      externalId: subscriptionId,
      customerId: `ctm_${tag}`,
      status: 'active',
      periodStart: T0,
      periodEnd: new Date(T0.getTime() + 30 * DAY),
      cancelAt: null,
      workspaceId,
      planVersionId: proVersion,
      observedAt: T0,
      ...notice,
    },
  };
}

function documentEvent(notice: Partial<DocumentNotice> & { document: DocumentNotice['document'] }): Notification {
  return {
    provider,
    externalEventId: `evt_${tag}_${++eventCounter}`,
    eventType: 'transaction.completed',
    payload: { test: true },
    subject: 'document',
    document: {
      workspaceId: null,
      planVersionId: null,
      subscriptionExternalId: null,
      customerId: `ctm_${tag}`,
      quantity: 1,
      observedAt: T0,
      ...notice,
    },
  };
}

async function workspaceSubscriptions() {
  return db()
    .select({
      status: schema.subscription.status,
      planVersionId: schema.subscription.planVersionId,
      providerSubscriptionId: schema.subscription.providerSubscriptionId,
      periodEnd: schema.subscription.periodEnd,
    })
    .from(schema.subscription)
    .where(eq(schema.subscription.workspaceId, workspaceId));
}

describeWithDb('applying payment notifications', () => {
  beforeAll(async () => {
    const database = db();
    const newest = async (planId: string) =>
      (
        await database
          .select({ id: schema.planVersion.id, monthlyCalls: schema.planVersion.monthlyCalls })
          .from(schema.planVersion)
          .where(eq(schema.planVersion.planId, planId))
          .orderBy(...PLAN_VERSION_NEWEST_FIRST)
          .limit(1)
      )[0]!;
    const [free, pro, addon] = await Promise.all([newest('free'), newest('pro'), newest('addon')]);
    proVersion = pro.id;
    addonVersion = addon.id;
    addonCalls = addon.monthlyCalls;

    await database.insert(schema.workspace).values({ id: workspaceId, name: 'Webhook Fixture' });
    /*
     * The Free row signup writes, ending later than the paid one will -- the
     * case "furthest end wins" used to get wrong.
     */
    await database.insert(schema.subscription).values({
      id: uuidv7(),
      workspaceId,
      planVersionId: free.id,
      status: 'active',
      periodStart: T0,
      periodEnd: new Date(T0.getTime() + 90 * DAY),
    });
  });

  afterAll(async () => {
    const database = db();
    await database.delete(schema.billingDocument).where(eq(schema.billingDocument.provider, provider));
    await database.delete(schema.addonGrant).where(eq(schema.addonGrant.workspaceId, workspaceId));
    await database.delete(schema.subscription).where(eq(schema.subscription.workspaceId, workspaceId));
    await database.delete(schema.paymentEvent).where(eq(schema.paymentEvent.provider, provider));
    await database.delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
  });

  it('puts a new paid subscription in force over a Free row that ends later', async () => {
    expect(await hasPaidSubscription(workspaceId)).toBe(false);

    const first = subscriptionEvent({}, `evt_${tag}_created`);
    expect(await applyPaymentNotification(first)).toBe('applied');

    const rows = await workspaceSubscriptions();
    const paid = rows.find((row) => row.providerSubscriptionId === subscriptionId);
    expect(paid).toMatchObject({ status: 'active', planVersionId: proVersion });
    /* Untouched: which row is in force is decided by reading, not by writing. */
    expect(rows.find((row) => row.providerSubscriptionId === null)?.status).toBe('active');
    expect(await hasPaidSubscription(workspaceId)).toBe(true);
    expect((await workspacePlanVersion(workspaceId)).planId).toBe('pro');
  });

  it('does nothing with a redelivered event', async () => {
    const again = subscriptionEvent({ status: 'canceled' }, `evt_${tag}_created`);
    expect(await applyPaymentNotification(again)).toBe('redelivered');
    expect(await hasPaidSubscription(workspaceId)).toBe(true);
  });

  it('refuses an event older than the state the row holds', async () => {
    const late = subscriptionEvent({ status: 'past_due', observedAt: new Date(T0.getTime() - DAY) });
    expect(await applyPaymentNotification(late)).toBe('stale');
    const [paid] = (await workspaceSubscriptions()).filter((row) => row.providerSubscriptionId);
    expect(paid?.status).toBe('active');
  });

  it('moves the period on renewal but never the Plan Version', async () => {
    const renewedEnd = new Date(T0.getTime() + 60 * DAY);
    const renewal = subscriptionEvent({
      periodStart: new Date(T0.getTime() + 30 * DAY),
      periodEnd: renewedEnd,
      /* A tag naming another version must not migrate the subscriber. */
      planVersionId: addonVersion,
      observedAt: new Date(T0.getTime() + 1000),
    });
    expect(await applyPaymentNotification(renewal)).toBe('applied');
    const [paid] = (await workspaceSubscriptions()).filter((row) => row.providerSubscriptionId);
    expect(paid?.periodEnd).toEqual(renewedEnd);
    expect(paid?.planVersionId).toBe(proVersion);
  });

  it('records a scheduled cancellation, keeps Pro until it lands, and clears it when withdrawn', async () => {
    /* A period that contains now, so the row is in force while the cancellation waits. */
    const cancelAt = new Date(T0.getTime() + 30 * DAY);
    const cancelling = subscriptionEvent({
      periodStart: T0,
      periodEnd: cancelAt,
      cancelAt,
      observedAt: new Date(T0.getTime() + 1500),
    });
    expect(await applyPaymentNotification(cancelling)).toBe('applied');
    expect(await hasPaidSubscription(workspaceId)).toBe(true);
    expect((await workspacePlanVersion(workspaceId)).renewal).toEqual({ kind: 'cancels', at: cancelAt });

    const withdrawn = subscriptionEvent({
      periodStart: T0,
      periodEnd: cancelAt,
      observedAt: new Date(T0.getTime() + 1600),
    });
    expect(await applyPaymentNotification(withdrawn)).toBe('applied');
    expect((await workspacePlanVersion(workspaceId)).renewal).toEqual({ kind: 'renews', at: cancelAt });
  });

  it('keeps Pro in force between the period end and the renewal webhook', async () => {
    /* A period that ended a minute ago, with the renewal not yet reported. */
    const ended = new Date(Date.now() - 60_000);
    const lapsing = subscriptionEvent({
      periodStart: new Date(ended.getTime() - 30 * DAY),
      periodEnd: ended,
      observedAt: new Date(T0.getTime() + 2000),
    });
    expect(await applyPaymentNotification(lapsing)).toBe('applied');

    expect(await hasPaidSubscription(workspaceId)).toBe(true);
    const window = await db().transaction((tx) => planWindow(tx, workspaceId));
    expect(window.planVersionId).toBe(proVersion);
    /* Counting starts afresh at the old end, not over last month's usage. */
    expect(window.periodStart).toEqual(ended);
  });

  it('places an untagged renewal document through the subscription it bills', async () => {
    const outcome = await applyPaymentNotification(
      documentEvent({
        subscriptionExternalId: subscriptionId,
        document: {
          provider,
          externalId: `txn_${tag}_renewal`,
          kind: 'subscription',
          status: 'paid',
          amountMinor: 500,
          refundedMinor: 0,
          currency: 'USD',
          method: 'card',
        },
      }),
    );
    expect(outcome).toBe('applied');

    const [document] = await db()
      .select({
        workspaceId: schema.billingDocument.workspaceId,
        planVersionId: schema.billingDocument.planVersionId,
        subscriptionId: schema.billingDocument.subscriptionId,
      })
      .from(schema.billingDocument)
      .where(eq(schema.billingDocument.externalId, `txn_${tag}_renewal`));
    expect(document?.workspaceId).toBe(workspaceId);
    expect(document?.planVersionId).toBe(proVersion);
    expect(document?.subscriptionId).not.toBeNull();
  });

  it('grants a paid pack once, however many collected events report it', async () => {
    const pack = (status: 'paid' | 'refunded', observedAt: Date) =>
      documentEvent({
        workspaceId,
        planVersionId: addonVersion,
        observedAt,
        document: {
          provider,
          externalId: `txn_${tag}_pack`,
          kind: 'pack',
          status,
          amountMinor: 500,
          refundedMinor: status === 'refunded' ? 500 : 0,
          currency: 'USD',
        },
      });

    expect(await applyPaymentNotification(pack('paid', T0))).toBe('applied');
    expect(await applyPaymentNotification(pack('paid', new Date(T0.getTime() + 1000)))).toBe('applied');
    /* A refund later on does not take the delivered calls back. */
    expect(await applyPaymentNotification(pack('refunded', new Date(T0.getTime() + 2000)))).toBe('applied');

    const grants = await db()
      .select({ id: schema.addonGrant.id, calls: schema.addonGrant.callsGranted })
      .from(schema.addonGrant)
      .where(eq(schema.addonGrant.workspaceId, workspaceId));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.calls).toBe(addonCalls);

    const [document] = await db()
      .select({ status: schema.billingDocument.status, addonGrantId: schema.billingDocument.addonGrantId })
      .from(schema.billingDocument)
      .where(eq(schema.billingDocument.externalId, `txn_${tag}_pack`));
    expect(document).toEqual({ status: 'refunded', addonGrantId: grants[0]?.id });
  });

  it('records what it cannot place, so a retry is not attempted forever', async () => {
    const stranger = documentEvent({
      workspaceId: uuidv7(),
      document: {
        provider,
        externalId: `txn_${tag}_stranger`,
        kind: 'pack',
        status: 'paid',
        amountMinor: 500,
        currency: 'USD',
      },
    });
    expect(await applyPaymentNotification(stranger)).toBe('unresolved');

    const garbled = documentEvent({
      workspaceId,
      document: {
        provider,
        externalId: `txn_${tag}_garbled`,
        kind: 'subscription',
        status: 'paid',
        amountMinor: 500,
        currency: 'DOLLARS',
      },
    });
    expect(await applyPaymentNotification(garbled)).toBe('refused');

    const recorded = await db()
      .select({ id: schema.paymentEvent.id })
      .from(schema.paymentEvent)
      .where(
        and(
          eq(schema.paymentEvent.provider, provider),
          eq(schema.paymentEvent.externalEventId, garbled.externalEventId),
        ),
      );
    expect(recorded).toHaveLength(1);
    expect(await applyPaymentNotification(garbled)).toBe('redelivered');
  });

  it('takes the plan away when the subscription is cancelled', async () => {
    const cancelled = subscriptionEvent({
      status: 'canceled',
      periodStart: null,
      periodEnd: null,
      observedAt: new Date(T0.getTime() + 5000),
    });
    expect(await applyPaymentNotification(cancelled)).toBe('applied');
    expect(await hasPaidSubscription(workspaceId)).toBe(false);
  });
});

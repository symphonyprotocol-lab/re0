/**
 * Applying Payment Provider notifications against a real database.
 *
 * Everything that matters here is a conditional write -- the event key, the
 * pack grant's order key, the storage tier that only ever goes up -- so it is
 * tested against Postgres rather than a mock of it. The notifications are
 * built in the adapter's output shape, which is what the use case accepts; the
 * Paddle mapping that produces them is covered in tests/contract/paddle.test.ts.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { applyPaymentNotification, workspaceProviderCustomer } = await import('@/lib/application/billing/webhook');
const { workspaceStorage } = await import('@/lib/application/plans/storage');
const { PLAN_VERSION_NEWEST_FIRST } = await import('@/lib/application/plans/configuration');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
type Notification = import('@/lib/infrastructure/payment/provider').PaymentNotification;
type DocumentNotice = import('@/lib/infrastructure/payment/provider').ProviderDocumentNotice;

const workspaceId = uuidv7();
const ownerId = uuidv7();
const tag = workspaceId.slice(0, 8);
/* A provider name of its own, so cleanup cannot touch another file's rows. */
const provider = `test-${tag}`;

const DAY = 86_400_000;
const T0 = new Date(Date.now() - DAY);

let addonVersion = '';
let addonCalls = 0;
let eventCounter = 0;

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

async function ownerTier(): Promise<string> {
  const [row] = await db()
    .select({ tier: schema.user.storageTier })
    .from(schema.user)
    .where(eq(schema.user.id, ownerId));
  return row!.tier;
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
    const [free, addon] = await Promise.all([newest('free'), newest('addon')]);
    addonVersion = addon.id;
    addonCalls = addon.monthlyCalls;

    await database.insert(schema.user).values({
      id: ownerId,
      email: `webhook-${tag}@example.test`,
      displayName: 'Webhook Owner',
      status: 'active',
    });
    await database.insert(schema.workspace).values({ id: workspaceId, name: 'Webhook Fixture' });
    await database.insert(schema.workspaceMember).values({ workspaceId, userId: ownerId, role: 'owner' });
    /* The Free row signup writes: the one row every workspace has. */
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
    await database.delete(schema.workspaceMember).where(eq(schema.workspaceMember.workspaceId, workspaceId));
    await database.delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
    await database.delete(schema.user).where(eq(schema.user.id, ownerId));
  });

  it('starts every workspace on the base storage tier', async () => {
    expect(await ownerTier()).toBe('base');
    const storage = await workspaceStorage(workspaceId);
    expect(storage.tier).toBe('base');
    expect(storage.capacityBytes).toBe(500 * 1_048_576);
    expect(await workspaceProviderCustomer(workspaceId)).toBeNull();
  });

  it('grants a paid pack once, however many collected events report it, and raises the storage tier for good', async () => {
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
    /* agent-first-proposal.md 8.1: the first pack moves the buyer to 2 GB. */
    expect(await ownerTier()).toBe('extended');
    expect((await workspaceStorage(workspaceId)).capacityBytes).toBe(2_048 * 1_048_576);
    /* The portal has a customer to open as soon as there is a receipt. */
    expect(await workspaceProviderCustomer(workspaceId)).toBe(`ctm_${tag}`);

    expect(await applyPaymentNotification(pack('paid', new Date(T0.getTime() + 1000)))).toBe('applied');
    /* A refund later on does not take the delivered calls back, nor the tier. */
    expect(await applyPaymentNotification(pack('refunded', new Date(T0.getTime() + 2000)))).toBe('applied');
    expect(await ownerTier()).toBe('extended');

    const grants = await db()
      .select({ id: schema.addonGrant.id, calls: schema.addonGrant.callsGranted })
      .from(schema.addonGrant)
      .where(eq(schema.addonGrant.workspaceId, workspaceId));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.calls).toBe(addonCalls);

    const [document] = await db()
      .select({
        status: schema.billingDocument.status,
        addonGrantId: schema.billingDocument.addonGrantId,
        planVersionId: schema.billingDocument.planVersionId,
      })
      .from(schema.billingDocument)
      .where(eq(schema.billingDocument.externalId, `txn_${tag}_pack`));
    expect(document).toEqual({ status: 'refunded', addonGrantId: grants[0]?.id, planVersionId: addonVersion });
  });

  it('does nothing with a redelivered event', async () => {
    const first = documentEvent({
      workspaceId,
      planVersionId: addonVersion,
      document: {
        provider,
        externalId: `txn_${tag}_pack_two`,
        kind: 'pack',
        status: 'paid',
        amountMinor: 500,
        currency: 'USD',
      },
    });
    expect(await applyPaymentNotification(first)).toBe('applied');
    expect(await applyPaymentNotification(first)).toBe('redelivered');
    const grants = await db()
      .select({ id: schema.addonGrant.id })
      .from(schema.addonGrant)
      .where(eq(schema.addonGrant.providerOrderId, `txn_${tag}_pack_two`));
    expect(grants).toHaveLength(1);
  });

  it('refuses an event older than the state the document holds', async () => {
    const late = documentEvent({
      workspaceId,
      planVersionId: addonVersion,
      observedAt: new Date(T0.getTime() - DAY),
      document: {
        provider,
        externalId: `txn_${tag}_pack`,
        kind: 'pack',
        status: 'paid',
        amountMinor: 500,
        refundedMinor: 0,
        currency: 'USD',
      },
    });
    expect(await applyPaymentNotification(late)).toBe('stale');
    const [document] = await db()
      .select({ status: schema.billingDocument.status })
      .from(schema.billingDocument)
      .where(eq(schema.billingDocument.externalId, `txn_${tag}_pack`));
    expect(document?.status).toBe('refunded');
  });

  it('mirrors a charge from a subscription sold before Pro was removed, bound to nothing', async () => {
    const outcome = await applyPaymentNotification(
      documentEvent({
        workspaceId,
        subscriptionExternalId: `sub_${tag}_legacy`,
        document: {
          provider,
          externalId: `txn_${tag}_legacy`,
          kind: 'subscription',
          status: 'paid',
          amountMinor: 500,
          refundedMinor: 0,
          currency: 'USD',
          method: 'card',
          periodStart: T0,
          periodEnd: new Date(T0.getTime() + 30 * DAY),
        },
      }),
    );
    expect(outcome).toBe('applied');

    const [document] = await db()
      .select({
        workspaceId: schema.billingDocument.workspaceId,
        planVersionId: schema.billingDocument.planVersionId,
        subscriptionId: schema.billingDocument.subscriptionId,
        addonGrantId: schema.billingDocument.addonGrantId,
      })
      .from(schema.billingDocument)
      .where(eq(schema.billingDocument.externalId, `txn_${tag}_legacy`));
    expect(document).toEqual({ workspaceId, planVersionId: null, subscriptionId: null, addonGrantId: null });
  });

  it('ignores a subscription event outright, recording nothing', async () => {
    const notification: Notification = {
      provider,
      externalEventId: `evt_${tag}_subscription`,
      eventType: 'subscription.updated',
      payload: { test: true },
      subject: 'ignored',
    };
    expect(await applyPaymentNotification(notification)).toBe('ignored');
    const recorded = await db()
      .select({ id: schema.paymentEvent.id })
      .from(schema.paymentEvent)
      .where(
        and(eq(schema.paymentEvent.provider, provider), eq(schema.paymentEvent.externalEventId, `evt_${tag}_subscription`)),
      );
    expect(recorded).toHaveLength(0);
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
        kind: 'pack',
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
});

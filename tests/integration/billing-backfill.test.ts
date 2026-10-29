/**
 * Backfilling a lost webhook from the provider's API, against a real database.
 *
 * The snapshot is built in the adapter's output shape; reading it from Paddle
 * is covered in tests/contract/paddle.test.ts. What is tested here is that a
 * backfill lands exactly as the webhook would have, and that running it twice
 * grants nothing twice.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { applyProviderSnapshot, BackfillRefused } = await import('@/lib/application/billing/backfill');
const { PLAN_VERSION_NEWEST_FIRST } = await import('@/lib/application/plans/configuration');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');
type Snapshot = import('@/lib/infrastructure/payment/provider').ProviderDocumentSnapshot;
type DocumentNotice = import('@/lib/infrastructure/payment/provider').ProviderDocumentNotice;

const workspaceId = uuidv7();
const tag = workspaceId.slice(0, 8);
/* A provider name of its own, so cleanup cannot touch another file's rows. */
const provider = `test-${tag}`;
const meta = { administratorId: uuidv7() };

const DAY = 86_400_000;
const T0 = new Date(Date.now() - DAY);

let addonVersion = '';
let addonCalls = 0;

function documentNotice(
  externalId: string,
  overrides: Partial<DocumentNotice['document']> = {},
  notice: Partial<Omit<DocumentNotice, 'document'>> = {},
): DocumentNotice {
  return {
    document: {
      provider,
      externalId,
      number: null,
      kind: 'pack',
      status: 'paid',
      amountMinor: 500,
      refundedMinor: 0,
      currency: 'USD',
      method: 'card',
      issuedAt: T0,
      paidAt: T0,
      periodStart: null,
      periodEnd: null,
      ...overrides,
    },
    workspaceId,
    planVersionId: addonVersion,
    subscriptionExternalId: null,
    customerId: `ctm_${tag}`,
    quantity: 1,
    observedAt: T0,
    ...notice,
  };
}

function snapshot(document: DocumentNotice | null): Snapshot {
  return { document, payload: { test: true } };
}

describeWithDb('backfilling a billing document from the provider', () => {
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
    const addon = await newest('addon');
    addonVersion = addon.id;
    addonCalls = addon.monthlyCalls;
    await database.insert(schema.workspace).values({ id: workspaceId, name: 'Backfill Fixture' });
  });

  afterAll(async () => {
    const database = db();
    await database.delete(schema.billingDocument).where(eq(schema.billingDocument.provider, provider));
    await database.delete(schema.addonGrant).where(eq(schema.addonGrant.workspaceId, workspaceId));
    await database.delete(schema.subscription).where(eq(schema.subscription.workspaceId, workspaceId));
    await database.delete(schema.paymentEvent).where(eq(schema.paymentEvent.provider, provider));
    await database.delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
  });

  it('mirrors a paid pack the webhook never delivered and grants its calls', async () => {
    const result = await applyProviderSnapshot(provider, snapshot(documentNotice(`txn_${tag}_pack`)), meta);
    expect(result).toMatchObject({
      created: true,
      previousStatus: null,
      status: 'paid',
      grantedCalls: addonCalls,
    });

    const [document] = await db()
      .select({ addonGrantId: schema.billingDocument.addonGrantId, lastEventId: schema.billingDocument.lastEventId })
      .from(schema.billingDocument)
      .where(eq(schema.billingDocument.id, result.documentId));
    expect(document?.addonGrantId).not.toBeNull();
    /* The run is on record, with who ran it. */
    const [event] = await db()
      .select({ payload: schema.paymentEvent.payload })
      .from(schema.paymentEvent)
      .where(eq(schema.paymentEvent.id, document!.lastEventId!));
    expect(event?.payload).toMatchObject({ source: 'console_backfill', administratorId: meta.administratorId });
  });

  it('grants nothing twice when the same document is backfilled again', async () => {
    const result = await applyProviderSnapshot(provider, snapshot(documentNotice(`txn_${tag}_pack`)), meta);
    expect(result).toMatchObject({ created: false, previousStatus: 'paid', status: 'paid', grantedCalls: null });
    const grants = await db()
      .select({ id: schema.addonGrant.id })
      .from(schema.addonGrant)
      .where(eq(schema.addonGrant.providerOrderId, `txn_${tag}_pack`));
    expect(grants).toHaveLength(1);
  });

  it('refuses a transaction that is not a billing document', async () => {
    await expect(applyProviderSnapshot(provider, snapshot(null), meta)).rejects.toMatchObject({
      code: 'not_billable',
    });
  });

  it('refuses, and can be retried, when there is no workspace to place it on', async () => {
    const orphan = documentNotice(`txn_${tag}_orphan`, {}, { workspaceId: null });
    await expect(applyProviderSnapshot(provider, snapshot(orphan), meta)).rejects.toBeInstanceOf(
      BackfillRefused,
    );
    /* A fresh event per run: the retry is applied, not answered `redelivered`. */
    const result = await applyProviderSnapshot(
      provider,
      snapshot({ ...orphan, workspaceId }),
      meta,
    );
    expect(result).toMatchObject({ created: true, grantedCalls: addonCalls });
  });
});

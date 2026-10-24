/**
 * Minting Plan Versions against a real database.
 *
 * The property under test is immutability (requirement.md 4.3, architecture.md
 * 6.1): a change mints a successor, the superseded row is left exactly as it
 * was, and the subscriptions billing against it stay there. That cannot be
 * checked in a unit test -- the whole point is what happens to rows nobody
 * touched.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { createPlanVersion, currentPlanVersion, listPlanConfiguration } = await import(
  '@/lib/application/plans/configuration'
);
const { PlanChangeRefused } = await import('@/lib/domain/plans');
const { AdminChangeRefused } = await import('@/lib/domain/admin');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

/*
 * A real `administrator` row, not just an id: `audit_log.administrator_id` is a
 * foreign key, and `recordAudit` swallows a refused insert, so an actor who
 * does not exist means the change is made and simply never recorded.
 */
const stamp = Date.now();
const actor = {
  administratorId: crypto.randomUUID(),
  email: `plans-${stamp}@example.test`,
};

/** The refusal code, so a case can assert which guard fired rather than that one did. */
async function expectRefusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof PlanChangeRefused ? error.code : `unexpected:${String(error)}`;
  }
}
const mintedVersionIds: string[] = [];
const workspaceId = uuidv7();
let subscriptionId = '';

describeWithDb('plan configuration', () => {
  beforeAll(async () => {
    await db().insert(schema.administrator).values({
      id: actor.administratorId,
      username: `Plan Operator ${stamp}`,
      email: actor.email,
      status: 'active',
    });
  });

  afterAll(async () => {
    const database = db();
    if (subscriptionId) {
      await database.delete(schema.subscription).where(eq(schema.subscription.id, subscriptionId));
    }
    await database.delete(schema.workspace).where(eq(schema.workspace.id, workspaceId));
    if (mintedVersionIds.length > 0) {
      await database
        .delete(schema.planVersion)
        .where(inArray(schema.planVersion.id, mintedVersionIds));
    }
    // Audit rows first: they are what points at the administrator.
    await database
      .delete(schema.auditLog)
      .where(eq(schema.auditLog.administratorId, actor.administratorId));
    await database
      .delete(schema.administrator)
      .where(eq(schema.administrator.id, actor.administratorId));
  });

  it('reads the seeded catalogue: three tiers, each with a live version', async () => {
    const { tiers } = await listPlanConfiguration();
    expect(tiers.map((tier) => tier.id)).toEqual(['free', 'pro', 'addon']);
    for (const tier of tiers) {
      expect(tier.live).not.toBeNull();
      expect(tier.live?.currency).toBe('USD');
      expect(tier.live?.isLive).toBe(true);
    }
  });

  it('leaves an existing subscription on the version it was sold', async () => {
    const database = db();
    const before = await currentPlanVersion('pro');
    expect(before).not.toBeNull();

    await database.insert(schema.workspace).values({ id: workspaceId, name: 'Plan Fixture' });
    subscriptionId = uuidv7();
    const now = new Date();
    await database.insert(schema.subscription).values({
      id: subscriptionId,
      workspaceId,
      planVersionId: before!.id,
      status: 'active',
      periodStart: now,
      periodEnd: new Date(now.getTime() + 30 * 86_400_000),
    });

    const result = await createPlanVersion({
      actor,
      planId: 'pro',
      expectedLiveVersionId: before!.id,
      currency: 'USD',
      price: '6.00',
      calls: '6000',
      libraryLimit: '30',
      librarySizeMb: '120',
      apiKeyLimit: '25',
      shareRate: '20',
      reason: 'raise the Pro allowance',
    });
    mintedVersionIds.push(result.planVersionId);

    expect(result.supersededId).toBe(before!.id);
    expect(result.supersededSubscriptions).toBe(1);

    // The superseded row is untouched, values and all.
    const [old] = await database
      .select()
      .from(schema.planVersion)
      .where(eq(schema.planVersion.id, before!.id));
    expect(old?.priceMinor).toBe(before!.priceMinor);
    expect(old?.monthlyCalls).toBe(before!.monthlyCalls);

    // And so is the subscription that was pointing at it.
    const [subscription] = await database
      .select()
      .from(schema.subscription)
      .where(eq(schema.subscription.id, subscriptionId));
    expect(subscription?.planVersionId).toBe(before!.id);

    // The new one is what a new subscription would be sold.
    const live = await currentPlanVersion('pro');
    expect(live?.id).toBe(result.planVersionId);
    expect(live?.priceMinor).toBe(600);
    expect(live?.librarySizeBytesLimit).toBe(120 * 1_048_576);
  });

  it('shows the superseded row still billing on the history', async () => {
    const { history } = await listPlanConfiguration();
    const superseded = history.find((row) => row.id !== mintedVersionIds[0] && row.planId === 'pro');
    expect(superseded?.isLive).toBe(false);
    expect(superseded?.subscriptions).toBe(1);

    const live = history.find((row) => row.id === mintedVersionIds[0]);
    expect(live?.isLive).toBe(true);
    expect(live?.subscriptions).toBe(0);
  });

  it('records the change with both sides of it', async () => {
    const [entry] = await db()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, mintedVersionIds[0]!));
    expect(entry?.action).toBe('plan.create_version');
    expect(entry?.reason).toBe('raise the Pro allowance');
    expect((entry?.beforeValue as { priceMinor?: number })?.priceMinor).toBe(500);
    expect((entry?.afterValue as { priceMinor?: number })?.priceMinor).toBe(600);
  });

  it('refuses a submit whose form was built against a version that has moved', async () => {
    /*
     * The lost update this guard exists for: a dialog opened against the
     * seeded Pro version, still open while the case above minted a successor,
     * would otherwise supersede a price rise it never displayed.
     */
    const stale = await expectRefusal(
      createPlanVersion({
        actor,
        planId: 'pro',
        expectedLiveVersionId: '01920000-0000-7000-8000-000000000002',
        currency: 'USD',
        price: '5.00',
        calls: '5000',
        libraryLimit: '25',
        librarySizeMb: '100',
        apiKeyLimit: '20',
        shareRate: '20',
        reason: 'submitted from a stale dialog',
      }),
    );
    expect(stale).toBe('superseded');

    const live = await currentPlanVersion('pro');
    expect(live?.id).toBe(mintedVersionIds[0]);
    expect(live?.priceMinor).toBe(600);
  });

  it('refuses to mint a version identical to the live one', async () => {
    await expect(
      createPlanVersion({
        actor,
        planId: 'pro',
        expectedLiveVersionId: mintedVersionIds[0]!,
        currency: 'USD',
        price: '6.00',
        calls: '6000',
        libraryLimit: '30',
        librarySizeMb: '120',
        apiKeyLimit: '25',
        shareRate: '20',
        reason: 'no change at all',
      }),
    ).rejects.toThrow(PlanChangeRefused);
  });

  it('refuses to mint one without a reason for the audit log', async () => {
    await expect(
      createPlanVersion({
        actor,
        planId: 'pro',
        expectedLiveVersionId: mintedVersionIds[0]!,
        currency: 'USD',
        price: '7.00',
        calls: '7000',
        libraryLimit: '30',
        librarySizeMb: '120',
        apiKeyLimit: '25',
        shareRate: '20',
        reason: '   ',
      }),
    ).rejects.toThrow(AdminChangeRefused);
  });

  it('writes nothing when it refuses', async () => {
    const { history } = await listPlanConfiguration();
    expect(history.filter((row) => row.planId === 'pro' && row.priceMinor === 700)).toHaveLength(0);
  });
});

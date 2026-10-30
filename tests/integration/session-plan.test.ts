/**
 * Which plan a session says the workspace is on, against a real database.
 *
 * Plan identity has one definition (lib/application/plans/billing.ts
 * `workspacePlanVersion`): an active subscription decides the plan only while
 * its own period contains now. `status = 'active'` alone is not that rule -- a
 * lapsed row whose status nobody has moved yet used to keep printing its
 * allowance in the sidebar while billing and the quota transaction had already
 * fallen back to the newest Free version. This asserts the session and the
 * biller agree in all three cases, using a Free version of the test's own with
 * an allowance the seeded one does not have.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { resolveSession } = await import('@/lib/application/auth/resolve-session');
const { sessionTokenHash } = await import('@/lib/application/auth/session-token');
const { workspacePlanVersion } = await import('@/lib/application/plans');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const users: string[] = [];
const workspaces: string[] = [];
const planVersions: string[] = [];

const DAY_MS = 86_400_000;

/**
 * A signed-in owner of a fresh workspace, optionally with a subscription on a
 * Free version of its own whose period is given by the caller.
 */
async function signedIn(subscription?: {
  status: 'active';
  periodStart: Date;
  periodEnd: Date;
}): Promise<{ token: string; workspaceId: string }> {
  const database = db();
  const userId = uuidv7();
  users.push(userId);
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);

  await database.insert(schema.user).values({
    id: userId,
    email: `session-plan-${userId}@example.test`,
    displayName: 'Session Plan Tester',
    status: 'active',
  });
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'plan-test' });
  await database.insert(schema.workspaceMember).values({
    workspaceId,
    userId,
    role: 'owner',
  });

  if (subscription) {
    const planVersionId = uuidv7();
    planVersions.push(planVersionId);
    await database.insert(schema.planVersion).values({
      id: planVersionId,
      planId: 'free',
      priceMinor: 0,
      currency: 'USD',
      monthlyCalls: 5_000,
      apiKeyLimit: 5,
      capabilities: {},
      createdAt: new Date('2000-01-01T00:00:00Z'),
    });
    await database.insert(schema.subscription).values({
      id: uuidv7(),
      workspaceId,
      planVersionId,
      ...subscription,
    });
  }

  const token = `session-plan-${crypto.randomUUID()}`;
  await database.insert(schema.userSession).values({
    id: uuidv7(),
    userId,
    tokenHash: await sessionTokenHash(token),
    expiresAt: new Date(Date.now() + 7 * DAY_MS),
  });
  return { token, workspaceId };
}

describeWithDb('the plan a session reports', () => {
  afterAll(async () => {
    const database = db();
    if (users.length > 0) {
      await database.delete(schema.userSession).where(inArray(schema.userSession.userId, users));
      await database
        .delete(schema.workspaceMember)
        .where(inArray(schema.workspaceMember.userId, users));
    }
    if (workspaces.length > 0) {
      await database
        .delete(schema.subscription)
        .where(inArray(schema.subscription.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
    if (users.length > 0) {
      await database.delete(schema.user).where(inArray(schema.user.id, users));
    }
  });

  it('reports the subscribed version while its period contains now', async () => {
    const { token, workspaceId } = await signedIn({
      status: 'active',
      periodStart: new Date(Date.now() - DAY_MS),
      periodEnd: new Date(Date.now() + DAY_MS),
    });

    const session = await resolveSession(token);
    const billed = await workspacePlanVersion(workspaceId);

    expect(session?.workspace.planId).toBe('free');
    expect(session?.workspace.monthlyCalls).toBe(5_000);
    expect(session?.workspace.planId).toBe(billed.planId);
    expect(session?.workspace.planName).toBe(billed.planName);
    expect(session?.workspace.monthlyCalls).toBe(billed.monthlyCalls);
    expect(billed.subscribed).toBe(true);
  });

  /* The regression: active, but the period ended yesterday. */
  it('falls back to Free when an active subscription’s period has ended', async () => {
    const { token, workspaceId } = await signedIn({
      status: 'active',
      periodStart: new Date(Date.now() - 40 * DAY_MS),
      periodEnd: new Date(Date.now() - DAY_MS),
    });

    const session = await resolveSession(token);
    const billed = await workspacePlanVersion(workspaceId);

    expect(billed.planId).toBe('free');
    expect(billed.subscribed).toBe(false);
    expect(session?.workspace.planId).toBe('free');
    expect(session?.workspace.planName).toBe(billed.planName);
    expect(session?.workspace.monthlyCalls).toBe(billed.monthlyCalls);
    /* Not the lapsed version's allowance, which is what the sidebar showed. */
    expect(session?.workspace.monthlyCalls).not.toBe(5_000);
  });

  it('reports Free when there is no subscription at all', async () => {
    const { token, workspaceId } = await signedIn();

    const session = await resolveSession(token);
    const billed = await workspacePlanVersion(workspaceId);

    expect(session?.workspace.planId).toBe('free');
    expect(session?.workspace.planName).toBe(billed.planName);
    expect(session?.workspace.monthlyCalls).toBe(billed.monthlyCalls);
  });

  /* A period that has not started yet is not this workspace's plan either. */
  it('ignores a subscription whose period has not begun', async () => {
    const { token, workspaceId } = await signedIn({
      status: 'active',
      periodStart: new Date(Date.now() + DAY_MS),
      periodEnd: new Date(Date.now() + 31 * DAY_MS),
    });

    const session = await resolveSession(token);
    const billed = await workspacePlanVersion(workspaceId);

    expect(billed.planId).toBe('free');
    expect(session?.workspace.planId).toBe('free');
    expect(session?.workspace.monthlyCalls).toBe(billed.monthlyCalls);
  });
});

/**
 * Seats that change hands between reserving and committing.
 *
 * - Paying for a pack-debited call when the reserved grant ran dry first.
 *   `reserveCall` names the oldest grant with balance, but two calls reserved
 *   back to back on that grant's last call both name it. The second commit
 *   used to find it spent and decrement nothing -- a call served and paid
 *   from no pack. `commitCall` now settles the grant under the workspace lock.
 * - Reserving a request again after its seat was released, as the
 *   playground's retry does: the seat has to be held again.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { reserveCall, commitCall, releaseCall, PLAN_VERSION_NEWEST_FIRST } = await import(
  '@/lib/application/plans'
);
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];

/** A Free workspace with `left` calls of its monthly allowance unspent (none by default). */
async function freeWorkspace(left = 0): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'addon-commit' });
  const [free] = await database
    .select({ monthlyCalls: schema.planVersion.monthlyCalls })
    .from(schema.planVersion)
    .where(eq(schema.planVersion.planId, 'free'))
    .orderBy(...PLAN_VERSION_NEWEST_FIRST)
    .limit(1);
  await database.insert(schema.usageEvent).values({
    id: uuidv7(),
    workspaceId,
    requestId: `addon-commit-${uuidv7()}`,
    operation: 'query_docs',
    entrypoint: 'rest',
    debitSource: 'plan',
    statusCode: 200,
    calls: free!.monthlyCalls - left,
  });
  return workspaceId;
}

async function grant(workspaceId: string, callsGranted: number, createdAt: Date): Promise<string> {
  const id = uuidv7();
  await db()
    .insert(schema.addonGrant)
    .values({ id, workspaceId, callsGranted, priceMinor: 500, createdAt });
  return id;
}

async function consumed(id: string): Promise<number> {
  const [row] = await db()
    .select({ consumed: schema.addonGrant.callsConsumed })
    .from(schema.addonGrant)
    .where(eq(schema.addonGrant.id, id));
  return row!.consumed;
}

function commit(reservation: Awaited<ReturnType<typeof reserveCall>>) {
  return commitCall({
    reservation,
    /* No asset: the event's asset columns are nullable, and nothing here earns. */
    assetId: null as unknown as string,
    versionId: null as unknown as string,
    operation: 'context',
    entrypoint: 'rest',
    statusCode: 200,
    latencyMs: 1,
    inputTokens: null,
    returnedTokens: 10,
  });
}

describeWithDb('addon debit at commit', () => {
  afterAll(async () => {
    if (workspaces.length === 0) return;
    const database = db();
    await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.workspaceId, workspaces));
    await database
      .delete(schema.usageReservation)
      .where(inArray(schema.usageReservation.workspaceId, workspaces));
    await database.delete(schema.addonGrant).where(inArray(schema.addonGrant.workspaceId, workspaces));
    await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
  });

  it('pays the second of two calls reserved on one grant from the next grant', async () => {
    const workspaceId = await freeWorkspace();
    const older = await grant(workspaceId, 1, new Date(Date.now() - 60_000));
    const newer = await grant(workspaceId, 5, new Date());

    const first = await reserveCall({ workspaceId, requestId: `addon-commit-${uuidv7()}` });
    const second = await reserveCall({ workspaceId, requestId: `addon-commit-${uuidv7()}` });
    /* The race the fix is for: both seats name the grant with one call left. */
    expect(first).toMatchObject({ debitSource: 'addon', addonGrantId: older });
    expect(second).toMatchObject({ debitSource: 'addon', addonGrantId: older });

    await commit(first);
    await commit(second);

    expect(await consumed(older)).toBe(1);
    expect(await consumed(newer)).toBe(1);
    const [event] = await db()
      .select({ addonGrantId: schema.usageEvent.addonGrantId })
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.requestId, second.requestId));
    expect(event?.addonGrantId).toBe(newer);
  });

  it('does not consume the pack twice when a commit is replayed', async () => {
    const workspaceId = await freeWorkspace();
    const only = await grant(workspaceId, 3, new Date());
    const reservation = await reserveCall({ workspaceId, requestId: `addon-commit-${uuidv7()}` });

    await commit(reservation);
    await commit(reservation);

    expect(await consumed(only)).toBe(1);
  });

  it('holds the seat again when a released request is reserved again', async () => {
    const workspaceId = await freeWorkspace(1);
    const retried = `addon-commit-${uuidv7()}`;

    const first = await reserveCall({ workspaceId, requestId: retried });
    expect(first.debitSource).toBe('plan');
    await releaseCall(first.reservationId);

    /* The retry takes the last call back, under the same request id... */
    const again = await reserveCall({ workspaceId, requestId: retried });
    expect(again.reservationId).toBe(first.reservationId);
    const [seat] = await db()
      .select({ status: schema.usageReservation.status })
      .from(schema.usageReservation)
      .where(eq(schema.usageReservation.id, again.reservationId));
    expect(seat?.status).toBe('pending');

    /* ...so nobody else can have it while the retry runs. */
    await expect(
      reserveCall({ workspaceId, requestId: `addon-commit-${uuidv7()}` }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
  });
});

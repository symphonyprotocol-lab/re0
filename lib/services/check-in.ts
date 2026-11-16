/**
 * Daily check-ins (docs/design/invitations.md): during an account's first
 * `check_in_window_months` months, a signed-in user may check in once per
 * calendar day (UTC+8, counted on the server) and is paid `check_in_credits`
 * as gift credits each time, up to `check_in_max_days` check-ins in all;
 * the days need not be consecutive.
 *
 * One check-in per day is the `check_in (user_id, day)` unique index; the
 * maximum is counted under a per-user advisory lock in the same transaction
 * as the insert and the grant, so a double click or a race never pays
 * twice. Settings are read inside that transaction; changing them leaves
 * check-ins already paid alone.
 */
import { and, count, eq, sql } from 'drizzle-orm';
import { addMonths } from '@/lib/domain/billing';
import { checkInDay, checkInState, type CheckInState } from '@/lib/domain/invites';
import { db, schema, type Executor } from '@/lib/infra/db';
import { addGrant } from '@/lib/services/credits';
import { rewardSettings } from '@/lib/services/invites';

export interface CheckInStatus {
  state: CheckInState;
  /** Credits one check-in pays now. */
  credits: number;
  used: number;
  maxDays: number;
  windowMonths: number;
  windowEndsAt: Date;
}

async function statusOf(executor: Executor, userId: string, now: Date): Promise<CheckInStatus & { createdAt: Date | null; today: boolean }> {
  const day = checkInDay(now);
  const [settings, [user], [used], [today]] = await Promise.all([
    rewardSettings(executor),
    executor.select({ createdAt: schema.user.createdAt }).from(schema.user).where(eq(schema.user.id, userId)).limit(1),
    executor.select({ n: count() }).from(schema.checkIn).where(eq(schema.checkIn.userId, userId)),
    executor.select({ id: schema.checkIn.id }).from(schema.checkIn).where(and(eq(schema.checkIn.userId, userId), eq(schema.checkIn.day, day))).limit(1),
  ]);
  const windowEndsAt = addMonths(user?.createdAt ?? now, settings.checkInWindowMonths);
  const input = { credits: settings.checkInCredits, used: used?.n ?? 0, maxDays: settings.checkInMaxDays, windowEndsAt, today: Boolean(today), now };
  return { state: checkInState(input), credits: input.credits, used: input.used, maxDays: input.maxDays, windowMonths: settings.checkInWindowMonths, windowEndsAt, createdAt: user?.createdAt ?? null, today: input.today };
}

/** Where the account stands today, for the task guide. */
export async function checkInStatus(userId: string, now = new Date()): Promise<CheckInStatus> {
  const { state, credits, used, maxDays, windowMonths, windowEndsAt } = await statusOf(db(), userId, now);
  return { state, credits, used, maxDays, windowMonths, windowEndsAt };
}

export type CheckInResult = { ok: true; credits: number; status: CheckInStatus } | { ok: false; reason: Exclude<CheckInState, 'available'>; status: CheckInStatus };

/** Checks the user in for today (UTC+8) and pays the reward, or says why not. */
export async function checkIn(userId: string, now = new Date()): Promise<CheckInResult> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`check-in:${userId}`}))`);
    const status = await statusOf(tx, userId, now);
    const view = (s: typeof status): CheckInStatus => ({ state: s.state, credits: s.credits, used: s.used, maxDays: s.maxDays, windowMonths: s.windowMonths, windowEndsAt: s.windowEndsAt });
    if (status.state !== 'available') return { ok: false, reason: status.state, status: view(status) };
    const [row] = await tx
      .insert(schema.checkIn)
      .values({ userId, day: checkInDay(now), credits: status.credits, createdAt: now })
      .onConflictDoNothing()
      .returning({ id: schema.checkIn.id });
    /* Unreachable under the lock; the unique index is the backstop. */
    if (!row) return { ok: false, reason: 'done_today', status: view({ ...status, state: 'done_today' }) };
    await addGrant(tx, { userId, source: 'welcome', amount: status.credits, reason: 'check_in', refId: row.id }, now);
    const used = status.used + 1;
    return { ok: true, credits: status.credits, status: view({ ...status, used, state: used >= status.maxDays ? 'finished' : 'done_today' }) };
  });
}

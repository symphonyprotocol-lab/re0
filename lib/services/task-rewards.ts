/**
 * New-user tasks (docs/design/invitations.md): publishing a first Ree,
 * a first post (public or private; a Ree owner's 试问 is not one), a first
 * 有帮助 on someone else's post or answer. Each pays its amount
 * from the console's settings once per account, as gift credits in the
 * welcome bucket -- spendable, never withdrawable -- inside the transaction
 * of the action itself. The `task_reward` primary key (user, task) is what
 * makes it once: a retry or a concurrent second action inserts nothing and
 * pays nothing. An amount of 0 pays nothing and leaves the task open, so
 * switching the reward back on later still pays the next qualifying action.
 *
 * Tasks count from when this shipped: an account's earlier Rees, questions
 * and comments are not paid; its next one is. A reward stays when what
 * earned it is later deleted.
 */
import { and, eq, sql } from 'drizzle-orm';
import { activityState, checkInDay, checkInState, newUserWindowEnd, paidTask, STARTER_TASKS, TASK_PREDECESSOR, TASK_REASON, TASK_SETTING, type ActivityState, type StarterTask } from '@/lib/domain/invites';
import { db, schema, type Tx } from '@/lib/infra/db';
import { addGrant } from '@/lib/services/credits';
import { DEFAULT_REWARD_SETTINGS, rewardSettings } from '@/lib/services/invites';
import { checkInStatus, type CheckInStatus } from '@/lib/services/check-in';

/**
 * Pays `task` to `userId` if it is on and not yet paid -- nor its retired
 * predecessor (`TASK_PREDECESSOR`), which no action writes any more, so
 * reading it needs no lock; answers the credits paid (0 for none).
 */
export async function grantTaskReward(tx: Tx, userId: string, task: StarterTask, refId: string, now = new Date()): Promise<number> {
  const settings = await rewardSettings(tx);
  const credits = settings[TASK_SETTING[task]];
  if (credits <= 0) return 0;
  const predecessor = TASK_PREDECESSOR[task];
  if (predecessor) {
    const [done] = await tx
      .select({ task: schema.taskReward.task })
      .from(schema.taskReward)
      .where(and(eq(schema.taskReward.userId, userId), eq(schema.taskReward.task, predecessor)))
      .limit(1);
    if (done) return 0;
  }
  const [claimed] = await tx
    .insert(schema.taskReward)
    .values({ userId, task, credits, refId, createdAt: now })
    .onConflictDoNothing()
    .returning({ task: schema.taskReward.task });
  if (!claimed) return 0;
  await addGrant(tx, { userId, source: 'welcome', amount: credits, reason: TASK_REASON[task], refId }, now);
  return credits;
}

export interface ActivityTask {
  key: 'signup' | StarterTask;
  done: boolean;
  /** Paid, for a done task; what it pays now, for an open one (null: the gift was off at sign-up). */
  credits: number | null;
}

export interface Activities {
  /** Registering, then each task that is paid or pays something now; a task whose reward is off and unpaid is left out. */
  tasks: ActivityTask[];
  /** Today's check-in, whatever its state (the page explains `off`, `expired` and `finished`). */
  checkIn: CheckInStatus;
  /** `activityState` (lib/domain/invites.ts): whether the page exists for this account, whether anything can be claimed now, and the dot. */
  state: ActivityState;
}

/** The Activities page (`/activities`): the starter tasks and the daily check-in. */
export async function activities(userId: string, now = new Date()): Promise<Activities> {
  const database = db();
  const [paid, [welcome], settings, checkIn] = await Promise.all([
    database.select({ task: schema.taskReward.task, credits: schema.taskReward.credits }).from(schema.taskReward).where(eq(schema.taskReward.userId, userId)),
    database
      .select({ delta: schema.creditEntry.delta })
      .from(schema.creditEntry)
      .where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.reason, 'welcome')))
      .limit(1),
    rewardSettings(database),
    checkInStatus(userId, now),
  ]);
  const tasks: ActivityTask[] = [{ key: 'signup', done: true, credits: welcome?.delta ?? null }];
  for (const task of STARTER_TASKS) {
    const row = paidTask(task, paid);
    if (row) tasks.push({ key: task, done: true, credits: row.credits });
    else if (settings[TASK_SETTING[task]] > 0) tasks.push({ key: task, done: false, credits: settings[TASK_SETTING[task]] });
  }
  const state = activityState({ checkIn: checkIn.state, settings, paidTasks: paid.map((row) => row.task), windowEndsAt: checkIn.windowEndsAt, now });
  return { tasks, checkIn, state };
}

/**
 * The 活动 navigation item -- whether it shows and whether it carries the
 * dot (`activityState`) -- for the workspace frame on every signed-in page:
 * one indexed query (the account, its check-in count and
 * today's row, its paid tasks, the settings row), no transaction.
 */
export async function activitiesIndicator(userId: string, now = new Date()): Promise<Pick<ActivityState, 'visible' | 'dot'>> {
  const day = checkInDay(now);
  const [row] = await db()
    .select({
      createdAt: schema.user.createdAt,
      used: sql<number>`(select count(*)::int from ${schema.checkIn} where ${schema.checkIn.userId} = ${schema.user.id})`,
      today: sql<boolean>`exists (select 1 from ${schema.checkIn} where ${schema.checkIn.userId} = ${schema.user.id} and ${schema.checkIn.day} = ${day})`,
      paid: sql<string[]>`coalesce((select array_agg(${schema.taskReward.task}::text) from ${schema.taskReward} where ${schema.taskReward.userId} = ${schema.user.id}), '{}'::text[])`,
      firstReeCredits: schema.rewardSettings.firstReeCredits,
      firstPostCredits: schema.rewardSettings.firstPostCredits,
      firstHelpfulCredits: schema.rewardSettings.firstHelpfulCredits,
      inviteCredits: schema.rewardSettings.inviteCredits,
      checkInCredits: schema.rewardSettings.checkInCredits,
      checkInMaxDays: schema.rewardSettings.checkInMaxDays,
      checkInWindowMonths: schema.rewardSettings.checkInWindowMonths,
    })
    .from(schema.user)
    .leftJoin(schema.rewardSettings, eq(schema.rewardSettings.id, 1))
    .where(eq(schema.user.id, userId))
    .limit(1);
  if (!row) return { visible: false, dot: false };
  const defaults = DEFAULT_REWARD_SETTINGS;
  const settings = {
    firstReeCredits: row.firstReeCredits ?? defaults.firstReeCredits,
    firstPostCredits: row.firstPostCredits ?? defaults.firstPostCredits,
    firstHelpfulCredits: row.firstHelpfulCredits ?? defaults.firstHelpfulCredits,
    inviteCredits: row.inviteCredits ?? defaults.inviteCredits,
    checkInCredits: row.checkInCredits ?? defaults.checkInCredits,
  };
  const windowEndsAt = newUserWindowEnd(row.createdAt, { checkInWindowMonths: row.checkInWindowMonths ?? defaults.checkInWindowMonths });
  const checkIn = checkInState({
    credits: settings.checkInCredits,
    used: Number(row.used),
    maxDays: row.checkInMaxDays ?? defaults.checkInMaxDays,
    windowEndsAt,
    today: Boolean(row.today),
    now,
  });
  const { visible, dot } = activityState({ checkIn, settings, paidTasks: row.paid ?? [], windowEndsAt, now });
  return { visible, dot };
}

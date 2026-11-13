/**
 * New-user tasks (docs/design/invitations.md): publishing a first Ree,
 * asking a first question, posting a first comment. Each pays its amount
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
import { and, eq } from 'drizzle-orm';
import { TASK_KINDS, TASK_REASON, TASK_SETTING, type TaskKind } from '@/lib/domain/invites';
import { db, schema, type Tx } from '@/lib/infra/db';
import { addGrant } from '@/lib/services/credits';
import { currentInviteState, rewardSettings } from '@/lib/services/invites';
import { checkInStatus, type CheckInStatus } from '@/lib/services/check-in';

/** Pays `task` to `userId` if it is on and not yet paid; answers the credits paid (0 for none). */
export async function grantTaskReward(tx: Tx, userId: string, task: TaskKind, refId: string, now = new Date()): Promise<number> {
  const settings = await rewardSettings(tx);
  const credits = settings[TASK_SETTING[task]];
  if (credits <= 0) return 0;
  const [claimed] = await tx
    .insert(schema.taskReward)
    .values({ userId, task, credits, refId, createdAt: now })
    .onConflictDoNothing()
    .returning({ task: schema.taskReward.task });
  if (!claimed) return 0;
  await addGrant(tx, { userId, source: 'welcome', amount: credits, reason: TASK_REASON[task], refId }, now);
  return credits;
}

export interface TaskGuideItem {
  key: 'signup' | TaskKind;
  done: boolean;
  /** Paid, for a done task; what it pays now, for an open one (null: the gift was off at sign-up). */
  credits: number | null;
}

export interface TaskGuide {
  /** False once dismissed, or once every task shown is done and no check-in is left. */
  visible: boolean;
  /** Dismissed, but check-ins are still to be had: the Rees page shows the check-in line alone. */
  checkInOnly: boolean;
  items: TaskGuideItem[];
  /** The daily check-in, or null when it is off and was never used. */
  checkIn: CheckInStatus | null;
  /** The invite line: what an invitation pays now and whether it is withdrawable, or null when invitations are off or unpaid. */
  invite: { credits: number; withdrawable: boolean } | null;
}

/**
 * The guide on the Rees page. A task whose reward is off and not yet paid is
 * left out; the guide is hidden once dismissed, or once every item is done
 * and the check-ins are finished, expired or off.
 */
export async function taskGuide(userId: string, now = new Date()): Promise<TaskGuide> {
  const database = db();
  const [[user], paid, [welcome], { settings, state, withdrawableOpen }, checkIn] = await Promise.all([
    database.select({ dismissedAt: schema.user.taskGuideDismissedAt }).from(schema.user).where(eq(schema.user.id, userId)).limit(1),
    database.select({ task: schema.taskReward.task, credits: schema.taskReward.credits }).from(schema.taskReward).where(eq(schema.taskReward.userId, userId)),
    database
      .select({ delta: schema.creditEntry.delta })
      .from(schema.creditEntry)
      .where(and(eq(schema.creditEntry.userId, userId), eq(schema.creditEntry.reason, 'welcome')))
      .limit(1),
    currentInviteState(database),
    checkInStatus(userId, now),
  ]);
  const items: TaskGuideItem[] = [{ key: 'signup', done: true, credits: welcome?.delta ?? null }];
  for (const task of TASK_KINDS) {
    const row = paid.find((entry) => entry.task === task);
    if (row) items.push({ key: task, done: true, credits: row.credits });
    else if (settings[TASK_SETTING[task]] > 0) items.push({ key: task, done: false, credits: settings[TASK_SETTING[task]] });
  }
  const checkInLeft = checkIn.state === 'available' || checkIn.state === 'done_today';
  const open = items.some((item) => !item.done) || checkInLeft;
  const shownCheckIn = checkIn.state === 'off' && checkIn.used === 0 ? null : checkIn;
  return {
    visible: !user?.dismissedAt && open,
    checkInOnly: Boolean(user?.dismissedAt) && checkIn.state === 'available',
    items,
    checkIn: shownCheckIn,
    invite: state === 'open' && settings.inviteCredits > 0 ? { credits: settings.inviteCredits, withdrawable: withdrawableOpen } : null,
  };
}

/** Closes the guide for good. */
export async function dismissTaskGuide(userId: string, now = new Date()): Promise<void> {
  await db().update(schema.user).set({ taskGuideDismissedAt: now }).where(eq(schema.user.id, userId));
}

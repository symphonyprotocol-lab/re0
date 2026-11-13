/**
 * Invitations (docs/design/invitations.md): each account's invite code, the
 * attribution of a new account to its inviter inside the registration
 * transaction, the site-wide quota of withdrawable invite rewards, and the
 * settings the console edits for invitations, the new-user tasks
 * (task-rewards.ts) and daily check-ins (check-in.ts).
 *
 * An invitation is attributed when a new user row is created through a
 * known code of an active account while invitations are switched on; an
 * invite never blocks signing up. The inviter is paid `invite_credits` each
 * time. The first `withdrawable_invites` paid invitations site-wide pay
 * withdrawable earned credits (no maturity wait, no Ree, no funding
 * purchase, so no refund voids them; payouts still apply every gate); later
 * ones pay the same amount as gift credits. Which one is decided by counting
 * the withdrawable rows under one advisory lock, so concurrent sign-ups never
 * pass the quota; the row records which it was.
 */
import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { INVITE_DEFAULTS, INVITEES_SHOWN } from '@/lib/constants';
import { inviteState, nextInviteWithdrawable, normalizeInviteCode, parseRewardSettings, randomInviteCode, type InviteState, type RewardSettings } from '@/lib/domain/invites';
import { db, schema, type Executor, type Tx } from '@/lib/infra/db';
import { AdminInputError, assertConsole, audit, type Administrator } from '@/lib/services/admin';
import { addGrant } from '@/lib/services/credits';

export const DEFAULT_REWARD_SETTINGS: RewardSettings = { ...INVITE_DEFAULTS, revision: 'default' };

/* --------------------------------------------------------- the settings */

/** Read inside the transaction that pays, so an amount is never cached across requests. */
export async function rewardSettings(executor: Executor = db()): Promise<RewardSettings> {
  const [row] = await executor
    .select({
      invitesEnabled: schema.rewardSettings.invitesEnabled,
      withdrawableInvites: schema.rewardSettings.withdrawableInvites,
      inviteCredits: schema.rewardSettings.inviteCredits,
      firstReeCredits: schema.rewardSettings.firstReeCredits,
      firstQuestionCredits: schema.rewardSettings.firstQuestionCredits,
      firstCommentCredits: schema.rewardSettings.firstCommentCredits,
      checkInCredits: schema.rewardSettings.checkInCredits,
      checkInMaxDays: schema.rewardSettings.checkInMaxDays,
      checkInWindowMonths: schema.rewardSettings.checkInWindowMonths,
      revision: schema.rewardSettings.revision,
    })
    .from(schema.rewardSettings)
    .where(eq(schema.rewardSettings.id, 1))
    .limit(1);
  return row ?? DEFAULT_REWARD_SETTINGS;
}

/** The console's save, against the revision the form was loaded with, in one transaction with its audit entry. */
export async function saveRewardSettings(administratorId: string, input: Record<string, unknown>): Promise<RewardSettings> {
  const values = parseRewardSettings(input);
  if (!values || typeof input.revision !== 'string') throw new AdminInputError('invalid_reward_settings');
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('settings:rewards'))`);
    const before = await rewardSettings(tx);
    if (input.revision !== before.revision) throw new AdminInputError('pricing_conflict');
    const next = { ...values, revision: randomUUID() };
    await tx
      .insert(schema.rewardSettings)
      .values({ ...next, updatedBy: administratorId })
      .onConflictDoUpdate({ target: schema.rewardSettings.id, set: { ...next, updatedBy: administratorId, updatedAt: new Date() } });
    await audit(tx, { administratorId, action: 'rewards.update', target: 'rewards', before, after: next });
    return next;
  });
}

/* ------------------------------------------------------------- the code */

/**
 * The account's invite code, created if it has none yet (accounts older than
 * invitations get theirs on first read). Safe when two requests race: the
 * insert does nothing on either conflict -- the account already has a code,
 * or the random code is taken -- and the loop reads or draws again.
 */
export async function ensureInviteCode(executor: Executor, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const [existing] = await executor.select({ code: schema.inviteCode.code }).from(schema.inviteCode).where(eq(schema.inviteCode.userId, userId)).limit(1);
    if (existing) return existing.code;
    const [created] = await executor
      .insert(schema.inviteCode)
      .values({ userId, code: randomInviteCode() })
      .onConflictDoNothing()
      .returning({ code: schema.inviteCode.code });
    if (created) return created.code;
  }
  throw new Error('could not find a free invite code');
}

/** The active account a code belongs to, if any. */
async function inviterOf(executor: Executor, code: string): Promise<{ id: string; name: string } | null> {
  const [row] = await executor
    .select({ id: schema.user.id, name: schema.user.name })
    .from(schema.inviteCode)
    .innerJoin(schema.user, eq(schema.user.id, schema.inviteCode.userId))
    .where(and(eq(schema.inviteCode.code, code), isNull(schema.user.disabledAt)))
    .limit(1);
  return row ?? null;
}

async function invitationCounts(executor: Executor): Promise<{ attributed: number; withdrawable: number }> {
  const [row] = await executor
    .select({ attributed: count(), withdrawable: sql<number>`count(*) filter (where ${schema.invitation.withdrawable})::int` })
    .from(schema.invitation);
  return { attributed: row?.attributed ?? 0, withdrawable: row?.withdrawable ?? 0 };
}

/* ----------------------------------------------------- the registration */

/** What became of an invite code: paid withdrawable, paid as gift credits, attributed with no reward, or not attributed and why. */
export type Attribution = 'withdrawable' | 'gift' | 'unpaid' | 'closed' | 'unknown' | 'none';

/**
 * Inside the registration transaction, right after the new user row: credits
 * the invitation to the code's owner when invitations are on, and pays the
 * inviter. Never throws for a bad code -- the account is created either way.
 */
export async function attributeInvitation(tx: Tx, inviteeId: string, rawCode: unknown, now = new Date()): Promise<Attribution> {
  if (rawCode === undefined || rawCode === null || rawCode === '') return 'none';
  const code = normalizeInviteCode(rawCode);
  if (!code) return 'unknown';
  const inviter = await inviterOf(tx, code);
  if (!inviter || inviter.id === inviteeId) return 'unknown';
  /* One attribution at a time, site-wide: the quota count below and the insert cannot interleave with another sign-up's. */
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('invitations:quota'))`);
  const settings = await rewardSettings(tx);
  if (inviteState(settings) !== 'open') return 'closed';
  const credits = settings.inviteCredits;
  const withdrawable = nextInviteWithdrawable(settings, (await invitationCounts(tx)).withdrawable);
  await tx.insert(schema.invitation).values({ inviteeId, inviterId: inviter.id, code, rewardCredits: credits, withdrawable, createdAt: now });
  if (credits === 0) return 'unpaid';
  if (withdrawable) {
    /* Withdrawable at once (no maturity wait); no funding purchase, so no refund can void it. */
    await addGrant(tx, { userId: inviter.id, source: 'earned', amount: credits, reason: 'invite_reward', refId: inviteeId, withdrawableAt: now, fundingPurchaseId: null, reeId: null }, now);
    return 'withdrawable';
  }
  await addGrant(tx, { userId: inviter.id, source: 'welcome', amount: credits, reason: 'invite_reward_gift', refId: inviteeId }, now);
  return 'gift';
}

/* --------------------------------------------------------- what users see */

export interface InviteSiteState {
  state: InviteState;
  settings: RewardSettings;
  attributed: number;
  withdrawableUsed: number;
  /** Whether the next invitation would still pay withdrawable credits. */
  withdrawableOpen: boolean;
}

/** The site's invitation state now. */
export async function currentInviteState(executor: Executor = db()): Promise<InviteSiteState> {
  const [settings, counts] = await Promise.all([rewardSettings(executor), invitationCounts(executor)]);
  return {
    state: inviteState(settings),
    settings,
    attributed: counts.attributed,
    withdrawableUsed: counts.withdrawable,
    withdrawableOpen: nextInviteWithdrawable(settings, counts.withdrawable),
  };
}

/** The login page's note for `?invite=`: who invited the visitor, while invitations are on. */
export async function inviteLanding(rawCode: unknown): Promise<{ state: InviteState | 'unknown'; inviterName: string | null; code: string | null }> {
  const code = normalizeInviteCode(rawCode);
  const inviter = code ? await inviterOf(db(), code) : null;
  if (!code || !inviter) return { state: 'unknown', inviterName: null, code: null };
  const { state } = await currentInviteState();
  return { state, inviterName: inviter.name, code };
}

export interface InvitePanel {
  code: string;
  state: InviteState;
  inviteCredits: number;
  /** Whether the site-wide quota still has withdrawable rewards left, and its size. */
  withdrawableOpen: boolean;
  withdrawableQuota: number;
  /** Everyone this account invited, newest first (the newest `INVITEES_SHOWN`). */
  invitees: { name: string; avatarBlob: string | null; createdAt: Date; rewardCredits: number; withdrawable: boolean }[];
  total: number;
  earnedWithdrawable: number;
  earnedGift: number;
}

/** The invite tab: the code, the site's state, and this account's invitations. */
export async function invitePanel(userId: string): Promise<InvitePanel> {
  const database = db();
  const [code, site, invitees, [totals]] = await Promise.all([
    ensureInviteCode(database, userId),
    currentInviteState(database),
    database
      .select({
        name: schema.user.name,
        avatarBlob: schema.user.avatarBlob,
        createdAt: schema.invitation.createdAt,
        rewardCredits: schema.invitation.rewardCredits,
        withdrawable: schema.invitation.withdrawable,
      })
      .from(schema.invitation)
      .innerJoin(schema.user, eq(schema.user.id, schema.invitation.inviteeId))
      .where(eq(schema.invitation.inviterId, userId))
      .orderBy(desc(schema.invitation.createdAt))
      .limit(INVITEES_SHOWN),
    database
      .select({
        total: count(),
        withdrawable: sql<number>`coalesce(sum(${schema.invitation.rewardCredits}) filter (where ${schema.invitation.withdrawable}), 0)::bigint`,
        gift: sql<number>`coalesce(sum(${schema.invitation.rewardCredits}) filter (where not ${schema.invitation.withdrawable}), 0)::bigint`,
      })
      .from(schema.invitation)
      .where(eq(schema.invitation.inviterId, userId)),
  ]);
  return {
    code,
    state: site.state,
    inviteCredits: site.settings.inviteCredits,
    withdrawableOpen: site.withdrawableOpen,
    withdrawableQuota: site.settings.withdrawableInvites,
    invitees,
    total: totals?.total ?? 0,
    earnedWithdrawable: Number(totals?.withdrawable ?? 0),
    earnedGift: Number(totals?.gift ?? 0),
  };
}

/* ------------------------------------------------------------ the console */

export interface InviteOverview {
  settings: RewardSettings;
  state: InviteState;
  attributed: number;
  withdrawableUsed: number;
  creditsWithdrawable: number;
  creditsGift: number;
  tasks: { task: string; accounts: number; credits: number }[];
  checkIns: { count: number; accounts: number; credits: number };
  inviters: { id: string; name: string; email: string; invited: number; credits: number }[];
  recent: { inviteeId: string; inviteeName: string; inviterId: string; inviterName: string; code: string; rewardCredits: number; withdrawable: boolean; createdAt: Date }[];
}

/** The console's 邀请与任务 page: the settings, the withdrawable quota's use, credits paid of each kind, check-ins, the leading inviters and the latest invitations. */
export async function inviteOverview(administrator: Administrator): Promise<InviteOverview> {
  assertConsole(administrator);
  const database = db();
  const [{ settings, state, attributed, withdrawableUsed }, [paid], [checkIns], tasks, inviters, recent] = await Promise.all([
    currentInviteState(database),
    database
      .select({
        withdrawable: sql<number>`coalesce(sum(${schema.invitation.rewardCredits}) filter (where ${schema.invitation.withdrawable}), 0)::bigint`,
        gift: sql<number>`coalesce(sum(${schema.invitation.rewardCredits}) filter (where not ${schema.invitation.withdrawable}), 0)::bigint`,
      })
      .from(schema.invitation),
    database
      .select({ count: count(), accounts: sql<number>`count(distinct ${schema.checkIn.userId})::int`, credits: sql<number>`coalesce(sum(${schema.checkIn.credits}), 0)::bigint` })
      .from(schema.checkIn),
    database
      .select({ task: schema.taskReward.task, accounts: count(), credits: sql<number>`coalesce(sum(${schema.taskReward.credits}), 0)::bigint` })
      .from(schema.taskReward)
      .groupBy(schema.taskReward.task),
    database
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
        invited: count(),
        credits: sql<number>`coalesce(sum(${schema.invitation.rewardCredits}), 0)::bigint`,
      })
      .from(schema.invitation)
      .innerJoin(schema.user, eq(schema.user.id, schema.invitation.inviterId))
      .groupBy(schema.user.id, schema.user.name, schema.user.email)
      .orderBy(desc(count()), schema.user.name)
      .limit(20),
    database.execute(sql`
      select i.invitee_id, invitee.name as invitee_name, i.inviter_id, inviter.name as inviter_name, i.code, i.reward_credits, i.withdrawable, i.created_at
      from invitation i
      join "user" invitee on invitee.id = i.invitee_id
      join "user" inviter on inviter.id = i.inviter_id
      order by i.created_at desc
      limit 20
    `),
  ]);
  return {
    settings,
    state,
    attributed,
    withdrawableUsed,
    creditsWithdrawable: Number(paid?.withdrawable ?? 0),
    creditsGift: Number(paid?.gift ?? 0),
    checkIns: { count: checkIns?.count ?? 0, accounts: Number(checkIns?.accounts ?? 0), credits: Number(checkIns?.credits ?? 0) },
    tasks: tasks.map((row) => ({ ...row, credits: Number(row.credits) })),
    inviters: inviters.map((row) => ({ ...row, credits: Number(row.credits) })),
    recent: (
      recent.rows as { invitee_id: string; invitee_name: string; inviter_id: string; inviter_name: string; code: string; reward_credits: number; withdrawable: boolean; created_at: string | Date }[]
    ).map((row) => ({
      inviteeId: row.invitee_id,
      inviteeName: row.invitee_name,
      inviterId: row.inviter_id,
      inviterName: row.inviter_name,
      code: row.code,
      rewardCredits: Number(row.reward_credits),
      withdrawable: row.withdrawable,
      createdAt: new Date(row.created_at),
    })),
  };
}

/** One user's side of invitations, for the console's user page: who invited them, how many they invited, and their check-ins. */
export async function userInvites(administrator: Administrator, userId: string) {
  assertConsole(administrator);
  const database = db();
  const [[invitedBy], [mine], [code], [checkIns]] = await Promise.all([
    database
      .select({ id: schema.user.id, name: schema.user.name, code: schema.invitation.code, createdAt: schema.invitation.createdAt })
      .from(schema.invitation)
      .innerJoin(schema.user, eq(schema.user.id, schema.invitation.inviterId))
      .where(eq(schema.invitation.inviteeId, userId))
      .limit(1),
    database
      .select({ invited: count(), credits: sql<number>`coalesce(sum(${schema.invitation.rewardCredits}), 0)::bigint` })
      .from(schema.invitation)
      .where(eq(schema.invitation.inviterId, userId)),
    database.select({ code: schema.inviteCode.code }).from(schema.inviteCode).where(eq(schema.inviteCode.userId, userId)).limit(1),
    database.select({ n: count() }).from(schema.checkIn).where(eq(schema.checkIn.userId, userId)),
  ]);
  return { invitedBy: invitedBy ?? null, invited: mine?.invited ?? 0, credits: Number(mine?.credits ?? 0), code: code?.code ?? null, checkIns: checkIns?.n ?? 0 };
}

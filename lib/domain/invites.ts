/**
 * Invitations and new-user tasks (docs/design/invitations.md), free of the
 * database: the invite code's format, the console's settings and their
 * bounds, which task pays which setting, and the check-in day.
 */
import {
  CHECK_IN_MAX_DAYS_MAX,
  CHECK_IN_TIME_ZONE,
  CHECK_IN_WINDOW_MONTHS_MAX,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  REWARD_CREDITS_MAX,
  WITHDRAWABLE_INVITES_MAX,
  WITHDRAWABLE_INVITES_PER_INVITER_MAX,
} from '@/lib/constants';
import type { CreditEntryReason } from '@/db/schema';
import { addMonths } from '@/lib/domain/billing';

/**
 * Every new-user task a `task_reward` row may name, besides registering
 * (whose gift is `signup_reward`): the current ones (`STARTER_TASKS`) and
 * the retired ones, which no action pays any more but whose rows and ledger
 * entries stay as history. v5 retired `first_question` (asking a Ree, now a
 * post) and `first_comment` (comments under a Ree) for `first_post` and
 * `first_helpful`.
 */
export const TASK_KINDS = ['first_ree', 'first_post', 'first_helpful', 'first_question', 'first_comment'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
/** The tasks that pay now and that the Activities page lists. */
export const STARTER_TASKS = ['first_ree', 'first_post', 'first_helpful'] as const satisfies readonly TaskKind[];
export type StarterTask = (typeof STARTER_TASKS)[number];
/**
 * A retired task that counts as this one done: a first private question was
 * a first post, so an account paid `first_question` is not paid `first_post`
 * again, and the page shows it done with what it was paid. `first_comment`
 * has no successor: marking something helpful is a new action.
 */
export const TASK_PREDECESSOR: Partial<Record<StarterTask, TaskKind>> = { first_post: 'first_question' };

/* ------------------------------------------------------------- the code */

/** `INVITE_CODE_LENGTH` characters drawn uniformly from the alphabet (32 symbols: every byte maps evenly). */
export function randomInviteCode(fill: (bytes: Uint8Array) => void = (bytes) => void crypto.getRandomValues(bytes)): string {
  const bytes = new Uint8Array(INVITE_CODE_LENGTH);
  fill(bytes);
  let code = '';
  for (const byte of bytes) code += INVITE_CODE_ALPHABET[byte % INVITE_CODE_ALPHABET.length];
  return code;
}

/** What a link or a typed code becomes before lookup: upper case, spaces and dashes dropped; null when it cannot be a code. */
export function normalizeInviteCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== INVITE_CODE_LENGTH) return null;
  for (const char of code) if (!INVITE_CODE_ALPHABET.includes(char)) return null;
  return code;
}

/** The sign-up link an inviter shares. */
export function inviteLink(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/$/, '')}/login?invite=${encodeURIComponent(code)}`;
}

/* --------------------------------------------------------- the settings */

export interface RewardSettings {
  invitesEnabled: boolean;
  /** Site-wide: how many invited registrations pay a withdrawable reward; later ones pay gift credits. */
  withdrawableInvites: number;
  /** Per inviter: how many of their invitations may pay a withdrawable reward. */
  withdrawableInvitesPerInviter: number;
  inviteCredits: number;
  firstReeCredits: number;
  firstPostCredits: number;
  firstHelpfulCredits: number;
  checkInCredits: number;
  checkInMaxDays: number;
  checkInWindowMonths: number;
  /** `default` until the first save. */
  revision: string;
}

export const REWARD_AMOUNT_FIELDS = ['inviteCredits', 'firstReeCredits', 'firstPostCredits', 'firstHelpfulCredits', 'checkInCredits'] as const;
export type RewardAmountField = (typeof REWARD_AMOUNT_FIELDS)[number];
/** Every number the console edits, with its upper bound (all from 0, except the window from 1). */
export const REWARD_NUMBER_BOUNDS = {
  withdrawableInvites: WITHDRAWABLE_INVITES_MAX,
  withdrawableInvitesPerInviter: WITHDRAWABLE_INVITES_PER_INVITER_MAX,
  inviteCredits: REWARD_CREDITS_MAX,
  firstReeCredits: REWARD_CREDITS_MAX,
  firstPostCredits: REWARD_CREDITS_MAX,
  firstHelpfulCredits: REWARD_CREDITS_MAX,
  checkInCredits: REWARD_CREDITS_MAX,
  checkInMaxDays: CHECK_IN_MAX_DAYS_MAX,
  checkInWindowMonths: CHECK_IN_WINDOW_MONTHS_MAX,
} as const;
export type RewardNumberField = keyof typeof REWARD_NUMBER_BOUNDS;
export const REWARD_NUMBER_FIELDS = Object.keys(REWARD_NUMBER_BOUNDS) as RewardNumberField[];
export const rewardNumberMin = (field: RewardNumberField) => (field === 'checkInWindowMonths' ? 1 : 0);

/** The console's input as settings, or null when any field is out of bounds. */
export function parseRewardSettings(input: Record<string, unknown>): Omit<RewardSettings, 'revision'> | null {
  if (typeof input.invitesEnabled !== 'boolean') return null;
  const values: Partial<Record<RewardNumberField, number>> = {};
  for (const field of REWARD_NUMBER_FIELDS) {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < rewardNumberMin(field) || value > REWARD_NUMBER_BOUNDS[field]) return null;
    values[field] = value;
  }
  return { invitesEnabled: input.invitesEnabled, ...(values as Record<RewardNumberField, number>) };
}

/** Whether a registration through an invite is attributed now: only when invitations are switched on. */
export type InviteState = 'open' | 'closed';
export function inviteState(settings: Pick<RewardSettings, 'invitesEnabled'>): InviteState {
  return settings.invitesEnabled ? 'open' : 'closed';
}

/** Whether the site-wide quota still has a withdrawable place. */
export function siteQuotaOpen(settings: Pick<RewardSettings, 'withdrawableInvites' | 'inviteCredits'>, withdrawableSoFar: number): boolean {
  return settings.inviteCredits > 0 && withdrawableSoFar < settings.withdrawableInvites;
}

export type InviteRewardKind = 'withdrawable' | 'site_quota' | 'inviter_cap';

/**
 * What the next invitation of one inviter pays: withdrawable while both the
 * site-wide quota has a place and the inviter is under their own cap;
 * otherwise gift credits, and which limit was reached. The site quota is
 * named first when both are reached. Only a withdrawable reward uses a place.
 */
export function inviteRewardKind(
  settings: Pick<RewardSettings, 'withdrawableInvites' | 'withdrawableInvitesPerInviter' | 'inviteCredits'>,
  siteWithdrawable: number,
  inviterWithdrawable: number,
): InviteRewardKind {
  if (!siteQuotaOpen(settings, siteWithdrawable)) return 'site_quota';
  return inviterWithdrawable < settings.withdrawableInvitesPerInviter ? 'withdrawable' : 'inviter_cap';
}

/** Whether any invitation can pay withdrawable credits under these settings at all. */
export function withdrawableInvitesPossible(settings: Pick<RewardSettings, 'withdrawableInvites' | 'withdrawableInvitesPerInviter' | 'inviteCredits'>): boolean {
  return settings.inviteCredits > 0 && settings.withdrawableInvites > 0 && settings.withdrawableInvitesPerInviter > 0;
}

/**
 * What the invite tab says about withdrawability, decided in one place so
 * the notes never contradict each other: the "first N, at most M each"
 * note and the inviter's progress only while withdrawable rewards are
 * possible at all; otherwise, plainly, that rewards are gift credits.
 */
export interface InvitePanelCopy {
  withdrawableNote: boolean;
  progress: boolean;
  status: 'closed' | 'gift_only' | 'site_quota_used' | 'own_cap_reached' | null;
}
export function invitePanelCopy(panel: {
  state: InviteState;
  inviteCredits: number;
  withdrawableQuota: number;
  withdrawableOpen: boolean;
  ownWithdrawable: number;
  ownCap: number;
}): InvitePanelCopy {
  if (panel.state !== 'open') return { withdrawableNote: false, progress: false, status: 'closed' };
  if (panel.inviteCredits <= 0) return { withdrawableNote: false, progress: false, status: null };
  if (panel.withdrawableQuota <= 0 || panel.ownCap <= 0) return { withdrawableNote: false, progress: false, status: 'gift_only' };
  const status = !panel.withdrawableOpen ? 'site_quota_used' : panel.ownWithdrawable >= panel.ownCap ? 'own_cap_reached' : null;
  return { withdrawableNote: true, progress: true, status };
}

/* ---------------------------------------------------------- check-ins */

/** The calendar day (YYYY-MM-DD) a moment falls on in `CHECK_IN_TIME_ZONE`. */
export function checkInDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: CHECK_IN_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The end of an account's new-user window: check-ins are open until then, and open starter tasks raise the navigation dot. */
export function newUserWindowEnd(createdAt: Date, settings: Pick<RewardSettings, 'checkInWindowMonths'>): Date {
  return addMonths(createdAt, settings.checkInWindowMonths);
}

export type CheckInState = 'available' | 'done_today' | 'finished' | 'expired' | 'off';

/** Where an account stands: off when the reward is 0, then expired past the window, finished at the maximum, otherwise today's state. */
export function checkInState(input: { credits: number; used: number; maxDays: number; windowEndsAt: Date; today: boolean; now: Date }): CheckInState {
  if (input.credits <= 0) return 'off';
  if (input.today) return input.used >= input.maxDays ? 'finished' : 'done_today';
  if (input.used >= input.maxDays) return 'finished';
  if (input.now.getTime() >= input.windowEndsAt.getTime()) return 'expired';
  return 'available';
}

/* ------------------------------------------------------------ the tasks */

export const TASK_SETTING: Record<StarterTask, RewardAmountField> = {
  first_ree: 'firstReeCredits',
  first_post: 'firstPostCredits',
  first_helpful: 'firstHelpfulCredits',
};

/** Each task's ledger reason, the retired ones included (their entries stay in the history). */
export const TASK_REASON: Record<TaskKind, CreditEntryReason> = {
  first_ree: 'task_first_ree',
  first_post: 'task_first_post',
  first_helpful: 'task_first_helpful',
  first_question: 'task_first_question',
  first_comment: 'task_first_comment',
};

/** Where the Activities page sends a user for each task: the composer for a post, the feed for something to mark helpful. */
export const TASK_HREF: Record<StarterTask, string> = {
  first_ree: '/rees/new',
  first_post: '/?compose=public',
  first_helpful: '/',
};

/** The paid row that settles `task`: its own, or its retired predecessor's. */
export function paidTask<Row extends { task: string }>(task: StarterTask, paid: readonly Row[]): Row | undefined {
  const predecessor = TASK_PREDECESSOR[task];
  return paid.find((row) => row.task === task) ?? (predecessor ? paid.find((row) => row.task === predecessor) : undefined);
}

/* ------------------------------------------------------- the activities */

/** A starter task still to be done that pays something now. */
export function openTasks(settings: Pick<RewardSettings, RewardAmountField>, paid: readonly string[]): StarterTask[] {
  const rows = paid.map((task) => ({ task }));
  return STARTER_TASKS.filter((task) => !paidTask(task, rows) && settings[TASK_SETTING[task]] > 0);
}

/** What the activities are judged on, read once for an account (`activities`, `activitiesIndicator`). */
export interface ActivityFacts {
  checkIn: CheckInState;
  settings: Pick<RewardSettings, RewardAmountField>;
  paidTasks: readonly string[];
  /** The new-user window's end (`newUserWindowEnd`): open tasks raise the dot only before it. */
  windowEndsAt: Date;
  now: Date;
}

/**
 * The activities on `/activities`, each answering for one account:
 * - `available`: it can still take part, now or on a later day. The page and
 *   its navigation item exist only while at least one is available.
 * - `claimable`: something can be claimed right now.
 * - `dot`: it should raise the dot on the navigation item.
 * A new kind of activity adds an entry here (and a section on the page).
 * Invitations are not one: they never run out and live in the settings
 * invite tab, so they would keep the page and the dot up for everyone.
 */
export const ACTIVITIES = [
  {
    key: 'check_in',
    /* Checked in today still counts: there is a check-in tomorrow. `finished`, `expired` and `off` are over. */
    available: (facts: ActivityFacts) => facts.checkIn === 'available' || facts.checkIn === 'done_today',
    claimable: (facts: ActivityFacts) => facts.checkIn === 'available',
    dot: (facts: ActivityFacts) => facts.checkIn === 'available',
  },
  {
    key: 'starter_tasks',
    /* An unpaid task with a reward stays available at any age; it raises the dot only within the new-user window. */
    available: (facts: ActivityFacts) => openTasks(facts.settings, facts.paidTasks).length > 0,
    claimable: (facts: ActivityFacts) => openTasks(facts.settings, facts.paidTasks).length > 0,
    dot: (facts: ActivityFacts) => facts.now.getTime() < facts.windowEndsAt.getTime() && openTasks(facts.settings, facts.paidTasks).length > 0,
  },
] as const satisfies readonly { key: string; available: (facts: ActivityFacts) => boolean; claimable: (facts: ActivityFacts) => boolean; dot: (facts: ActivityFacts) => boolean }[];

export interface ActivityState {
  /** At least one activity is available: the navigation item shows and `/activities` renders; otherwise the item is gone and the page redirects. */
  visible: boolean;
  /** Something can be claimed right now (the page's note when nothing can). */
  claimable: boolean;
  /** The navigation dot. Never up without `visible`. */
  dot: boolean;
}

export function activityState(facts: ActivityFacts): ActivityState {
  const available = ACTIVITIES.filter((activity) => activity.available(facts));
  return {
    visible: available.length > 0,
    claimable: available.some((activity) => activity.claimable(facts)),
    dot: available.some((activity) => activity.dot(facts)),
  };
}

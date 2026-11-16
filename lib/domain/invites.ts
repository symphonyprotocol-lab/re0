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

/** The new-user tasks that pay, besides registering (whose gift is `signup_reward`). */
export const TASK_KINDS = ['first_ree', 'first_question', 'first_comment'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

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
  firstQuestionCredits: number;
  firstCommentCredits: number;
  checkInCredits: number;
  checkInMaxDays: number;
  checkInWindowMonths: number;
  /** `default` until the first save. */
  revision: string;
}

export const REWARD_AMOUNT_FIELDS = ['inviteCredits', 'firstReeCredits', 'firstQuestionCredits', 'firstCommentCredits', 'checkInCredits'] as const;
export type RewardAmountField = (typeof REWARD_AMOUNT_FIELDS)[number];
/** Every number the console edits, with its upper bound (all from 0, except the window from 1). */
export const REWARD_NUMBER_BOUNDS = {
  withdrawableInvites: WITHDRAWABLE_INVITES_MAX,
  withdrawableInvitesPerInviter: WITHDRAWABLE_INVITES_PER_INVITER_MAX,
  inviteCredits: REWARD_CREDITS_MAX,
  firstReeCredits: REWARD_CREDITS_MAX,
  firstQuestionCredits: REWARD_CREDITS_MAX,
  firstCommentCredits: REWARD_CREDITS_MAX,
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

export const TASK_SETTING: Record<TaskKind, RewardAmountField> = {
  first_ree: 'firstReeCredits',
  first_question: 'firstQuestionCredits',
  first_comment: 'firstCommentCredits',
};

export const TASK_REASON: Record<TaskKind, CreditEntryReason> = {
  first_ree: 'task_first_ree',
  first_question: 'task_first_question',
  first_comment: 'task_first_comment',
};

/** Where the guide sends a user for each task. */
export const TASK_HREF: Record<TaskKind, string> = {
  first_ree: '/rees/new',
  first_question: '/explore',
  first_comment: '/explore',
};

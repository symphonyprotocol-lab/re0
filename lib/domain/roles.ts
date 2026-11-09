/**
 * User roles (rebuild-proposal.md 2.7, prototype user-role-domain.js): the
 * verification threshold, who may apply and when, what an application may
 * say, and the administrator's role changes. Pure rules; the services feed
 * them figures from the database.
 */
import {
  ROLE_REASON_MAX,
  ROLE_REQUIREMENTS,
  VERIFICATION_COOLDOWN_DAYS,
  VERIFICATION_LINK_MAX,
  VERIFICATION_LINKS_MAX,
  VERIFICATION_STATEMENT_MAX,
} from '@/lib/constants';

export const USER_ROLES = ['normal', 'verified', 'official'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * The threshold's figures for one user. Only the user's public Rees that are
 * not taken down count; questions and feedback count only when they come
 * from someone else.
 */
export interface RoleMetrics {
  /** Whole days since sign-up. */
  registeredDays: number;
  publicRees: number;
  /** Processed (ready) sources across those Rees, the trash excluded. */
  readySources: number;
  /** Questions other users asked those Rees. */
  externalQuestions: number;
  helpful: number;
  unhelpful: number;
  feedbackCount: number;
  /** helpful / feedbackCount, or null with no feedback from others yet. */
  helpfulRate: number | null;
}

export const REQUIREMENT_KEYS = ['registeredDays', 'publicRees', 'readySources', 'externalQuestions', 'helpfulRate'] as const;
export type RequirementKey = (typeof REQUIREMENT_KEYS)[number];

export interface RequirementCheck {
  key: RequirementKey;
  value: number | null;
  target: number;
  passed: boolean;
  /** What is still missing, in the item's unit (days, Rees, sources, questions, percentage points); 0 when met. */
  missing: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function registeredDays(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS));
}

export function helpfulRate(helpful: number, unhelpful: number): number | null {
  return helpful + unhelpful > 0 ? helpful / (helpful + unhelpful) : null;
}

export function verificationChecks(metrics: RoleMetrics): RequirementCheck[] {
  return REQUIREMENT_KEYS.map((key) => {
    const value = metrics[key];
    const target = ROLE_REQUIREMENTS[key];
    const passed = value !== null && Number.isFinite(value) && value >= target;
    let missing: number | null;
    if (passed) missing = 0;
    else if (value === null) missing = null;
    else if (key === 'helpfulRate') {
      /* Percentage points, rounded up to one decimal: 79.95% is still 0.1 short. */
      missing = Math.ceil((target - value) * 1000 - 1e-9) / 10;
    } else missing = Math.max(0, target - value);
    return { key, value, target, passed, missing };
  });
}

export function meetsRequirements(metrics: RoleMetrics): boolean {
  return verificationChecks(metrics).every((check) => check.passed);
}

export type VerificationBlock = 'disabled' | 'role' | 'pending' | 'cooldown' | 'requirements';

export interface VerificationAccess {
  eligible: boolean;
  reason: VerificationBlock | null;
  /** When the 30-day wait after a rejection ends (only with reason `cooldown`). */
  retryAt: Date | null;
}

/**
 * Whether the user may submit now, and why not. A request closed because an
 * administrator changed the role never starts the wait.
 */
export function verificationAccess(
  user: { role: UserRole; disabled: boolean },
  requests: readonly { status: string; decidedAt: Date | null; closedByRoleChange: boolean }[],
  metrics: RoleMetrics,
  now: Date,
): VerificationAccess {
  const pending = requests.some((request) => request.status === 'pending');
  const lastRejection = requests
    .filter((request) => request.status === 'rejected' && !request.closedByRoleChange && request.decidedAt)
    .map((request) => request.decidedAt!.getTime())
    .sort((a, b) => b - a)[0];
  const retryAt = lastRejection === undefined ? null : new Date(lastRejection + VERIFICATION_COOLDOWN_DAYS * DAY_MS);
  const reason: VerificationBlock | null = user.disabled
    ? 'disabled'
    : user.role !== 'normal'
      ? 'role'
      : pending
        ? 'pending'
        : retryAt && retryAt.getTime() > now.getTime()
          ? 'cooldown'
          : meetsRequirements(metrics)
            ? null
            : 'requirements';
  return { eligible: reason === null, reason, retryAt: reason === 'cooldown' ? retryAt : null };
}

/** Characters as a person counts them: an emoji is one. */
export function charLength(value: string): number {
  return Array.from(value).length;
}

export function parseVerificationInput(statementRaw: unknown, linksRaw: unknown): { statement: string; links: string[] } | { error: 'statement' | 'links' } {
  const statement = typeof statementRaw === 'string' ? statementRaw.trim() : '';
  if (!statement || charLength(statement) > VERIFICATION_STATEMENT_MAX) return { error: 'statement' };
  const values = (Array.isArray(linksRaw) ? linksRaw : [])
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  if (values.length > VERIFICATION_LINKS_MAX) return { error: 'links' };
  const links: string[] = [];
  for (const value of values) {
    try {
      const url = new URL(value);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password || url.href.length > VERIFICATION_LINK_MAX) {
        return { error: 'links' };
      }
      links.push(url.href);
    } catch {
      return { error: 'links' };
    }
  }
  return { statement, links };
}

/** A reason an administrator gives that the user will read: 1–500 characters. */
export function parseRoleReason(raw: unknown): string | null {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  return reason && charLength(reason) <= ROLE_REASON_MAX ? reason : null;
}

export const ROLE_ACTIONS = ['official', 'cancel_official', 'revoke'] as const;
export type RoleAction = (typeof ROLE_ACTIONS)[number];

export function isRoleAction(value: unknown): value is RoleAction {
  return typeof value === 'string' && (ROLE_ACTIONS as readonly string[]).includes(value);
}

/**
 * The console's direct role changes (2.7): make official from any role,
 * cancel official back to normal, revoke a verification back to normal.
 * Null when the action does not apply to the current role.
 */
export function roleAfter(current: UserRole, action: RoleAction): UserRole | null {
  if (action === 'official') return current === 'official' ? null : 'official';
  if (action === 'cancel_official') return current === 'official' ? 'normal' : null;
  return current === 'verified' ? 'normal' : null;
}

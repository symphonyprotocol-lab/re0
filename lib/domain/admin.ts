/**
 * Administration rules, as pure functions. No Next.js, no driver, no fetch.
 *
 * The console is a separate authority from the product: its own entrance, its
 * own credentials, a mandatory second factor, and a session that must not be
 * usable as a product session (requirement.md 3.2, 5.3).
 */

export type AdminCapability =
  | 'users'
  | 'libraries'
  | 'platformLibraries'
  | 'plans'
  | 'models'
  | 'billing'
  | 'administrators'
  | 'audit'
  | 'claims'
  | 'expertLibraries';

export const ADMIN_CAPABILITIES: readonly AdminCapability[] = [
  'users',
  'libraries',
  'platformLibraries',
  'plans',
  'models',
  'billing',
  'administrators',
  'audit',
  'claims',
  'expertLibraries',
];

export type AdminRoleId = 'super' | 'operator' | 'reviewer' | 'support';

export const ADMIN_ROLE_IDS: readonly AdminRoleId[] = ['super', 'operator', 'reviewer', 'support'];

/**
 * Least privilege, as requirement.md 3.1 and 5.3 describe the preset roles:
 * only the super administrator reaches everything, and each other role reaches
 * exactly what its job needs. This is the single source for both the console's
 * permission matrix and any server-side capability check.
 */
const ROLE_CAPABILITIES: Record<AdminRoleId, readonly AdminCapability[]> = {
  super: ADMIN_CAPABILITIES,
  /*
   * `models` is the playground's model registry and retrieval's tunables
   * (architecture.md 9.2, 9.5). It used to ride on `plans` because both are
   * "product configuration", but a plan version is a price and a model entry
   * is a provider endpoint that spends money on every call -- so the two are
   * named apart here, and a future role can be given one without the other.
   *
   * `claims` is ownership: ruling a dispute, transferring and revoking
   * (requirement.md 5.3, 7.3.5) rewrite `library.owner_workspace_id`, which
   * decides who is paid. That is an operator's decision, not a reviewer's --
   * a reviewer judges whether content may ship, never whose it is.
   *
   * `expertLibraries` (expert-library-prd.md 3) is both: approving an expert
   * library is a judgment about content, and its consequence is who is paid.
   * The operator and the reviewer each need the door; the detail screen shows
   * the owner's plan and never an amount, so a reviewer learns nothing about
   * billing through it.
   */
  operator: [
    'users',
    'libraries',
    'platformLibraries',
    'plans',
    'models',
    'billing',
    'claims',
    'expertLibraries',
  ],
  /*
   * `libraries` and `platformLibraries` are separate capabilities because
   * requirement.md 3.1 gives them to different people: a Reviewer decides
   * whether a *user's* public library may ship, while creating, refreshing,
   * suspending and publishing the platform's own libraries is the Operator's
   * job. One capability covering both would let a reviewer publish a library
   * under re0's name.
   */
  reviewer: ['libraries', 'expertLibraries'],
  support: ['users'],
};

export function capabilitiesForRoles(roles: readonly AdminRoleId[]): AdminCapability[] {
  const granted = new Set<AdminCapability>();
  for (const role of roles) {
    for (const capability of ROLE_CAPABILITIES[role] ?? []) granted.add(capability);
  }
  return ADMIN_CAPABILITIES.filter((capability) => granted.has(capability));
}

export function roleAllows(role: AdminRoleId, capability: AdminCapability): boolean {
  return (ROLE_CAPABILITIES[role] ?? []).includes(capability);
}

export function isAdminRoleId(value: unknown): value is AdminRoleId {
  return typeof value === 'string' && (ADMIN_ROLE_IDS as readonly string[]).includes(value);
}

/**
 * A console session lives 30 days past its last use, the same sliding window
 * as a product session (lib/domain/auth.ts): each touch moves `expires_at`
 * out again, and a month without use ends it.
 *
 * This is a product decision that trades the shorter working-day session
 * the console once had for not signing in with a second factor every
 * morning. What still bounds a console session: mandatory MFA at sign-in,
 * revocation when the account is disabled or its second factor cleared
 * (resolve-admin-session.ts), and the audit log.
 */
export const ADMIN_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * The absolute cap: however regularly it is used, a console session ends 90
 * days after sign-in and the administrator signs in again, second factor
 * included. The sliding window never moves past it.
 */
export const ADMIN_SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** `last_seen_at` and `expires_at` are rewritten at most this often. */
export const ADMIN_SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

/** Failed attempts before the account stops answering, and for how long. */
export const ADMIN_MAX_FAILED_ATTEMPTS = 5;
export const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;

export interface AdminSessionRow {
  expiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * Live means: not revoked, inside its sliding window, and under the cap.
 *
 * The cap is checked here as well as applied in `adminSessionExpiryFrom`, so
 * a row whose `expires_at` was written before the cap existed still ends on
 * time.
 */
export function isAdminSessionLive(session: AdminSessionRow, now: Date): boolean {
  if (session.revokedAt !== null) return false;
  if (session.expiresAt.getTime() <= now.getTime()) return false;
  return now.getTime() - session.createdAt.getTime() < ADMIN_SESSION_MAX_AGE_MS;
}

/** Whether this use should move the window (and rewrite `last_seen_at`). */
export function shouldTouchAdminSession(session: AdminSessionRow, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= ADMIN_SESSION_TOUCH_INTERVAL_MS;
}

/**
 * Where the window ends for a session used now: at sign-in (when `createdAt`
 * is `now`) and on every touch -- 30 days out, but never past the cap.
 */
export function adminSessionExpiryFrom(now: Date, createdAt: Date = now): Date {
  const sliding = now.getTime() + ADMIN_SESSION_LIFETIME_MS;
  const cap = createdAt.getTime() + ADMIN_SESSION_MAX_AGE_MS;
  return new Date(Math.min(sliding, cap));
}

export function isLockedOut(lockedUntil: Date | null, now: Date): boolean {
  return lockedUntil !== null && lockedUntil.getTime() > now.getTime();
}

export function lockoutUntil(failedAttempts: number, now: Date): Date | null {
  return failedAttempts >= ADMIN_MAX_FAILED_ATTEMPTS
    ? new Date(now.getTime() + ADMIN_LOCKOUT_MS)
    : null;
}

/**
 * Stable, user-facing failure codes for the console sign-in.
 *
 * Deliberately coarse. The form takes address, password and code together, so
 * one generic answer for all three costs a mistyping administrator nothing and
 * denies an attacker the oracle that a separate "wrong code" reply would be
 * -- it would confirm the password was right (architecture.md 5.4).
 *
 * There is deliberately no `locked` code either: telling an unauthenticated
 * caller that an address is locked tells them the address is an administrator,
 * which is exactly the enumeration the decoy password hash exists to prevent.
 * The lockout is real, it is recorded in the audit log, and the browser is told
 * the same thing it is told for a typo.
 */
export const ADMIN_LOGIN_ERRORS = ['invalid_credentials', 'rate_limited', 'unavailable'] as const;

export type AdminLoginError = (typeof ADMIN_LOGIN_ERRORS)[number];

export function isAdminLoginError(value: unknown): value is AdminLoginError {
  return typeof value === 'string' && (ADMIN_LOGIN_ERRORS as readonly string[]).includes(value);
}

/**
 * A sign-in attempt that ended for a reason the administrator may see.
 *
 * `message` is for the audit trail and our own logs; only `loginError` ever
 * reaches the browser.
 */
export class AdminAuthFailure extends Error {
  constructor(
    readonly loginError: AdminLoginError,
    message: string,
  ) {
    super(message);
    this.name = 'AdminAuthFailure';
  }
}

/**
 * Post-sign-in destinations inside the console, as prefixes.
 *
 * The same strict allow list `safeReturnTo` applies to the product, narrowed to
 * `/admin`: a console session must never be bounced onto a product page, and an
 * open redirect out of the console would be worth more to an attacker than one
 * out of the dashboard.
 */
export const ADMIN_DEFAULT_RETURN_TO = '/admin/overview';

export function safeAdminReturnTo(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) {
    return ADMIN_DEFAULT_RETURN_TO;
  }
  if (!input.startsWith('/admin/') || input.startsWith('//')) return ADMIN_DEFAULT_RETURN_TO;
  if (input.includes('\\')) return ADMIN_DEFAULT_RETURN_TO;
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return ADMIN_DEFAULT_RETURN_TO;
  }
  // The sign-in itself is not a destination; it would loop.
  const path = (input.split('?')[0] ?? '').split('#')[0] ?? '';
  if (path === '/admin/login') return ADMIN_DEFAULT_RETURN_TO;
  return input;
}

/* ------------------------------------------------- managing administrators */

export const ADMIN_STATUSES = ['invited', 'active', 'disabled'] as const;

export type AdminStatus = (typeof ADMIN_STATUSES)[number];

export function isAdminStatus(value: unknown): value is AdminStatus {
  return typeof value === 'string' && (ADMIN_STATUSES as readonly string[]).includes(value);
}

/** How long an invitation stays usable before it stops being a way in. */
export const ADMIN_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function inviteExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + ADMIN_INVITE_TTL_MS);
}

export function isInviteLive(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() > now.getTime();
}

/** Minimum length for a chosen administrator password. */
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 256;

export function isAcceptableAdminPassword(password: string): boolean {
  return (
    password.length >= ADMIN_PASSWORD_MIN_LENGTH && password.length <= ADMIN_PASSWORD_MAX_LENGTH
  );
}

/**
 * Why a change to an administrator was refused.
 *
 * Unlike the sign-in codes these are shown to a signed-in super administrator
 * who is entitled to know exactly what went wrong, so they are specific.
 */
export const ADMIN_CHANGE_ERRORS = [
  'not_found',
  'self_change',
  'last_super_admin',
  'email_taken',
  'invalid_input',
  'invite_invalid',
  'weak_password',
  'reason_required',
  'already_enrolled',
  /** Registering the first administrator, on an installation that has one. */
  'bootstrap_closed',
  /** A settlement period that is not a past `YYYY-MM`. */
  'period_invalid',
  /** MFA can only be reset on an active, enrolled account. */
  'not_enrolled',
] as const;

export type AdminChangeError = (typeof ADMIN_CHANGE_ERRORS)[number];

export function isAdminChangeError(value: unknown): value is AdminChangeError {
  return typeof value === 'string' && (ADMIN_CHANGE_ERRORS as readonly string[]).includes(value);
}

export class AdminChangeRefused extends Error {
  constructor(
    readonly code: AdminChangeError,
    message: string,
  ) {
    super(message);
    this.name = 'AdminChangeRefused';
  }
}

/** An audited action has to say why. requirement.md 5.3. */
export const ADMIN_REASON_MAX_LENGTH = 200;

export function normalizeReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new AdminChangeRefused('reason_required', 'a reason is recorded with every change');
  }
  return trimmed.slice(0, ADMIN_REASON_MAX_LENGTH);
}

/**
 * Whether an administrator may act on a target.
 *
 * Two rules, and both exist to stop the console being locked shut:
 *
 * - nobody edits their own role or status, because the mistake is unrecoverable
 *   from inside the console -- there would be no one entitled to undo it;
 * - the last active super administrator cannot be demoted or disabled, for the
 *   same reason. Adding a second one first is the way past this.
 */
export function refuseSelfChange(actorId: string, targetId: string): void {
  if (actorId === targetId) {
    throw new AdminChangeRefused(
      'self_change',
      'an administrator cannot change their own role or status',
    );
  }
}

export function refuseLastSuperAdmin(input: {
  targetIsSuper: boolean;
  otherActiveSuperAdmins: number;
}): void {
  if (input.targetIsSuper && input.otherActiveSuperAdmins === 0) {
    throw new AdminChangeRefused(
      'last_super_admin',
      'the last active super administrator cannot be demoted or disabled',
    );
  }
}

/* --------------------------------------------- registered user accounts */

/**
 * What the console may set a registered account to.
 *
 * Deliberately narrower than the `user.status` column: the column is text and
 * could hold anything a future flow invents, but the two values an operator
 * decides between are enable and suspend (requirement.md 5.3).
 */
export const USER_ACCOUNT_STATUSES = ['active', 'suspended'] as const;

export type UserAccountStatus = (typeof USER_ACCOUNT_STATUSES)[number];

export function isUserAccountStatus(value: unknown): value is UserAccountStatus {
  return typeof value === 'string' && (USER_ACCOUNT_STATUSES as readonly string[]).includes(value);
}

/* ------------------------------------------------ settlement statements */

/**
 * Where a locked period's pool goes, as statement rows -- the console's
 * "generate statements" step, kept pure so the rules can be pinned without
 * a database (publisher-revenue-share.md 3.3, 3.4, 8).
 *
 * The inputs are what the ledger holds: the frozen period figures, the
 * unflagged earning events grouped by owner and library, the publisher
 * accounts that exist, and the statements already written for the period.
 * The output is only what is missing. Running it twice over the same ledger
 * therefore plans nothing the second time, which is the idempotency the
 * console action depends on -- the button can be pressed again after a
 * publisher finally accepts the agreement, and only that publisher's rows
 * appear.
 *
 * Allocation is linear in attributable calls with the floor taken per
 * library, so the sum of a period's statements never exceeds its pool and
 * every row is recomputable from the events plus the period row. Nothing is
 * weighted by Trust Score (publisher-revenue-share.md 6.2).
 */
export interface SettlementPlanInput {
  period: { id: string; poolMinor: number; totalAttributableCalls: number; currency: string };
  /** Unflagged events per (owner workspace, library). */
  groups: { ownerWorkspaceId: string; libraryId: string; calls: number }[];
  /** Workspace id -> publisher account id, for every owner with an account. */
  accounts: ReadonlyMap<string, string>;
  /** Library ids that already carry a statement for this period. */
  existing: ReadonlySet<string>;
}

export interface PlannedStatement {
  periodId: string;
  publisherAccountId: string;
  libraryId: string;
  attributableCalls: number;
  amountMinor: number;
  currency: string;
}

export interface SettlementPlan {
  rows: PlannedStatement[];
  /** Libraries whose owner has no publisher account yet; their events wait. */
  withoutAccount: number;
  /** Libraries that already had a statement and were left alone. */
  alreadyPresent: number;
}

export function planSettlementStatements(input: SettlementPlanInput): SettlementPlan {
  const rows: PlannedStatement[] = [];
  let withoutAccount = 0;
  let alreadyPresent = 0;

  const total = input.period.totalAttributableCalls;
  for (const group of input.groups) {
    if (group.calls <= 0) continue;
    if (input.existing.has(group.libraryId)) {
      alreadyPresent += 1;
      continue;
    }
    const publisherAccountId = input.accounts.get(group.ownerWorkspaceId);
    if (!publisherAccountId) {
      withoutAccount += 1;
      continue;
    }
    rows.push({
      periodId: input.period.id,
      publisherAccountId,
      libraryId: group.libraryId,
      attributableCalls: group.calls,
      amountMinor:
        total <= 0 ? 0 : Math.floor((input.period.poolMinor * group.calls) / total),
      currency: input.period.currency,
    });
  }

  return { rows, withoutAccount, alreadyPresent };
}

/** `YYYY-MM`, and a month that has ended: a period cannot be settled mid-way. */
export function isSettleablePeriod(periodId: string, now: Date): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(periodId);
  if (!match) return false;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return false;
  const end = Date.UTC(Number(match[1]), month, 1);
  return end <= now.getTime();
}

/**
 * When a locked period's statements leave the hold window
 * (publisher-revenue-share.md 3.4): the refund and chargeback window counted
 * from the lock, not from the calls.
 */
export function holdEndsAt(lockedAt: Date, holdDays: number): Date {
  return new Date(lockedAt.getTime() + holdDays * 24 * 60 * 60 * 1000);
}

/* ------------------------------------------------------- audit value diff */

/**
 * One leaf that differs between an audit entry's before and after values.
 * `before` or `after` is `undefined` when the path exists on one side only.
 */
export interface AuditValueChange {
  path: string;
  before: unknown;
  after: unknown;
}

/** Objects are walked; arrays and scalars are leaves, compared whole. */
function flattenValue(value: unknown, prefix: string, into: Map<string, unknown>): void {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      into.set(prefix || '.', value);
      return;
    }
    for (const [key, child] of entries) {
      flattenValue(child, prefix ? `${prefix}.${key}` : key, into);
    }
    return;
  }
  into.set(prefix || '.', value);
}

/**
 * The compact diff the audit screen shows: every leaf path whose value
 * differs between the two snapshots, in the order the paths first appear
 * (before's keys, then after's additions). Same-valued leaves are left out
 * so a row that changed one field reads as one line, not the whole record.
 *
 * Leaves are compared by their JSON form, which is also how `auditHash`
 * sees them -- so what this reports as unchanged is what the chain hashed as
 * unchanged.
 */
export function diffAuditValues(before: unknown, after: unknown): AuditValueChange[] {
  const left = new Map<string, unknown>();
  const right = new Map<string, unknown>();
  if (before !== undefined && before !== null) flattenValue(before, '', left);
  if (after !== undefined && after !== null) flattenValue(after, '', right);

  const changes: AuditValueChange[] = [];
  const seen = new Set<string>();
  for (const path of [...left.keys(), ...right.keys()]) {
    if (seen.has(path)) continue;
    seen.add(path);
    const a = left.get(path);
    const b = right.get(path);
    if (left.has(path) && right.has(path) && JSON.stringify(a) === JSON.stringify(b)) continue;
    changes.push({ path, before: a, after: b });
  }
  return changes;
}

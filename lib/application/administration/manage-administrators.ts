/**
 * Use cases behind the administrators screen: list, invite, enrol, change role,
 * change status, revoke sessions, reset the second factor.
 *
 * requirement.md 5.3 asks for least-privilege roles, invitation, deactivation
 * and enforced MFA, and requires every sensitive action to record the operator,
 * the target, the values before and after, the reason, the result, the time and
 * a summary of the network origin. `recordAudit` takes all of that; the callers
 * here supply it.
 */
import { and, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import {
  AdminChangeRefused,
  ADMIN_PASSWORD_MIN_LENGTH,
  normalizeReason,
  capabilitiesForRoles,
  inviteExpiryFrom,
  isAcceptableAdminPassword,
  isAdminRoleId,
  isInviteLive,
  refuseLastSuperAdmin,
  refuseSelfChange,
  type AdminRoleId,
  type AdminStatus,
} from '@/lib/domain/admin';
import { randomTotpSecret, totpProvisioningUri, verifyTotpCounter } from '@/lib/domain/totp';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { seal, unseal } from '@/lib/infrastructure/crypto/sealed';
import { hmacSha256, randomToken } from '@/lib/infrastructure/crypto/tokens';
import { likePattern } from './like-pattern';
import { hashAdminPassword } from './password';
import { recordAudit } from './audit';

function signingSecret(): string {
  const secret = process.env.SESSION_SIGNING_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SIGNING_SECRET is not set (needs at least 32 characters)');
  }
  return secret;
}

/**
 * Advisory lock key for claiming the empty installation. Arbitrary but fixed,
 * and distinct from the audit chain's: every candidate for the first
 * administrator has to pick the same number for the lock to serialize them.
 */
const BOOTSTRAP_LOCK = 0x7265_63_31;

/** Same "never store the secret itself" rule the session tokens follow. */
function inviteTokenHash(token: string): Promise<string> {
  return hmacSha256(signingSecret(), `admin-invite:${token}`);
}

/**
 * How long a rendered enrolment form stays good. Long enough to fetch a phone
 * and scan a code; short enough that a page left open is not a standing offer.
 */
const ENROLMENT_TICKET_TTL_MS = 30 * 60 * 1000;

/** `randomTotpSecret`'s 20 bytes (RFC 4226's recommendation), as base32. */
const TOTP_SECRET_PATTERN = /^[A-Z2-7]{32}$/;

interface EnrolmentTicket {
  purpose: 'admin-totp';
  /** What the secret may be bound to: `bootstrap`, or `invite:<token hash>`. */
  binding: string;
  secret: string;
  expiresAt: number;
}

/**
 * A fresh TOTP secret, and the sealed ticket that carries it back.
 *
 * Random per render, not derived. Deriving it from `SESSION_SIGNING_SECRET`
 * made the second factor a function of a secret that every environment shares
 * (architecture.md 3.2): any checkout with that secret and an empty console
 * printed the production super administrator's seed, and anyone holding the
 * secret could recompute an invitee's. A random seed is known only to whoever
 * saw that one render.
 *
 * The ticket is what keeps the browser out of the decision, which is why the
 * derivation existed: it is AES-GCM sealed, so a caller cannot post a secret of
 * its choosing, and it names the invitation (or the empty console) it was
 * minted for, so one invitation's ticket cannot enrol another.
 */
async function mintEnrolmentTicket(
  binding: string,
  now: Date = new Date(),
): Promise<{ secret: string; ticket: string }> {
  const secret = randomTotpSecret();
  const ticket: EnrolmentTicket = {
    purpose: 'admin-totp',
    binding,
    secret,
    expiresAt: now.getTime() + ENROLMENT_TICKET_TTL_MS,
  };
  return { secret, ticket: await seal(ticket) };
}

/** The secret a ticket carries, or null when it is forged, expired or minted for something else. */
async function secretFromTicket(
  ticket: string | null | undefined,
  binding: string,
  now: Date,
): Promise<string | null> {
  const opened = await unseal<Partial<EnrolmentTicket>>(ticket);
  if (
    !opened ||
    opened.purpose !== 'admin-totp' ||
    opened.binding !== binding ||
    typeof opened.expiresAt !== 'number' ||
    opened.expiresAt <= now.getTime() ||
    typeof opened.secret !== 'string' ||
    !TOTP_SECRET_PATTERN.test(opened.secret)
  ) {
    return null;
  }
  return opened.secret;
}

export interface AdministratorRow {
  id: string;
  username: string;
  email: string;
  roles: AdminRoleId[];
  status: AdminStatus;
  lastActiveAt: Date | null;
  createdAt: Date;
  mfaEnrolled: boolean;
  /** Live console sessions, so an operator can see what revoking would end. */
  activeSessions: number;
  inviteExpiresAt: Date | null;
}

export async function listAdministrators(query?: string): Promise<AdministratorRow[]> {
  const database = db();
  const term = query?.trim();
  const pattern = term ? likePattern(term) : '';
  const filter = term
    ? or(
        ilike(schema.administrator.username, pattern),
        ilike(schema.administrator.email, pattern),
      )
    : undefined;

  const rows = await database
    .select({
      id: schema.administrator.id,
      username: schema.administrator.username,
      email: schema.administrator.email,
      status: schema.administrator.status,
      lastActiveAt: schema.administrator.lastActiveAt,
      createdAt: schema.administrator.createdAt,
      mfaEnrolledAt: schema.administrator.mfaEnrolledAt,
      inviteExpiresAt: schema.administrator.inviteExpiresAt,
    })
    .from(schema.administrator)
    .where(filter)
    .orderBy(schema.administrator.createdAt);

  if (rows.length === 0) return [];

  const ids = rows.map((row) => row.id);

  /*
   * Roles and session counts in one query each rather than per row: the list is
   * small today, but a per-row query is the kind of thing that only shows up as
   * a problem once there are enough administrators to care.
   */
  const roleRows = await database
    .select({
      administratorId: schema.administratorRole.administratorId,
      roleId: schema.administratorRole.roleId,
    })
    .from(schema.administratorRole)
    .where(inArray(schema.administratorRole.administratorId, ids));

  const now = new Date();
  const sessionRows = await database
    .select({
      administratorId: schema.adminSession.administratorId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.adminSession)
    .where(
      and(
        inArray(schema.adminSession.administratorId, ids),
        isNull(schema.adminSession.revokedAt),
        sql`${schema.adminSession.expiresAt} > ${now}`,
      ),
    )
    .groupBy(schema.adminSession.administratorId);

  const rolesById = new Map<string, AdminRoleId[]>();
  for (const role of roleRows) {
    if (!isAdminRoleId(role.roleId)) continue;
    const list = rolesById.get(role.administratorId) ?? [];
    list.push(role.roleId);
    rolesById.set(role.administratorId, list);
  }
  const sessionsById = new Map(sessionRows.map((row) => [row.administratorId, row.count]));

  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email,
    roles: rolesById.get(row.id) ?? [],
    status: (row.status as AdminStatus) ?? 'invited',
    lastActiveAt: row.lastActiveAt,
    createdAt: row.createdAt,
    mfaEnrolled: row.mfaEnrolledAt !== null,
    activeSessions: sessionsById.get(row.id) ?? 0,
    inviteExpiresAt: row.inviteExpiresAt,
  }));
}

/** Postgres `unique_violation`. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

interface Actor {
  administratorId: string;
  email: string;
  clientAddress?: string | null;
}

type Tx = Parameters<Parameters<ReturnType<typeof db>['transaction']>[0]>[0];

/**
 * Serialises the last-super-admin guard with the write it protects.
 *
 * The guard used to be a plain read before the transaction opened, so two
 * operators demoting each other both counted the other as "another active
 * super admin", both passed, and both wrote -- leaving zero. Locking the
 * target row and every active super admin `FOR UPDATE`, in one id-ordered
 * statement, makes concurrent demotions take the same locks in the same
 * order: the loser waits here, and the recount that follows (a fresh
 * statement, so it sees the winner's committed write) refuses it.
 */
async function lockLastSuperAdminGuardRows(tx: Tx, targetId: string): Promise<void> {
  await tx
    .select({ id: schema.administrator.id })
    .from(schema.administrator)
    .where(
      or(
        eq(schema.administrator.id, targetId),
        and(
          eq(schema.administrator.status, 'active'),
          sql`exists (
            select 1 from ${schema.administratorRole}
            where ${schema.administratorRole.administratorId} = ${schema.administrator.id}
              and ${schema.administratorRole.roleId} = 'super'
          )`,
        ),
      ),
    )
    .orderBy(schema.administrator.id)
    .for('update');
}

async function countOtherActiveSuperAdmins(tx: Tx, targetId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.administratorRole)
    .innerJoin(
      schema.administrator,
      eq(schema.administrator.id, schema.administratorRole.administratorId),
    )
    .where(
      and(
        eq(schema.administratorRole.roleId, 'super'),
        eq(schema.administrator.status, 'active'),
        ne(schema.administrator.id, targetId),
      ),
    );
  return row?.count ?? 0;
}

async function loadTarget(administratorId: string) {
  const [row] = await db()
    .select({
      id: schema.administrator.id,
      username: schema.administrator.username,
      email: schema.administrator.email,
      status: schema.administrator.status,
    })
    .from(schema.administrator)
    .where(eq(schema.administrator.id, administratorId))
    .limit(1);
  if (!row) throw new AdminChangeRefused('not_found', 'no such administrator');

  const roles = (
    await db()
      .select({ roleId: schema.administratorRole.roleId })
      .from(schema.administratorRole)
      .where(eq(schema.administratorRole.administratorId, administratorId))
  )
    .map((role) => role.roleId)
    .filter(isAdminRoleId);

  return { ...row, roles };
}

export interface InviteResult {
  administratorId: string;
  /** Shown once; only its digest is stored. */
  enrolmentPath: string;
  expiresAt: Date;
}

export async function inviteAdministrator(input: {
  actor: Actor;
  email: string;
  username: string;
  role: string;
}): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();
  const username = input.username.trim();
  if (!email.includes('@') || email.length > 254 || username.length === 0 || username.length > 80) {
    throw new AdminChangeRefused('invalid_input', 'email and username are required');
  }
  if (!isAdminRoleId(input.role)) {
    throw new AdminChangeRefused('invalid_input', 'unknown role');
  }

  const database = db();
  const [existing] = await database
    .select({ id: schema.administrator.id })
    .from(schema.administrator)
    .where(eq(schema.administrator.email, email))
    .limit(1);
  if (existing) {
    throw new AdminChangeRefused('email_taken', 'that address is already an administrator');
  }

  const now = new Date();
  const token = randomToken();
  const administratorId = crypto.randomUUID();
  const expiresAt = inviteExpiryFrom(now);

  try {
    await database.transaction(async (tx) => {
      await tx.insert(schema.administrator).values({
        id: administratorId,
        username,
        email,
        passwordHash: null,
        status: 'invited',
        inviteTokenHash: await inviteTokenHash(token),
        inviteExpiresAt: expiresAt,
        invitedBy: input.actor.administratorId,
      });
      await tx.insert(schema.administratorRole).values({ administratorId, roleId: input.role });
    });
  } catch (error) {
    /*
     * The check above is a read followed by a write, so two invitations to the
     * same address can both pass it. The unique index is what actually holds
     * the line; catching its violation is what turns the loser of that race
     * into the accurate answer instead of a generic "check the form".
     */
    if (isUniqueViolation(error)) {
      throw new AdminChangeRefused('email_taken', 'that address is already an administrator');
    }
    throw error;
  }

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'admin.invite',
    targetType: 'administrator',
    targetId: email,
    afterValue: { username, role: input.role, status: 'invited' },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { administratorId, enrolmentPath: `/admin/enroll?token=${token}`, expiresAt };
}

export async function changeAdministratorRole(input: {
  actor: Actor;
  administratorId: string;
  role: string;
  reason: string;
}): Promise<void> {
  if (!isAdminRoleId(input.role)) {
    throw new AdminChangeRefused('invalid_input', 'unknown role');
  }
  const reason = normalizeReason(input.reason);
  refuseSelfChange(input.actor.administratorId, input.administratorId);

  const target = await loadTarget(input.administratorId);

  const database = db();
  await database.transaction(async (tx) => {
    await lockLastSuperAdminGuardRows(tx, target.id);
    refuseLastSuperAdmin({
      targetIsSuper: target.roles.includes('super') && input.role !== 'super',
      otherActiveSuperAdmins: await countOtherActiveSuperAdmins(tx, target.id),
    });

    await tx
      .delete(schema.administratorRole)
      .where(eq(schema.administratorRole.administratorId, target.id));
    await tx
      .insert(schema.administratorRole)
      .values({ administratorId: target.id, roleId: input.role });
    /*
     * A narrower role has to take effect now, not at the end of an eight-hour
     * session: the point of the change is that this person should no longer
     * reach those screens.
     */
    await tx
      .update(schema.adminSession)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.adminSession.administratorId, target.id),
          isNull(schema.adminSession.revokedAt),
        ),
      );
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'admin.change_role',
    targetType: 'administrator',
    targetId: target.email,
    reason,
    beforeValue: { roles: target.roles, capabilities: capabilitiesForRoles(target.roles) },
    afterValue: { roles: [input.role], capabilities: capabilitiesForRoles([input.role]) },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });
}

export async function setAdministratorStatus(input: {
  actor: Actor;
  administratorId: string;
  status: Extract<AdminStatus, 'active' | 'disabled'>;
  reason: string;
}): Promise<void> {
  const reason = normalizeReason(input.reason);
  refuseSelfChange(input.actor.administratorId, input.administratorId);

  const target = await loadTarget(input.administratorId);

  /*
   * An invited administrator is outside this control in both directions. They
   * become active by finishing enrolment, not by decree -- and disabling them
   * used to strand the account: status moved off `invited`, which made the
   * invitation unusable, while `email_taken` blocked a fresh one, leaving a row
   * nobody could sign in as and nobody could fix from the console.
   */
  if (target.status === 'invited') {
    throw new AdminChangeRefused('invalid_input', 'an invited administrator must finish enrolment');
  }

  const database = db();
  await database.transaction(async (tx) => {
    if (input.status === 'disabled') {
      await lockLastSuperAdminGuardRows(tx, target.id);
      refuseLastSuperAdmin({
        targetIsSuper: target.roles.includes('super'),
        otherActiveSuperAdmins: await countOtherActiveSuperAdmins(tx, target.id),
      });
    }

    await tx
      .update(schema.administrator)
      .set({ status: input.status, failedAttempts: 0, lockedUntil: null })
      .where(eq(schema.administrator.id, target.id));
    if (input.status === 'disabled') {
      // requirement.md 3.2: disabling takes effect at once, not at expiry.
      await tx
        .update(schema.adminSession)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.adminSession.administratorId, target.id),
            isNull(schema.adminSession.revokedAt),
          ),
        );
    }
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: input.status === 'disabled' ? 'admin.disable' : 'admin.enable',
    targetType: 'administrator',
    targetId: target.email,
    reason,
    beforeValue: { status: target.status },
    afterValue: { status: input.status },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });
}

export async function revokeAdministratorSessions(input: {
  actor: Actor;
  administratorId: string;
  reason: string;
}): Promise<number> {
  const reason = normalizeReason(input.reason);
  const target = await loadTarget(input.administratorId);

  const revoked = await db()
    .update(schema.adminSession)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.adminSession.administratorId, target.id),
        isNull(schema.adminSession.revokedAt),
      ),
    )
    .returning({ id: schema.adminSession.id });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'admin.revoke_sessions',
    targetType: 'administrator',
    targetId: target.email,
    reason,
    afterValue: { revokedSessions: revoked.length },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return revoked.length;
}

export interface MfaResetResult {
  /** Shown once; only its digest is stored. Same shape as an invitation. */
  enrolmentPath: string;
  expiresAt: Date;
  revokedSessions: number;
}

/**
 * Clear an administrator's second factor and send them back through
 * enrolment.
 *
 * A lost authenticator has no self-service recovery on purpose: MFA is
 * mandatory (requirement.md 3.2), so the only way back in is another super
 * administrator vouching for the person, which is what this is. It clears
 * the sealed secret, ends every console session, returns the account to
 * `invited` and mints a fresh single-use enrolment link -- the same path a new
 * administrator takes, so the account cannot become `active` again without
 * proving a working second factor (`completeEnrolment`).
 *
 * Refused on oneself: an administrator who resets their own factor and loses
 * the link is locked out with nobody entitled to let them back in -- the same
 * reasoning as `refuseSelfChange`. Ask a colleague.
 */
export async function resetAdministratorMfa(input: {
  actor: Actor;
  administratorId: string;
  reason: string;
}): Promise<MfaResetResult> {
  const reason = normalizeReason(input.reason);
  refuseSelfChange(input.actor.administratorId, input.administratorId);

  const target = await loadTarget(input.administratorId);
  if (target.status !== 'active') {
    throw new AdminChangeRefused(
      'not_enrolled',
      'only an active, enrolled administrator has a second factor to reset',
    );
  }

  const now = new Date();
  const token = randomToken();
  const expiresAt = inviteExpiryFrom(now);
  let revokedSessions = 0;

  await db().transaction(async (tx) => {
    /*
     * Conditional on the row still being `active`, so two operators resetting
     * the same account cannot both mint a link: the second updates nothing
     * and is told the account is no longer enrolled.
     */
    const reset = await tx
      .update(schema.administrator)
      .set({
        mfaSecret: null,
        mfaEnrolledAt: null,
        mfaLastCounter: null,
        status: 'invited',
        inviteTokenHash: await inviteTokenHash(token),
        inviteExpiresAt: expiresAt,
        invitedBy: input.actor.administratorId,
        failedAttempts: 0,
        lockedUntil: null,
      })
      .where(and(eq(schema.administrator.id, target.id), eq(schema.administrator.status, 'active')))
      .returning({ id: schema.administrator.id });
    if (reset.length === 0) {
      throw new AdminChangeRefused('not_enrolled', 'that administrator is no longer enrolled');
    }

    /* requirement.md 3.2: a cleared factor takes effect now, not at expiry. */
    const revoked = await tx
      .update(schema.adminSession)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.adminSession.administratorId, target.id),
          isNull(schema.adminSession.revokedAt),
        ),
      )
      .returning({ id: schema.adminSession.id });
    revokedSessions = revoked.length;
  });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'admin.reset_mfa',
    targetType: 'administrator',
    targetId: target.email,
    reason,
    beforeValue: { status: target.status, mfaEnrolled: true },
    afterValue: {
      status: 'invited',
      mfaEnrolled: false,
      revokedSessions,
      inviteExpiresAt: expiresAt.toISOString(),
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return { enrolmentPath: `/admin/enroll?token=${token}`, expiresAt, revokedSessions };
}

export interface EnrolmentOffer {
  administratorId: string;
  email: string;
  username: string;
  /** Base32, shown once so it can be typed into an authenticator app. */
  secret: string;
  provisioningUri: string;
  /** Posted back with the form; the only way `completeEnrolment` learns the secret. */
  ticket: string;
}

/**
 * What a live invitation is worth: who it is for, and a TOTP secret to bind.
 *
 * Minted per render (`mintEnrolmentTicket`), so a reload shows a new secret;
 * the form carries its own back as a sealed ticket tied to this invitation.
 */
export async function offerEnrolment(token: string): Promise<EnrolmentOffer> {
  const tokenHash = await inviteTokenHash(token);
  const [row] = await db()
    .select({
      id: schema.administrator.id,
      email: schema.administrator.email,
      username: schema.administrator.username,
      status: schema.administrator.status,
      inviteExpiresAt: schema.administrator.inviteExpiresAt,
    })
    .from(schema.administrator)
    .where(eq(schema.administrator.inviteTokenHash, tokenHash))
    .limit(1);

  if (!row || row.status !== 'invited' || !isInviteLive(row.inviteExpiresAt, new Date())) {
    throw new AdminChangeRefused('invite_invalid', 'invitation is unknown, used or expired');
  }

  const { secret, ticket } = await mintEnrolmentTicket(`invite:${tokenHash}`);
  return {
    administratorId: row.id,
    email: row.email,
    username: row.username,
    secret,
    provisioningUri: totpProvisioningUri({ secret, account: row.email, issuer: 're0' }),
    ticket,
  };
}

/**
 * Completes an invitation: the invitee sets a password and proves they have
 * loaded the TOTP secret by entering a current code.
 *
 * Proving the code before the account goes active is what makes MFA mandatory
 * rather than aspirational -- an account can never reach `active` without a
 * working second factor (requirement.md 3.2).
 */
export async function completeEnrolment(input: {
  token: string;
  /** The sealed ticket `offerEnrolment` printed into the form. */
  ticket: string;
  password: string;
  mfaCode: string;
  clientAddress?: string | null;
}): Promise<void> {
  if (!isAcceptableAdminPassword(input.password)) {
    throw new AdminChangeRefused(
      'weak_password',
      `password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`,
    );
  }

  const now = new Date();
  const database = db();
  const tokenHash = await inviteTokenHash(input.token);
  const [row] = await database
    .select({
      id: schema.administrator.id,
      email: schema.administrator.email,
      status: schema.administrator.status,
      inviteExpiresAt: schema.administrator.inviteExpiresAt,
    })
    .from(schema.administrator)
    .where(eq(schema.administrator.inviteTokenHash, tokenHash))
    .limit(1);

  if (!row || row.status !== 'invited' || !isInviteLive(row.inviteExpiresAt, now)) {
    throw new AdminChangeRefused('invite_invalid', 'invitation is unknown, used or expired');
  }

  // Only the ticket minted for this invitation names a secret; the caller cannot pick one.
  const secret = await secretFromTicket(input.ticket, `invite:${tokenHash}`, now);
  if (secret === null) {
    throw new AdminChangeRefused('invalid_input', 'the enrolment form expired; reload it');
  }
  const counter = await verifyTotpCounter(secret, input.mfaCode, now);
  if (counter === null) {
    throw new AdminChangeRefused('invalid_input', 'that code does not match the secret');
  }

  /*
   * Conditional on the row still being `invited`, so two submissions of the
   * same invitation cannot both write: the second updates nothing and is told
   * the account is already enrolled, rather than silently rebinding a factor
   * the first one already confirmed.
   */
  const claimed = await database
    .update(schema.administrator)
    .set({
      passwordHash: await hashAdminPassword(input.password),
      mfaSecret: await seal(secret),
      mfaEnrolledAt: now,
      mfaLastCounter: counter,
      status: 'active',
      // Single use: the invitation stops being a way in the moment it is spent.
      inviteTokenHash: null,
      inviteExpiresAt: null,
      failedAttempts: 0,
      lockedUntil: null,
    })
    .where(and(eq(schema.administrator.id, row.id), eq(schema.administrator.status, 'invited')))
    .returning({ id: schema.administrator.id });

  if (claimed.length === 0) {
    throw new AdminChangeRefused('already_enrolled', 'that invitation was already completed');
  }

  await recordAudit({
    administratorId: row.id,
    action: 'admin.enrol',
    targetType: 'administrator',
    targetId: row.email,
    afterValue: { status: 'active', mfaEnrolled: true },
    clientAddress: input.clientAddress ?? null,
    result: 'success',
  });
}

/**
 * The first administrator, on an installation that has none.
 *
 * Everywhere else an administrator is granted, not requested (requirement.md
 * 3.2, 5.3) -- but the first one has nobody to grant it, and until they exist
 * the console cannot be opened at all. So the sign-in page becomes a
 * registration page for exactly as long as `administrator` is empty, and
 * closes the moment it is not.
 *
 * "Empty" is decided by the database, not by the page: `bootstrapFirstAdministrator`
 * re-reads it inside the transaction that writes, so a request that skips the
 * page and posts straight at the action is answered the same way.
 */

/** Whether the console has an owner yet. Cheap enough to call on every render. */
export async function hasAnyAdministrator(): Promise<boolean> {
  const [row] = await db()
    .select({ id: schema.administrator.id })
    .from(schema.administrator)
    .limit(1);
  return row !== undefined;
}

export interface BootstrapOffer {
  secret: string;
  provisioningUri: string;
  /** Posted back with the form, as an invitation's is. */
  ticket: string;
}

const BOOTSTRAP_BINDING = 'bootstrap';

/** The second factor to bind, or null once the installation has an administrator. */
export async function offerBootstrap(): Promise<BootstrapOffer | null> {
  if (await hasAnyAdministrator()) return null;
  const { secret, ticket } = await mintEnrolmentTicket(BOOTSTRAP_BINDING);
  return {
    secret,
    provisioningUri: totpProvisioningUri({ secret, account: 'administrator', issuer: 're0' }),
    ticket,
  };
}

export async function bootstrapFirstAdministrator(input: {
  email: string;
  username: string;
  password: string;
  mfaCode: string;
  /** The sealed ticket `offerBootstrap` printed into the form. */
  ticket: string;
  clientAddress?: string | null;
}): Promise<{ administratorId: string }> {
  const email = input.email.trim().toLowerCase();
  const username = input.username.trim();
  if (!email.includes('@') || email.length > 254 || username.length === 0 || username.length > 80) {
    throw new AdminChangeRefused('invalid_input', 'email and username are required');
  }
  if (!isAcceptableAdminPassword(input.password)) {
    throw new AdminChangeRefused(
      'weak_password',
      `password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`,
    );
  }

  const now = new Date();
  const secret = await secretFromTicket(input.ticket, BOOTSTRAP_BINDING, now);
  if (secret === null) {
    throw new AdminChangeRefused('invalid_input', 'the registration form expired; reload it');
  }
  const counter = await verifyTotpCounter(secret, input.mfaCode, now);
  if (counter === null) {
    throw new AdminChangeRefused('invalid_input', 'that code does not match the secret');
  }

  const administratorId = crypto.randomUUID();
  const passwordHash = await hashAdminPassword(input.password);
  const mfaSecret = await seal(secret);

  await db().transaction(async (tx) => {
    /*
     * Two requests arriving together would both read an empty table under READ
     * COMMITTED and both insert, leaving an installation with two owners
     * nobody granted. The lock serializes them; the loser then sees the row the
     * winner wrote and is refused. Transaction scoped, so it ends with the
     * commit either way.
     */
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`);

    /*
     * The emptiness check is the insert's own WHERE, not a separate read: there
     * is no window between deciding and writing for anything to slip into.
     */
    const inserted = await tx.execute(sql`
      insert into administrator
        (id, username, email, password_hash, mfa_secret, mfa_enrolled_at, mfa_last_counter, status)
      select ${administratorId}, ${username}, ${email}, ${passwordHash}, ${mfaSecret}, ${now},
             ${counter}, 'active'
      where not exists (select 1 from administrator)
      returning id
    `);
    if (inserted.rows.length === 0) {
      throw new AdminChangeRefused(
        'bootstrap_closed',
        'this installation already has an administrator',
      );
    }

    await tx.insert(schema.administratorRole).values({ administratorId, roleId: 'super' });
  });

  /*
   * Audited as itself rather than as an invitation: the operator and the target
   * are the same account, and the entry is the only record of how the console
   * acquired its first owner (requirement.md 5.3).
   */
  await recordAudit({
    administratorId,
    action: 'admin.bootstrap',
    targetType: 'administrator',
    targetId: email,
    afterValue: { username, role: 'super', status: 'active', mfaEnrolled: true },
    clientAddress: input.clientAddress ?? null,
    result: 'success',
  });

  return { administratorId };
}

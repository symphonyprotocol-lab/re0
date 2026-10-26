/**
 * Managing administrators against a real database: invite, enrol, change role,
 * disable, revoke sessions -- and the guards that stop an operator locking the
 * console shut (requirement.md 3.1, 5.3).
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const {
  listAdministrators,
  inviteAdministrator,
  changeAdministratorRole,
  setAdministratorStatus,
  revokeAdministratorSessions,
  offerEnrolment,
  completeEnrolment,
} = await import('@/lib/application/administration/manage-administrators');
const { resolveAdminSession } = await import(
  '@/lib/application/administration/resolve-admin-session'
);
const { signInAdmin } = await import('@/lib/application/administration/sign-in-admin');
const { hashAdminPassword } = await import('@/lib/application/administration/password');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { seal } = await import('@/lib/infrastructure/crypto/sealed');
const { randomTotpSecret, base32Decode } = await import('@/lib/domain/totp');

const stamp = Date.now();
const actorId = crypto.randomUUID();
const actorEmail = `actor-${stamp}@example.test`;
const inviteeEmail = `invitee-${stamp}@example.test`;
const actor = { administratorId: actorId, email: actorEmail };
const createdEmails = [actorEmail, inviteeEmail];

/** Carried between cases: the invitation is shown once and never stored. */
let inviteToken = '';

async function codeFor(secret: string, now = new Date()): Promise<string> {
  const counter = Math.floor(now.getTime() / 1000 / 30);
  const message = new Uint8Array(8);
  let low = counter >>> 0;
  let high = Math.floor(counter / 2 ** 32);
  for (let i = 3; i >= 0; i -= 1) {
    message[i] = high & 0xff;
    high >>>= 8;
    message[i + 4] = low & 0xff;
    low >>>= 8;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secret)!,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 1_000_000).toString().padStart(6, '0');
}

async function idFor(email: string): Promise<string> {
  const [row] = await db()
    .select({ id: schema.administrator.id })
    .from(schema.administrator)
    .where(eq(schema.administrator.email, email));
  return row!.id;
}

describeWithDb('managing administrators', () => {
  afterAll(async () => {
    const database = db();
    const rows = await database
      .select({ id: schema.administrator.id })
      .from(schema.administrator)
      .where(inArray(schema.administrator.email, createdEmails));
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return;
    await database.delete(schema.auditLog).where(inArray(schema.auditLog.administratorId, ids));
    await database
      .delete(schema.adminSession)
      .where(inArray(schema.adminSession.administratorId, ids));
    await database
      .delete(schema.administratorRole)
      .where(inArray(schema.administratorRole.administratorId, ids));
    await database.delete(schema.administrator).where(inArray(schema.administrator.id, ids));
  });

  it('seeds an active super administrator to act as', async () => {
    await db().insert(schema.administrator).values({
      id: actorId,
      username: 'Acting Super',
      email: actorEmail,
      passwordHash: await hashAdminPassword('a password long enough'),
      mfaSecret: await seal(randomTotpSecret()),
      mfaEnrolledAt: new Date(),
      status: 'active',
    });
    await db()
      .insert(schema.administratorRole)
      .values({ administratorId: actorId, roleId: 'super' });

    const listed = await listAdministrators(actorEmail);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.roles).toEqual(['super']);
    expect(listed[0]?.status).toBe('active');
  });

  it('invites an administrator who cannot yet sign in', async () => {
    const { enrolmentPath } = await inviteAdministrator({
      actor,
      email: inviteeEmail,
      username: 'Invited Reviewer',
      role: 'reviewer',
    });
    expect(enrolmentPath).toMatch(/^\/admin\/enroll\?token=/);
    inviteToken = new URL(`http://x${enrolmentPath}`).searchParams.get('token') ?? '';

    const [row] = await db()
      .select({
        status: schema.administrator.status,
        passwordHash: schema.administrator.passwordHash,
        inviteTokenHash: schema.administrator.inviteTokenHash,
      })
      .from(schema.administrator)
      .where(eq(schema.administrator.email, inviteeEmail));

    expect(row?.status).toBe('invited');
    // No credential exists yet, and the token is stored only as a digest.
    expect(row?.passwordHash).toBeNull();
    expect(enrolmentPath).not.toContain(row!.inviteTokenHash!);

    await expect(
      signInAdmin({ email: inviteeEmail, password: 'anything at all', mfaCode: '000000' }),
    ).rejects.toMatchObject({ loginError: 'invalid_credentials' });
  });

  it('mints the enrolment secret per render, bound to the invitation', async () => {
    // Nothing derivable from the signing key: two renders disagree, and the
    // QR carries the secret this render's ticket will bind.
    const first = await offerEnrolment(inviteToken);
    const second = await offerEnrolment(inviteToken);
    expect(first.secret).not.toBe(second.secret);
    expect(first.secret.length).toBeGreaterThanOrEqual(32);
    expect(first.provisioningUri).toContain(`secret=${first.secret}`);
    expect(first.ticket).not.toContain(first.secret);
  });

  it('refuses a second invitation to the same address', async () => {
    await expect(
      inviteAdministrator({ actor, email: inviteeEmail, username: 'Dup', role: 'support' }),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('enrols the invitee, and only with a code that matches the secret', async () => {
    const offer = await offerEnrolment(inviteToken);
    expect(offer.email).toBe(inviteeEmail);

    await expect(
      completeEnrolment({
        token: inviteToken,
        ticket: offer.ticket,
        password: 'short',
        mfaCode: '000000',
      }),
    ).rejects.toMatchObject({ code: 'weak_password' });

    await expect(
      completeEnrolment({
        token: inviteToken,
        ticket: offer.ticket,
        password: 'a password long enough',
        mfaCode: '000000',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    // The right code is not enough without the ticket that names its secret.
    await expect(
      completeEnrolment({
        token: inviteToken,
        ticket: 'forged',
        password: 'a password long enough',
        mfaCode: await codeFor(offer.secret),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    await completeEnrolment({
      token: inviteToken,
      ticket: offer.ticket,
      password: 'a password long enough',
      mfaCode: await codeFor(offer.secret),
    });

    // Active, with a second factor, and the invitation is spent.
    const listed = await listAdministrators(inviteeEmail);
    expect(listed[0]?.status).toBe('active');
    expect(listed[0]?.mfaEnrolled).toBe(true);
    await expect(offerEnrolment(inviteToken)).rejects.toMatchObject({ code: 'invite_invalid' });
  });

  it('lets the enrolled administrator sign in, scoped to their role', async () => {
    const [row] = await db()
      .select({ mfaSecret: schema.administrator.mfaSecret })
      .from(schema.administrator)
      .where(eq(schema.administrator.email, inviteeEmail));
    const { unseal } = await import('@/lib/infrastructure/crypto/sealed');
    const secret = (await unseal<string>(row!.mfaSecret))!;

    // The enrolment already spent this step, so wait for the next one.
    const next = new Date(Date.now() + 30_000);
    const { token } = await signInAdmin({
      email: inviteeEmail,
      password: 'a password long enough',
      mfaCode: await codeFor(secret, next),
    });
    const session = await resolveAdminSession(token);
    expect(session?.capabilities).toEqual(['libraries', 'expertLibraries']);
  });

  it('changing the role revokes the sessions it widened or narrowed', async () => {
    const inviteeId = await idFor(inviteeEmail);
    expect((await listAdministrators(inviteeEmail))[0]?.activeSessions).toBe(1);

    await changeAdministratorRole({
      actor,
      administratorId: inviteeId,
      role: 'support',
      reason: 'moved to the support rota',
    });

    const listed = await listAdministrators(inviteeEmail);
    expect(listed[0]?.roles).toEqual(['support']);
    expect(listed[0]?.activeSessions).toBe(0);
  });

  it('refuses any change that does not say why', async () => {
    const inviteeId = await idFor(inviteeEmail);
    for (const call of [
      () => changeAdministratorRole({ actor, administratorId: inviteeId, role: 'support', reason: '   ' }),
      () => setAdministratorStatus({ actor, administratorId: inviteeId, status: 'disabled', reason: '' }),
      () => revokeAdministratorSessions({ actor, administratorId: inviteeId, reason: '' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'reason_required' });
    }
  });

  it('refuses to enable or disable an administrator who has not enrolled', async () => {
    const pendingEmail = `pending-${stamp}@example.test`;
    createdEmails.push(pendingEmail);
    const invite = await inviteAdministrator({
      actor,
      email: pendingEmail,
      username: 'Still Pending',
      role: 'support',
    });
    const pendingId = invite.administratorId;

    /*
     * Disabling used to be allowed here, which stranded the account: status
     * moved off `invited`, so the invitation stopped working, while the address
     * was taken, so a fresh one was refused.
     */
    await expect(
      setAdministratorStatus({
        actor,
        administratorId: pendingId,
        status: 'disabled',
        reason: 'not joining after all',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });

    // The invitation still works, which is the point of refusing.
    const token = new URL(`http://x${invite.enrolmentPath}`).searchParams.get('token')!;
    await expect(offerEnrolment(token)).resolves.toMatchObject({ email: pendingEmail });
  });

  it('treats % and _ in a search as characters, not wildcards', async () => {
    expect(await listAdministrators('%')).toHaveLength(0);
    expect(await listAdministrators('_')).toHaveLength(0);
    // A real substring still matches.
    expect((await listAdministrators(inviteeEmail.slice(0, 12))).length).toBeGreaterThan(0);
  });

  it('refuses to let an administrator change their own role or status', async () => {
    await expect(
      changeAdministratorRole({ actor, administratorId: actorId, role: 'support', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'self_change' });
    await expect(
      setAdministratorStatus({ actor, administratorId: actorId, status: 'disabled', reason: 'x' }),
    ).rejects.toMatchObject({ code: 'self_change' });
  });

  /*
   * The refusal half of this guard is pinned in tests/security/admin-auth: it
   * is a pure function, and a shared dev database usually has a real super
   * administrator in it, so "the actor is the last one" is not a state a test
   * can create without touching an account it does not own. What is asserted
   * here is the other half -- that the use case really counts the database, and
   * so does not refuse when another active super administrator exists.
   */
  it('allows demoting a super administrator while another active one remains', async () => {
    const secondSuper = crypto.randomUUID();
    const secondEmail = `second-super-${stamp}@example.test`;
    createdEmails.push(secondEmail);
    await db().insert(schema.administrator).values({
      id: secondSuper,
      username: 'Second Super',
      email: secondEmail,
      passwordHash: await hashAdminPassword('a password long enough'),
      mfaEnrolledAt: new Date(),
      status: 'active',
    });
    await db()
      .insert(schema.administratorRole)
      .values({ administratorId: secondSuper, roleId: 'super' });

    await changeAdministratorRole({
      actor,
      administratorId: secondSuper,
      role: 'reviewer',
      reason: 'stepping back from platform admin',
    });

    const listed = await listAdministrators(secondEmail);
    expect(listed[0]?.roles).toEqual(['reviewer']);
  });

  it('disabling ends every session at once', async () => {
    const inviteeId = await idFor(inviteeEmail);
    await db().insert(schema.adminSession).values({
      id: crypto.randomUUID(),
      administratorId: inviteeId,
      tokenHash: `test-hash-${stamp}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect((await listAdministrators(inviteeEmail))[0]?.activeSessions).toBe(1);

    await setAdministratorStatus({
      actor,
      administratorId: inviteeId,
      status: 'disabled',
      reason: 'left the team',
    });

    const listed = await listAdministrators(inviteeEmail);
    expect(listed[0]?.status).toBe('disabled');
    expect(listed[0]?.activeSessions).toBe(0);
  });

  it('records every change in the audit log with before and after values', async () => {
    const rows = await db()
      .select({
        action: schema.auditLog.action,
        targetId: schema.auditLog.targetId,
        reason: schema.auditLog.reason,
        beforeValue: schema.auditLog.beforeValue,
        afterValue: schema.auditLog.afterValue,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.administratorId, actorId));

    const actions = rows.map((row) => row.action);
    expect(actions).toContain('admin.invite');
    expect(actions).toContain('admin.change_role');
    expect(actions).toContain('admin.disable');

    /*
     * Matched on the target as well as the action: this actor demotes the
     * second super administrator further down, so `admin.change_role` alone
     * selects two rows and an unordered read picks either of them.
     */
    const roleChange = rows.find(
      (row) => row.action === 'admin.change_role' && row.targetId === inviteeEmail,
    );
    expect(roleChange?.reason).toBe('moved to the support rota');
    expect(roleChange?.beforeValue).toMatchObject({ roles: ['reviewer'] });
    expect(roleChange?.afterValue).toMatchObject({ roles: ['support'] });
  });

  it('revokes sessions on request without touching the account', async () => {
    const inviteeId = await idFor(inviteeEmail);
    await db().insert(schema.adminSession).values({
      id: crypto.randomUUID(),
      administratorId: inviteeId,
      tokenHash: `test-hash-2-${stamp}`,
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const revoked = await revokeAdministratorSessions({
      actor,
      administratorId: inviteeId,
      reason: 'laptop lost',
    });
    expect(revoked).toBe(1);

    const listed = await listAdministrators(inviteeEmail);
    expect(listed[0]?.activeSessions).toBe(0);
    expect(listed[0]?.status).toBe('disabled');
  });
});

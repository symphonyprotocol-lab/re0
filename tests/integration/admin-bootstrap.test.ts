/**
 * Registering the first administrator against a real database.
 *
 * The rule this file exists for is the one the page cannot enforce: the offer
 * is open exactly while `administrator` is empty, and the *use case* decides
 * that, so a caller who skips the page and posts straight at the action is
 * refused the same way (requirement.md 3.2, 5.3).
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database -- these
 * tests write rows, and this one starts by emptying the administrator tables.
 *
 *   TEST_DATABASE_URL='postgres://...' npx vitest run tests/integration
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, isNotNull } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { offerBootstrap, bootstrapFirstAdministrator, hasAnyAdministrator } = await import(
  '@/lib/application/administration/manage-administrators'
);
const { signInAdmin } = await import('@/lib/application/administration/sign-in-admin');
const { resolveAdminSession } = await import(
  '@/lib/application/administration/resolve-admin-session'
);
const { AdminChangeRefused } = await import('@/lib/domain/admin');
const { base32Decode } = await import('@/lib/domain/totp');
const { seal, unseal } = await import('@/lib/infrastructure/crypto/sealed');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');

const PASSWORD = 'a password long enough to pass';
const EMAIL = `founder-${Date.now()}@example.test`;

/** The secret the first offer handed out, and its ticket; kept so a later case can still pass MFA. */
let offeredSecret = '';
let offeredTicket = '';

/** The code an authenticator loaded with `secret` would be showing now. */
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

async function emptyTheConsole(): Promise<void> {
  const database = db();
  await database.delete(schema.auditLog).where(isNotNull(schema.auditLog.administratorId));
  await database.delete(schema.adminSession);
  await database.delete(schema.administratorRole);
  await database.delete(schema.administrator);
}

describeWithDb('first administrator', () => {
  beforeAll(emptyTheConsole);
  afterAll(emptyTheConsole);

  it('offers a second factor while there is nobody to sign in as', async () => {
    expect(await hasAnyAdministrator()).toBe(false);
    const offer = await offerBootstrap();
    expect(offer?.secret).toMatch(/^[A-Z2-7]+$/);
    expect(offer?.provisioningUri).toContain('otpauth://totp/');
    expect(offer?.ticket).toBeTruthy();
    offeredSecret = offer!.secret;
    offeredTicket = offer!.ticket;
  });

  it('mints a new secret per render rather than deriving one from the signing key', async () => {
    /*
     * A derived seed was the same for every installation sharing
     * SESSION_SIGNING_SECRET, so an empty dev console printed production's.
     * Two renders must now disagree, and the ticket must not show the secret.
     */
    const first = await offerBootstrap();
    const second = await offerBootstrap();
    expect(first!.secret).not.toBe(second!.secret);
    expect(first!.ticket).not.toContain(first!.secret);
  });

  it('refuses a secret the server did not mint for this form', async () => {
    const offer = await offerBootstrap();
    const code = await codeFor(offer!.secret);
    const attempt = (ticket: string) =>
      bootstrapFirstAdministrator({
        email: EMAIL,
        username: 'Founder',
        password: PASSWORD,
        mfaCode: code,
        ticket,
      }).catch((reason: unknown) => reason);

    const forged = await attempt('not-a-ticket');
    const otherPurpose = await attempt(
      await seal({
        purpose: 'admin-totp',
        binding: 'invite:someone-else',
        secret: offer!.secret,
        expiresAt: Date.now() + 60_000,
      }),
    );
    const expired = await attempt(
      await seal({
        purpose: 'admin-totp',
        binding: 'bootstrap',
        secret: offer!.secret,
        expiresAt: Date.now() - 1,
      }),
    );

    for (const error of [forged, otherPurpose, expired]) {
      expect(error).toBeInstanceOf(AdminChangeRefused);
      expect((error as InstanceType<typeof AdminChangeRefused>).code).toBe('invalid_input');
    }
    expect(await hasAnyAdministrator()).toBe(false);
  });

  it('refuses a weak password without writing anything', async () => {
    const error = await bootstrapFirstAdministrator({
      email: EMAIL,
      username: 'Founder',
      password: 'short',
      mfaCode: '000000',
      ticket: offeredTicket,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AdminChangeRefused);
    expect((error as InstanceType<typeof AdminChangeRefused>).code).toBe('weak_password');
    expect(await hasAnyAdministrator()).toBe(false);
  });

  it('refuses a code that does not match the offered secret', async () => {
    const offer = await offerBootstrap();
    const right = await codeFor(offer!.secret);
    const wrong = right === '000000' ? '111111' : '000000';

    const error = await bootstrapFirstAdministrator({
      email: EMAIL,
      username: 'Founder',
      password: PASSWORD,
      mfaCode: wrong,
      ticket: offer!.ticket,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AdminChangeRefused);
    expect((error as InstanceType<typeof AdminChangeRefused>).code).toBe('invalid_input');
    expect(await hasAnyAdministrator()).toBe(false);
  });

  it('creates an active super administrator with the factor already bound', async () => {
    const offer = await offerBootstrap();
    const { administratorId } = await bootstrapFirstAdministrator({
      email: EMAIL.toUpperCase(),
      username: '  Founder  ',
      password: PASSWORD,
      mfaCode: await codeFor(offer!.secret),
      ticket: offer!.ticket,
    });

    const [row] = await db()
      .select()
      .from(schema.administrator)
      .where(eq(schema.administrator.id, administratorId));

    // Normalized on the way in, the same way an invitation normalizes them.
    expect(row?.email).toBe(EMAIL);
    expect(row?.username).toBe('Founder');
    expect(row?.status).toBe('active');
    expect(row?.passwordHash).toBeTruthy();
    expect(row?.mfaEnrolledAt).toBeTruthy();
    // Sealed, not stored in the clear, and it is the secret that was offered.
    expect(await unseal<string>(row?.mfaSecret)).toBe(offer!.secret);
    // No invitation was involved, so nothing is left that could be redeemed.
    expect(row?.inviteTokenHash).toBeNull();

    const roles = await db()
      .select({ roleId: schema.administratorRole.roleId })
      .from(schema.administratorRole)
      .where(eq(schema.administratorRole.administratorId, administratorId));
    expect(roles.map((role) => role.roleId)).toEqual(['super']);
  });

  it('closes the offer once the installation has an administrator', async () => {
    expect(await hasAnyAdministrator()).toBe(true);
    expect(await offerBootstrap()).toBeNull();
  });

  it('refuses a second registration even when it skips the page', async () => {
    /*
     * The point of the case: `offerBootstrap` returning null is what hides the
     * form, but it is not the guard. This call is what a request straight at
     * the server action looks like -- valid input, a code that does verify,
     * and nothing left to stop it but the write's own emptiness check.
     */
    const error = await bootstrapFirstAdministrator({
      email: `second-${Date.now()}@example.test`,
      username: 'Second',
      password: PASSWORD,
      mfaCode: await codeFor(offeredSecret),
      ticket: offeredTicket,
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AdminChangeRefused);
    expect((error as InstanceType<typeof AdminChangeRefused>).code).toBe('bootstrap_closed');

    const rows = await db().select({ id: schema.administrator.id }).from(schema.administrator);
    expect(rows).toHaveLength(1);
  });

  it('signs in with what the registration set, and lands in the audit chain', async () => {
    const [before] = await db().select().from(schema.administrator);
    /*
     * The registration spent its own TOTP step (that is the replay guard doing
     * its job), so a sign-in in the same 30 seconds would be refused as a
     * replay. Clearing the counter is how the sign-in tests do the same.
     */
    await db()
      .update(schema.administrator)
      .set({ mfaLastCounter: null })
      .where(eq(schema.administrator.id, before!.id));

    const secret = await unseal<string>(before!.mfaSecret);
    const { token } = await signInAdmin({
      email: EMAIL,
      password: PASSWORD,
      mfaCode: await codeFor(secret!),
    });

    const session = await resolveAdminSession(token);
    expect(session?.administratorId).toBe(before!.id);
    expect(session?.roles).toEqual(['super']);

    const audit = await db()
      .select({ action: schema.auditLog.action, result: schema.auditLog.result })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.administratorId, before!.id));
    expect(audit.some((row) => row.action === 'admin.bootstrap' && row.result === 'success')).toBe(
      true,
    );
  });
});

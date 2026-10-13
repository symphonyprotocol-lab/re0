/**
 * Creates or updates one administrator, and enrols their second factor.
 *
 * An administrator is granted, not requested (requirement.md 3.2, 5.3), and
 * this script is that grant, run by someone who already holds the database
 * credentials. The one self-service path is the first administrator of an
 * empty installation, which `/admin/login` offers until it succeeds; this
 * script is the way to do the same thing without exposing that page, and the
 * only way to add an administrator the console itself cannot reach.
 *
 *   npm run admin:create -- --email admin@re0.io --username Yuzhao --role super
 *
 * The password is read from the ADMIN_PASSWORD environment variable rather than
 * an argument, so it never lands in a shell history file. The TOTP secret is
 * generated here, printed once, and stored sealed -- there is no way to read it
 * back afterwards.
 *
 * `.mts` because the package is CommonJS by default and this needs top-level
 * await: the env has to be loaded before anything reads DATABASE_URL.
 */
import nextEnv from '@next/env';
import { eq } from 'drizzle-orm';

// `@next/env` is CommonJS, so it arrives as a default export under ESM.
nextEnv.loadEnvConfig(process.cwd());

const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { hashAdminPassword } = await import('@/lib/application/administration/password');
const { seal } = await import('@/lib/infrastructure/crypto/sealed');
const { randomTotpSecret, totpProvisioningUri } = await import('@/lib/domain/totp');
const { isAdminRoleId, ADMIN_ROLE_IDS } = await import('@/lib/domain/admin');

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

const email = argument('email')?.trim().toLowerCase();
const username = argument('username')?.trim();
const role = argument('role')?.trim() ?? 'super';
const password = process.env.ADMIN_PASSWORD;

if (!email || !email.includes('@')) fail('--email is required, e.g. --email admin@re0.io');
if (!username) fail('--username is required, e.g. --username Yuzhao');
if (!isAdminRoleId(role)) fail(`--role must be one of: ${ADMIN_ROLE_IDS.join(', ')}`);
if (!password || password.length < 12) {
  fail('set ADMIN_PASSWORD to at least 12 characters, e.g. ADMIN_PASSWORD=… npm run admin:create -- …');
}

const database = db();
const now = new Date();
const secret = randomTotpSecret();

const [existing] = await database
  .select({ id: schema.administrator.id, status: schema.administrator.status })
  .from(schema.administrator)
  .where(eq(schema.administrator.email, email))
  .limit(1);

/*
 * A disabled account is not re-opened here.
 *
 * Disabling is an audited console decision (`admin.disable`), and this script
 * writes no audit row -- so re-running it for a disabled address used to flip
 * the account back to `active`, clear its lockout and reset its roles to
 * `--role`, with the audit chain still showing only the disable. Whoever runs
 * this holds the database credentials and could of course write the row by
 * hand; the point is that the reversal should not happen as a side effect of
 * resetting someone's password. Re-enabling belongs in the console, where it
 * is recorded.
 */
if (existing && existing.status === 'disabled') {
  fail(
    `${email} is disabled. Re-enable it in the console (/admin/administrators), where the change is audited, then re-run this to reset the credentials.`,
  );
}

const administratorId = existing?.id ?? crypto.randomUUID();

const values = {
  username,
  email,
  passwordHash: await hashAdminPassword(password),
  mfaSecret: await seal(secret),
  mfaEnrolledAt: now,
  /* An invited account completes enrolment here; an active one stays active. */
  status: 'active',
  failedAttempts: 0,
  lockedUntil: null,
};

/*
 * One transaction for the account and its role. A crash between the two would
 * otherwise leave new credentials with the previous -- possibly wider -- roles,
 * and the TOTP secret (printed only after this) already lost.
 *
 * `--role` sets the role, it does not add one. Inserting without clearing would
 * mean re-running this to downgrade an account silently left the old, wider
 * role in place -- and `capabilitiesForRoles` unions them, so the downgrade
 * would be a no-op while the output claimed otherwise.
 */
await database.transaction(async (tx) => {
  if (existing) {
    await tx
      .update(schema.administrator)
      .set(values)
      .where(eq(schema.administrator.id, administratorId));
  } else {
    await tx.insert(schema.administrator).values({ id: administratorId, ...values });
  }
  await tx
    .delete(schema.administratorRole)
    .where(eq(schema.administratorRole.administratorId, administratorId));
  await tx.insert(schema.administratorRole).values({ administratorId, roleId: role });
});

const uri = totpProvisioningUri({ secret, account: email, issuer: 're0' });

console.log(`
  ${existing ? 'Updated' : 'Created'} administrator

    email     ${email}
    username  ${username}
    role      ${role}

  Two-factor secret -- shown once, stored sealed, not recoverable:

    ${secret}

  Add it to an authenticator app, either by typing the secret or from:

    ${uri}

  Then sign in at /admin/login. Both the attempt and its result are audited.
`);

process.exit(0);

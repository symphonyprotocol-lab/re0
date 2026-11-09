/**
 * The console's own authority (rebuild-proposal.md 2.5), ported from the old
 * administration module: Argon2id passwords, TOTP with replay protection and
 * lockout, sessions keyed by a digest, and an audit row for every write.
 *
 * An empty installation bootstraps itself: the first visitor of
 * `/admin/login` registers the owner. The insert is guarded by an advisory
 * lock and `where not exists`, so a second registration -- even a direct POST
 * racing the first -- is refused.
 */
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { ADMIN_LOCKOUT_MS, ADMIN_MAX_FAILED_ATTEMPTS, ADMIN_PASSWORD_MIN, ADMIN_SESSION_LIFETIME_MS } from '@/lib/constants';
import type { AuditAction } from '@/lib/domain/audit';
import { randomTotpSecret, verifyTotpCounter } from '@/lib/domain/totp';
import { openCredential, sealCredential } from '@/lib/infra/crypto/credentials';
import { authSecret } from '@/lib/infra/crypto/secrets';
import { seal, unseal } from '@/lib/infra/crypto/sealed';
import { hmacSha256, randomToken } from '@/lib/infra/crypto/tokens';
import { db, schema, type Executor } from '@/lib/infra/db';
import { argon2id, argon2Verify } from 'hash-wasm';

export type Administrator = typeof schema.administrator.$inferSelect;

/* ---------------------------------------------------------------- password */

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return argon2id({ password, salt, parallelism: 1, iterations: 2, memorySize: 19 * 1024, hashLength: 32, outputType: 'encoded' });
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}

/** Spent on unknown emails so a miss costs what a hit costs. */
let decoy: Promise<string> | undefined;
function decoyHash(): Promise<string> {
  decoy ??= hashPassword(`decoy:${crypto.randomUUID()}`);
  return decoy;
}

/* ------------------------------------------------------------------- audit */

export async function audit(
  executor: Executor,
  entry: { administratorId: string | null; action: AuditAction; target?: string | null; before?: unknown; after?: unknown },
): Promise<void> {
  await executor.insert(schema.adminAudit).values({
    administratorId: entry.administratorId,
    action: entry.action,
    target: entry.target ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

/* --------------------------------------------------------------- bootstrap */

export async function hasAdministrator(): Promise<boolean> {
  const [row] = await db().select({ id: schema.administrator.id }).from(schema.administrator).limit(1);
  return Boolean(row);
}

/** The secret shown on the first-run form, sealed so the browser cannot choose its own. */
export async function bootstrapChallenge(): Promise<{ secret: string; sealed: string }> {
  const secret = randomTotpSecret();
  return { secret, sealed: await seal({ secret, issuedAt: Date.now() }) };
}

/**
 * Who may register the first administrator, or null for anyone.
 *
 * An empty installation lets its first visitor become the owner. A database
 * cut over from the old app (scripts/database-cutover.mts) goes live with an
 * empty administrator table straight from the production build, so there the
 * old console's archived accounts decide: its active super administrators, or
 * every active administrator when it had no super one. Each comes with its
 * old Argon2id hash -- the same encoding this module writes -- because an
 * email alone is guessable: whoever registers must also know that account's
 * old password. A fresh install (no archive, or nobody active in it) stays open.
 */
export async function bootstrapAllowlist(executor: Executor = db()): Promise<{ email: string; passwordHash: string }[] | null> {
  const archive = await executor.execute<{ administrators: boolean; roles: boolean }>(sql`
    select to_regclass('legacy_main.administrator') is not null as administrators,
           to_regclass('legacy_main.administrator_role') is not null as roles`);
  if (!archive.rows[0]?.administrators) return null;
  const rows = await executor.execute<{ email: string; password_hash: string; super: boolean }>(
    archive.rows[0].roles
      ? sql`select lower(btrim(a.email)) as email, a.password_hash,
                   exists (select 1 from legacy_main.administrator_role r where r.administrator_id = a.id and r.role_id = 'super') as super
            from legacy_main.administrator a where a.status = 'active' and a.password_hash is not null`
      : sql`select lower(btrim(a.email)) as email, a.password_hash, false as super
            from legacy_main.administrator a where a.status = 'active' and a.password_hash is not null`,
  );
  const active = rows.rows;
  if (!active.length) return null;
  const supers = active.filter((row) => row.super);
  return (supers.length ? supers : active).map((row) => ({ email: row.email, passwordHash: row.password_hash }));
}

export class AdminInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AdminInputError';
  }
}

export async function bootstrapFirstAdministrator(input: {
  name: string;
  email: string;
  password: string;
  sealedSecret: string;
  code: string;
}): Promise<Administrator> {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  if (!name || name.length > 40) throw new AdminInputError('name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new AdminInputError('email');
  if (input.password.length < ADMIN_PASSWORD_MIN || input.password.length > 256) throw new AdminInputError('password');
  const challenge = await unseal<{ secret: string; issuedAt: number }>(input.sealedSecret);
  if (!challenge || Date.now() - challenge.issuedAt > 60 * 60 * 1000) throw new AdminInputError('totp');
  const counter = await verifyTotpCounter(challenge.secret, input.code);
  if (counter === null) throw new AdminInputError('totp');
  const passwordHash = await hashPassword(input.password);
  const totpSecretCipher = await sealCredential(challenge.secret, 'totp');

  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('re0:admin-bootstrap'))`);
    const allowed = await bootstrapAllowlist(tx);
    if (allowed) {
      /* One answer for a wrong email and a wrong password, and a hash checked either way. */
      const entry = allowed.find((candidate) => candidate.email === email);
      const proven = await verifyPassword(input.password, entry?.passwordHash ?? (await decoyHash()));
      if (!entry || !proven) throw new AdminInputError('bootstrap_email');
    }
    const [created] = await tx
      .insert(schema.administrator)
      .select(
        tx
          .select({
            id: sql`gen_random_uuid()`.as('id'),
            name: sql`${name}`.as('name'),
            email: sql`${email}`.as('email'),
            role: sql`'owner'`.as('role'),
            passwordHash: sql`${passwordHash}`.as('password_hash'),
            totpSecretCipher: sql`${totpSecretCipher}`.as('totp_secret_cipher'),
            totpLastCounter: sql`${counter}::bigint`.as('totp_last_counter'),
            failedAttempts: sql`0`.as('failed_attempts'),
            lockedUntil: sql`null::timestamptz`.as('locked_until'),
            disabledAt: sql`null::timestamptz`.as('disabled_at'),
            createdBy: sql`null::uuid`.as('created_by'),
            createdAt: sql`now()`.as('created_at'),
          })
          .from(sql`(select 1) as seed`)
          .where(sql`not exists (select 1 from ${schema.administrator})`),
      )
      .returning();
    if (!created) throw new AdminInputError('bootstrap_closed');
    await audit(tx, { administratorId: created.id, action: 'admin.bootstrap', target: email, after: { name, email, role: 'owner' } });
    return created;
  });
}

/* ----------------------------------------------------------------- session */

export function adminSessionHash(token: string): Promise<string> {
  return hmacSha256(authSecret(), `admin-session:${token}`);
}

export async function openAdminSession(administratorId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_LIFETIME_MS);
  await db().insert(schema.adminSession).values({ id: await adminSessionHash(token), administratorId, expiresAt });
  return { token, expiresAt };
}

export async function resolveAdminSession(token: string | undefined | null, now = new Date()): Promise<Administrator | null> {
  if (!token) return null;
  const [row] = await db()
    .select({ administrator: schema.administrator })
    .from(schema.adminSession)
    .innerJoin(schema.administrator, eq(schema.administrator.id, schema.adminSession.administratorId))
    .where(and(eq(schema.adminSession.id, await adminSessionHash(token)), gt(schema.adminSession.expiresAt, now)))
    .limit(1);
  if (!row || row.administrator.disabledAt) return null;
  return row.administrator;
}

export async function closeAdminSession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await db().delete(schema.adminSession).where(eq(schema.adminSession.id, await adminSessionHash(token)));
}

/**
 * Password and TOTP together; every failure reads the same to the caller. A
 * TOTP step is spent on use, five failures lock the account for 15 minutes.
 */
export async function signInAdministrator(input: { email: string; password: string; code: string }, now = new Date()) {
  const database = db();
  const email = input.email.trim().toLowerCase();
  const [account] = await database.select().from(schema.administrator).where(eq(schema.administrator.email, email)).limit(1);
  if (!account) {
    await verifyPassword(input.password, await decoyHash());
    throw new AdminInputError('invalid_credentials');
  }
  if (account.disabledAt || (account.lockedUntil && account.lockedUntil.getTime() > now.getTime())) {
    await verifyPassword(input.password, await decoyHash());
    throw new AdminInputError('invalid_credentials');
  }
  const passwordOk = await verifyPassword(input.password, account.passwordHash);
  const secret = await openCredential(account.totpSecretCipher, 'totp');
  const counter = secret ? await verifyTotpCounter(secret, input.code, now, { minCounter: account.totpLastCounter }) : null;
  if (!passwordOk || counter === null) {
    await database
      .update(schema.administrator)
      .set({
        failedAttempts: sql`${schema.administrator.failedAttempts} + 1`,
        lockedUntil: sql`case when ${schema.administrator.failedAttempts} + 1 >= ${ADMIN_MAX_FAILED_ATTEMPTS}
          then now() + (${ADMIN_LOCKOUT_MS} || ' milliseconds')::interval else ${schema.administrator.lockedUntil} end`,
      })
      .where(eq(schema.administrator.id, account.id));
    throw new AdminInputError('invalid_credentials');
  }
  /* Spend the step atomically: a second sign-in with the same code loses this race. */
  const [burned] = await database
    .update(schema.administrator)
    .set({ failedAttempts: 0, lockedUntil: null, totpLastCounter: counter })
    .where(
      and(
        eq(schema.administrator.id, account.id),
        or(isNull(schema.administrator.totpLastCounter), lt(schema.administrator.totpLastCounter, counter)),
      ),
    )
    .returning({ id: schema.administrator.id });
  if (!burned) throw new AdminInputError('invalid_credentials');
  const session = await openAdminSession(account.id, now);
  await audit(database, { administratorId: account.id, action: 'admin.login', target: account.email });
  return session;
}

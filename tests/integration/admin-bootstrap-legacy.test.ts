/**
 * After the production cutover the administrator table is empty and the site
 * is live, so the first-visitor bootstrap must not be open to anyone: only
 * the old console's archived super administrators (legacy_main) may claim it,
 * and only with their old password.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const admin = await import('@/lib/services/admin');
const { totpCounter } = await import('@/lib/domain/totp');
const { db, schema } = await import('@/lib/infra/db');
const { sql } = await import('drizzle-orm');

/** RFC 6238 code for a base32 secret, computed independently of the code under test. */
async function code(secret: string, at = new Date()): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secret) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  let counter = totpCounter(at);
  const message = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    message[i] = counter & 255;
    counter = Math.floor(counter / 256);
  }
  const key = await crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[19]! & 15;
  const binary = ((digest[offset]! & 127) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

const OLD_PASSWORD = 'correct horse battery';

async function attempt(email: string, password = OLD_PASSWORD) {
  const challenge = await admin.bootstrapChallenge();
  return admin.bootstrapFirstAdministrator({
    name: 'Owner',
    email,
    password,
    sealedSecret: challenge.sealed,
    code: await code(challenge.secret),
  });
}

/** The two old-console tables the allowlist reads, as the cutover archives them. */
async function archive(rows: { email: string; status: string; role: string | null }[]) {
  await db().execute(sql`drop schema if exists legacy_main cascade`);
  await db().execute(sql`create schema legacy_main`);
  await db().execute(sql`create table legacy_main.administrator (id uuid primary key, email text not null, status text not null, password_hash text)`);
  await db().execute(sql`create table legacy_main.administrator_role (administrator_id uuid not null, role_id text not null)`);
  for (const row of rows) {
    const id = crypto.randomUUID();
    await db().execute(sql`insert into legacy_main.administrator values (${id}, ${row.email}, ${row.status}, ${await admin.hashPassword(OLD_PASSWORD)})`);
    if (row.role) await db().execute(sql`insert into legacy_main.administrator_role values (${id}, ${row.role})`);
  }
}

async function emptyConsole() {
  await db().delete(schema.adminSession);
  await db().delete(schema.administrator);
}

afterAll(async () => {
  await db().execute(sql`drop schema if exists legacy_main cascade`);
  await emptyConsole();
});

describeWithDb('first administrator after a cutover', () => {
  beforeEach(emptyConsole);

  it('admits only the old console\'s active super administrators, with their old password', async () => {
    await archive([
      { email: 'Boss@Example.test', status: 'active', role: 'super' },
      { email: 'ops@example.test', status: 'active', role: 'operator' },
      { email: 'former@example.test', status: 'disabled', role: 'super' },
    ]);
    expect((await admin.bootstrapAllowlist())?.map((entry) => entry.email)).toEqual(['boss@example.test']);
    await expect(attempt('intruder@example.test')).rejects.toMatchObject({ code: 'bootstrap_email' });
    /* Knowing the address is not enough. */
    await expect(attempt('boss@example.test', 'a guessed password here')).rejects.toMatchObject({ code: 'bootstrap_email' });
    await expect(attempt('ops@example.test')).rejects.toMatchObject({ code: 'bootstrap_email' });
    await expect(attempt('former@example.test')).rejects.toMatchObject({ code: 'bootstrap_email' });
    expect(await admin.hasAdministrator()).toBe(false);

    const owner = await attempt('BOSS@example.test');
    expect(owner).toMatchObject({ email: 'boss@example.test', role: 'owner' });
    await expect(attempt('boss@example.test')).rejects.toMatchObject({ code: 'bootstrap_closed' });
  });

  it('falls back to every active administrator when the old console had no super one', async () => {
    await archive([
      { email: 'ops@example.test', status: 'active', role: 'operator' },
      { email: 'gone@example.test', status: 'disabled', role: 'support' },
    ]);
    expect((await admin.bootstrapAllowlist())?.map((entry) => entry.email)).toEqual(['ops@example.test']);
    await expect(attempt('gone@example.test')).rejects.toMatchObject({ code: 'bootstrap_email' });
    expect(await attempt('ops@example.test')).toMatchObject({ role: 'owner' });
  });

  it('stays open on a fresh install, and on an archive with nobody active', async () => {
    await db().execute(sql`drop schema if exists legacy_main cascade`);
    expect(await admin.bootstrapAllowlist()).toBeNull();
    await archive([{ email: 'gone@example.test', status: 'disabled', role: 'super' }]);
    expect(await admin.bootstrapAllowlist()).toBeNull();
    expect(await attempt('anyone@example.test')).toMatchObject({ role: 'owner' });
  });
});

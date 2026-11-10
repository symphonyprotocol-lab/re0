/**
 * The production cutover (scripts/database-cutover.mts) on throwaway
 * databases that look like the old app's: archive once, migrate in the same
 * transaction, no-op on the next build, survive a failing migration and a
 * concurrent build, roll back and forward again, drop the archive.
 *
 * The full 61-migration old schema is exercised by hand in
 * docs/cutover/production-cutover.md (appendix C); here a few old tables,
 * the `vector` extension and main's journal stand in for it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@neondatabase/serverless';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { TEST_DATABASE_URL, uniqueName } from './setup';
import {
  CutoverRefused,
  LEGACY_LAST_WHEN,
  deployDatabase,
  dropLegacy,
  inspect,
  resumeCutover,
  rollbackCutover,
} from '../../scripts/database-cutover.mjs';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const { db } = await import('@/lib/infra/db');
const { sql } = await import('drizzle-orm');

const MIGRATIONS = join(process.cwd(), 'db', 'migrations');
const created: string[] = [];
const clients: Client[] = [];

/** A fresh database on the test server holding a miniature of the old app's schema and journal. */
async function legacyDatabase(): Promise<Client> {
  const name = uniqueName('cutover').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await db().execute(sql.raw(`create database ${name}`));
  created.push(name);
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  clients.push(client);
  await client.query(`
    create extension vector;
    create table workspace (id uuid primary key);
    create table "user" (id uuid primary key, email text not null);
    create table administrator (id uuid primary key, email text not null, status text not null);
    create table administrator_role (administrator_id uuid not null, role_id text not null);
    create table chunk (id int primary key, embedding vector(3));
    insert into "user" values ('00000000-0000-4000-8000-000000000001', 'old@example.test');
    insert into administrator values ('00000000-0000-4000-8000-0000000000a1', 'Boss@Example.test', 'active');
    insert into administrator_role values ('00000000-0000-4000-8000-0000000000a1', 'super');
    insert into chunk values (1, '[1,2,3]');
    create schema drizzle;
    create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
    insert into drizzle.__drizzle_migrations (hash, created_at) values ('old-0000', 1787584296879), ('old-0060', ${LEGACY_LAST_WHEN});
  `);
  return client;
}

async function scalar(client: Client, text: string): Promise<unknown> {
  const { rows } = await client.query(text);
  return Object.values(rows[0] ?? {})[0];
}

afterAll(async () => {
  for (const client of clients) await client.end().catch(() => undefined);
  for (const name of created) await db().execute(sql.raw(`drop database if exists ${name} with (force)`));
});

describeWithDb('production cutover', () => {
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS });

  it('archives the old schema and builds the new one in one go, then does nothing', async () => {
    const client = await legacyDatabase();
    const first = await deployDatabase(client, MIGRATIONS);
    expect(first.archived).toBe(true);
    expect(first.applied).toHaveLength(migrations.length);
    expect(first.applied[0]!.tag).toBe('0001_init');

    const state = await inspect(client);
    expect(state).toMatchObject({ public: 'rebuild', legacyArchived: true, legacyJournalArchived: true, rebuildParked: false, vectorSchema: 'public' });
    expect(state.journalLast).toBe(migrations.at(-1)!.folderMillis);
    /* The journal is drizzle's own: same hashes, same `created_at`, so a later drizzle-kit migrate agrees. */
    const { rows } = await client.query('select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at');
    expect(rows.map((r) => [r.hash, Number(r.created_at)])).toEqual(migrations.map((m) => [m.hash, m.folderMillis]));

    /* The old data is archived, not dropped, and its vectors still work with the extension in the new public. */
    expect(await scalar(client, 'select email from legacy_main."user"')).toBe('old@example.test');
    expect(await scalar(client, `select embedding <-> '[1,2,3]' from legacy_main.chunk`)).toBe(0);
    expect(await scalar(client, 'select count(*)::int from legacy_drizzle.__drizzle_migrations')).toBe(2);
    expect(await scalar(client, 'select count(*)::int from public."user"')).toBe(0);
    expect(await scalar(client, 'select count(*)::int from public.administrator')).toBe(0);

    const second = await deployDatabase(client, MIGRATIONS);
    expect(second).toMatchObject({ archived: false, applied: [] });
  });

  it('leaves the old schema in place when a migration fails, so a retried build starts over', async () => {
    const client = await legacyDatabase();
    const broken = mkdtempSync(join(tmpdir(), 're0-cutover-'));
    mkdirSync(join(broken, 'meta'));
    writeFileSync(join(broken, 'meta', '_journal.json'), JSON.stringify({ entries: [{ idx: 1, tag: '0001_broken', when: 1793578769330, breakpoints: true }] }));
    writeFileSync(join(broken, '0001_broken.sql'), 'CREATE TABLE "ree" (id int);--> statement-breakpoint\nSELECT no_such_function();');
    await expect(deployDatabase(client, broken)).rejects.toThrow(/no_such_function/);
    expect(await inspect(client)).toMatchObject({ public: 'legacy', legacyArchived: false, journalLast: LEGACY_LAST_WHEN, vectorSchema: 'public' });

    const retried = await deployDatabase(client, MIGRATIONS);
    expect(retried.archived).toBe(true);
  });

  it('lets one of two concurrent builds cut over and the other find it done', async () => {
    const first = await legacyDatabase();
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${created.at(-1)}`;
    const second = new Client({ connectionString: url.toString() });
    await second.connect();
    clients.push(second);
    const results = await Promise.all([deployDatabase(first, MIGRATIONS), deployDatabase(second, MIGRATIONS)]);
    expect(results.filter((r) => r.archived)).toHaveLength(1);
    expect(results.map((r) => r.applied.length).sort((a, b) => a - b)).toEqual([0, migrations.length]);
    expect(await inspect(first)).toMatchObject({ public: 'rebuild', legacyArchived: true });
  });

  it('rolls back to the old schema, refuses to deploy while parked, resumes, and drops the archive', async () => {
    const client = await legacyDatabase();
    await deployDatabase(client, MIGRATIONS);
    await client.query(`insert into public."user" (email, name, provider, provider_subject) values ('new@example.test', 'New', 'github', 'gh-1')`);

    const rolledBack = await rollbackCutover(client);
    expect(rolledBack).toMatchObject({ public: 'legacy', legacyArchived: false, rebuildParked: true, parkedJournal: true, vectorSchema: 'public', journalLast: LEGACY_LAST_WHEN });
    expect(await scalar(client, 'select email from public."user"')).toBe('old@example.test');
    expect(await scalar(client, `select embedding <-> '[1,2,3]' from public.chunk`)).toBe(0);
    await expect(rollbackCutover(client)).rejects.toBeInstanceOf(CutoverRefused);
    await expect(deployDatabase(client, MIGRATIONS)).rejects.toThrow(/rolled back/);

    const resumed = await resumeCutover(client);
    expect(resumed).toMatchObject({ public: 'rebuild', legacyArchived: true, rebuildParked: false, vectorSchema: 'public' });
    expect(await scalar(client, 'select email from public."user"')).toBe('new@example.test');
    expect(await deployDatabase(client, MIGRATIONS)).toMatchObject({ archived: false, applied: [] });

    const dropped = await dropLegacy(client);
    expect(dropped).toMatchObject({ public: 'rebuild', legacyArchived: false, legacyJournalArchived: false });
    await expect(rollbackCutover(client)).rejects.toThrow(/legacy_main does not exist/);
    expect(await deployDatabase(client, MIGRATIONS)).toMatchObject({ archived: false, applied: [] });
  });

  it('migrates a fresh database without archiving anything', async () => {
    const name = uniqueName('fresh').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    await db().execute(sql.raw(`create database ${name}`));
    created.push(name);
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    clients.push(client);
    const result = await deployDatabase(client, MIGRATIONS);
    expect(result).toMatchObject({ archived: false });
    expect(result.applied).toHaveLength(migrations.length);
    expect(await inspect(client)).toMatchObject({ public: 'rebuild', legacyArchived: false });
  });

  async function freshDatabase(): Promise<Client> {
    const name = uniqueName('fresh').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    await db().execute(sql.raw(`create database ${name}`));
    created.push(name);
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${name}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    clients.push(client);
    return client;
  }

  /** db/migrations plus one more file, journalled with `when`. */
  function withExtraMigration(tag: string, when: number, text: string): string {
    const folder = mkdtempSync(join(tmpdir(), 're0-cutover-'));
    cpSync(MIGRATIONS, folder, { recursive: true });
    const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
    journal.entries.push({ idx: journal.entries.length, tag, when, breakpoints: true } as never);
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify(journal));
    writeFileSync(join(folder, `${tag}.sql`), text);
    return folder;
  }

  it('refuses a migration that would be skipped because a later one already ran', async () => {
    const client = await freshDatabase();
    await deployDatabase(client, MIGRATIONS);
    const late = withExtraMigration('9998_merged_below', migrations[1]!.folderMillis + 1, 'CREATE TABLE "late_table" (id int);');
    await expect(deployDatabase(client, late)).rejects.toThrow(/9998_merged_below would be skipped/);
    expect(await scalar(client, `select to_regclass('public.late_table') is null`)).toBe(true);
    /* An applied file edited afterwards keeps its \`when\` and is not refused. */
    const edited = mkdtempSync(join(tmpdir(), 're0-cutover-'));
    cpSync(MIGRATIONS, edited, { recursive: true });
    const firstTag = (JSON.parse(readFileSync(join(edited, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] }).entries[0]!.tag;
    writeFileSync(join(edited, `${firstTag}.sql`), `${readFileSync(join(edited, `${firstTag}.sql`), 'utf8')}\n-- a comment added later\n`);
    expect(await deployDatabase(client, edited)).toMatchObject({ applied: [] });
  });

  it('gives up on a migration stuck behind a lock instead of queueing everything behind it', async () => {
    const client = await freshDatabase();
    await deployDatabase(client, MIGRATIONS);
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${client.database}`;
    const holder = new Client({ connectionString: url.toString() });
    await holder.connect();
    clients.push(holder);
    await holder.query('begin');
    await holder.query('lock table "user" in access share mode');
    const blocked = withExtraMigration('9999_alter_user', migrations.at(-1)!.folderMillis + 1, 'ALTER TABLE "user" ADD COLUMN "late" int;');
    const started = Date.now();
    await expect(deployDatabase(client, blocked, new Date(), { lockTimeoutMs: 300, statementTimeoutMs: 60_000 })).rejects.toThrow(/lock timeout/);
    expect(Date.now() - started).toBeLessThan(10_000);
    await holder.query('rollback');
    expect(await deployDatabase(client, blocked)).toMatchObject({ applied: [{ tag: '9999_alter_user' }] });
  });
});

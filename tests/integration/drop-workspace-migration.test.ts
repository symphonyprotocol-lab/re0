/**
 * Migration 0101_drop_workspace_oauth, run on its own databases: one built
 * to 0100 and seeded with workspace and OAuth data, and a copy left at 0100
 * to compare with. 0101 refuses while a workspace holds a live file or a
 * live Ree answers from one, changing nothing; once both are in the trash it
 * runs, and runs again without error. It only changes data: the schema
 * afterwards is 0100's with the OAuth key check gone, key_digest NOT NULL
 * again and the removed_workspace list added -- every table and column the
 * previous deployment reads is still there. Statements run one at a time,
 * as scripts/test-integration.sh runs them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from '@neondatabase/serverless';
import { TEST_DATABASE_URL } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const { createPool, db } = await import('@/lib/infra/db');
const { sql } = await import('drizzle-orm');

const MIGRATIONS = join(process.cwd(), 'db/migrations');
const files = readdirSync(MIGRATIONS).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
const THIS = '0101_drop_workspace_oauth.sql';
const tag = Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, '0')).join('');
const SCRATCH = `m0101_${tag}`;
const REFERENCE = `m0100_${tag}`;
const BASELINE = `m0094_${tag}`;
const NEXT = '0102_drop_workspace_columns.sql';
const urlOf = (name: string) => {
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
};

async function apply(pool: Pool, file: string): Promise<void> {
  const text = readFileSync(join(MIGRATIONS, file), 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    const code = statement.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim();
    if (code) await pool.query(statement);
  }
}

const IDS = {
  user: '00000000-0000-4000-8000-000000000001',
  ree: '00000000-0000-4000-8000-0000000000a1',
  workspace: '00000000-0000-4000-8000-0000000000b1',
  gone: '00000000-0000-4000-8000-0000000000b2',
  late: '00000000-0000-4000-8000-0000000000b3',
  lateFile: '00000000-0000-4000-8000-0000000000c2',
  lateKey: '00000000-0000-4000-8000-0000000000d4',
  file: '00000000-0000-4000-8000-0000000000c1',
  accountKey: '00000000-0000-4000-8000-0000000000d1',
  workspaceKey: '00000000-0000-4000-8000-0000000000d2',
  oauthKey: '00000000-0000-4000-8000-0000000000d3',
  post: '00000000-0000-4000-8000-0000000000e1',
};

let pool: Pool;

async function seed(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  await q(`insert into "user"(id, name, email, provider, provider_subject) values ($1, 'Owner', 'owner@example.test', 'github', 'm0101')`, [IDS.user]);
  await q(`insert into ree(id, owner_id, name, slug) values ($1, $2, 'Bound', 'm0101-bound')`, [IDS.ree, IDS.user]);
  await q(`insert into agent_workspace(id, owner_id) values ($1, $2)`, [IDS.workspace, IDS.user]);
  await q(`insert into agent_workspace_gone(workspace_id) values ($1)`, [IDS.gone]);
  await q(`insert into agent_workspace_entry(id, workspace_id, path, kind) values ($1, $2, '/notes.md', 'file'), (gen_random_uuid(), $2, '/old', 'folder')`, [IDS.file, IDS.workspace]);
  await q(`insert into agent_workspace_blob(workspace_id, sha256, size, refs) values ($1, repeat('a', 64), 3, 1)`, [IDS.workspace]);
  await q(`insert into agent_workspace_usage(user_id) values ($1)`, [IDS.user]);
  await q(`insert into agent_ree_binding(ree_id, workspace_id, entry_id, created_by) values ($1, $2, $3, $4)`, [IDS.ree, IDS.workspace, IDS.file, IDS.user]);
  await q(`insert into oauth_client(id, kind, client_name, redirect_uris) values ('client-1', 'registered', 'Some client', array['https://client.test/cb'])`);
  await q(`insert into api_key(id, user_id, name, key_digest, key_tail) values ($1, $2, 'account', 'digest-1', 'tail1')`, [IDS.accountKey, IDS.user]);
  await q(`insert into api_key(id, user_id, name, key_digest, key_tail, workspace_access, workspace_id) values ($1, $2, 'workspace', 'digest-2', 'tail2', 'read', $3)`, [IDS.workspaceKey, IDS.user, IDS.workspace]);
  await q(`insert into api_key(id, user_id, name, key_digest, key_tail, oauth_client_id) values ($1, $2, 'connected', null, 'tail3', 'client-1')`, [IDS.oauthKey, IDS.user]);
  await q(`insert into oauth_token(api_key_id, kind, digest, resource, expires_at) values ($1, 'access', 'token-digest', 'https://re0.test/api/mcp', now() + interval '1 hour')`, [IDS.oauthKey]);
  await q(`insert into post(id, user_id, source, visibility, question, lang, api_key_id) values ($1, $2, 'api', 'private', 'Asked from a connector?', 'en', $3)`, [IDS.post, IDS.user, IDS.oauthKey]);
  await q(`insert into knowledge(ree_id, kind, title, original_title) values ($1, 'file', 'notes.md', 'notes.md')`, [IDS.ree]);
  await q(`insert into knowledge(ree_id, kind, title, original_title, deleted_at) values ($1, 'file', 'old.md', 'old.md', now())`, [IDS.ree]);
  await q(`insert into rate_limit_exemption(user_id, limits) values ($1, array['workspaceRead', 'browse'])`, [IDS.user]);
  await q(`insert into limit_ceiling_setting(key, value) values ('workspaceFreeMb', 5)`);
  await q(`insert into rate_limit_setting(name, per_minute, per_hour) values ('workspaceWrite', 10, 100)`);
}

/** Tables, columns (type, null, default), constraints and indexes of `public`, one line each. */
async function shape(target: Pool): Promise<Set<string>> {
  const rows = await target.query<{ line: string }>(`
    select 'table ' || table_name as line from information_schema.tables where table_schema = 'public'
    union all
    select format('column %s.%s %s null=%s default=%s', table_name, column_name, data_type, is_nullable, coalesce(column_default, '')) from information_schema.columns where table_schema = 'public'
    union all
    select format('constraint %s.%s %s', conrelid::regclass, conname, pg_get_constraintdef(oid)) from pg_constraint where connamespace = 'public'::regnamespace
    union all
    select format('index %s', indexdef) from pg_indexes where schemaname = 'public'`);
  return new Set(rows.rows.map((row) => row.line));
}

const difference = (a: Set<string>, b: Set<string>) => [...a].filter((line) => !b.has(line)).sort();

describeWithDb('migration 0101: guarded, data only, idempotent', () => {
  beforeAll(async () => {
    await db().execute(sql.raw(`create database ${SCRATCH}`));
    let build = createPool(urlOf(SCRATCH));
    for (const file of files.filter((name) => name < '0095')) await apply(build, file);
    await build.end();
    /* The baseline stays at 0094, as #254 left it. */
    await db().execute(sql.raw(`create database ${BASELINE} template ${SCRATCH}`));
    build = createPool(urlOf(SCRATCH));
    for (const file of files.filter((name) => name >= '0095' && name < THIS)) await apply(build, file);
    await build.end();
    /* The reference stays at 0100. */
    await db().execute(sql.raw(`create database ${REFERENCE} template ${SCRATCH}`));
    pool = createPool(urlOf(SCRATCH));
    await seed();
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await db().execute(sql.raw(`drop database if exists ${SCRATCH} with (force)`));
    await db().execute(sql.raw(`drop database if exists ${REFERENCE} with (force)`));
    await db().execute(sql.raw(`drop database if exists ${BASELINE} with (force)`));
  });

  it('refuses while a workspace holds a live file, and changes nothing', async () => {
    await expect(apply(pool, THIS)).rejects.toThrow(/0101_drop_workspace_oauth refused: workspace data exists \(1 live workspace file\(s\) in agent_workspace_entry, 1 live workspace file source\(s\) in knowledge\)/);
    const keys = await pool.query(`select name, revoked_at from api_key order by name`);
    expect(keys.rows.every((row) => row.revoked_at === null)).toBe(true);
    expect((await pool.query(`select to_regclass('public.removed_workspace') as t`)).rows[0].t).toBeNull();
  });

  it('refuses while a live Ree still answers from a workspace file, even with every file in the trash', async () => {
    await pool.query(`update agent_workspace_entry set deleted_at = now()`);
    const refusal = apply(pool, THIS);
    await expect(refusal).rejects.toThrow(/refused: workspace data exists \(1 live workspace file source\(s\) in knowledge\)/);
  });

  it('runs once both are in the trash: keys revoked, not deleted; contents, sources and settings gone; tables and columns kept', async () => {
    await pool.query(`update knowledge set deleted_at = now() where kind = 'file'`);
    await apply(pool, THIS);
    const keys = await pool.query(`select id, name, key_digest, revoked_at is not null as revoked from api_key order by name`);
    expect(keys.rows).toEqual([
      { id: IDS.accountKey, name: 'account', key_digest: 'digest-1', revoked: false },
      { id: IDS.oauthKey, name: 'connected', key_digest: `removed-oauth:${IDS.oauthKey}`, revoked: true },
      { id: IDS.workspaceKey, name: 'workspace', key_digest: 'digest-2', revoked: true },
    ]);
    /* The connector's post keeps its key, so per-key usage still counts it. */
    expect((await pool.query(`select api_key_id from post where id = $1`, [IDS.post])).rows[0].api_key_id).toBe(IDS.oauthKey);
    const counts = await pool.query(`select
      (select count(*) from knowledge where kind = 'file')::int as file_sources,
      (select count(*) from agent_workspace_entry)::int as entries,
      (select count(*) from agent_workspace_blob)::int as blobs,
      (select count(*) from agent_workspace_usage)::int as usage,
      (select count(*) from agent_ree_binding)::int as bindings,
      (select count(*) from oauth_token)::int as tokens,
      (select count(*) from limit_ceiling_setting where key like 'workspace%')::int as ceilings,
      (select count(*) from rate_limit_setting where name like 'workspace%')::int as settings`);
    expect(counts.rows[0]).toEqual({ file_sources: 0, entries: 0, blobs: 0, usage: 0, bindings: 0, tokens: 0, ceilings: 0, settings: 0 });
    expect((await pool.query(`select limits from rate_limit_exemption where user_id = $1`, [IDS.user])).rows[0].limits).toEqual(['browse']);
    /* This database's workspaces, the deleted account's included, and nothing else: all the Blob cleanup may touch. */
    expect((await pool.query(`select workspace_id from removed_workspace order by workspace_id`)).rows.map((row) => row.workspace_id)).toEqual([IDS.workspace, IDS.gone]);
    /* The previous deployment's queries still find what they read. */
    await pool.query(`select workspace_access, workspace_id, workspace_root, client_name, oauth_client_id from api_key`);
    await pool.query(`select workspace_entry_id, workspace_revision_id, awaiting_confirmation, secret_found from knowledge`);
    await pool.query(`select o.client_name from api_key k left join oauth_client o on o.id = k.oauth_client_id`);
    await pool.query(`select count(*) from agent_ree_binding b join agent_workspace_entry e on e.id = b.entry_id`);
  });

  it('runs again without error and without changing anything', async () => {
    const before = await pool.query(`select id, key_digest, revoked_at from api_key order by id`);
    await apply(pool, THIS);
    expect((await pool.query(`select id, key_digest, revoked_at from api_key order by id`)).rows).toEqual(before.rows);
    expect((await pool.query(`select count(*)::int as n from removed_workspace`)).rows[0].n).toBe(2);
  });

  it("leaves 0100's schema, apart from the OAuth key check, key_digest NOT NULL and the removed_workspace list", async () => {
    const reference = createPool(urlOf(REFERENCE));
    try {
      const [after, before] = await Promise.all([shape(pool), shape(reference)]);
      expect(difference(before, after)).toEqual([
        'column api_key.key_digest text null=YES default=',
        'constraint api_key.api_key_oauth_check CHECK (((oauth_client_id IS NULL) = (key_digest IS NOT NULL)))',
      ]);
      expect(difference(after, before)).toEqual([
        'column api_key.key_digest text null=NO default=',
        'column removed_workspace.removed_at timestamp with time zone null=NO default=now()',
        'column removed_workspace.workspace_id uuid null=NO default=',
        'constraint removed_workspace.removed_workspace_pkey PRIMARY KEY (workspace_id)',
        'index CREATE UNIQUE INDEX removed_workspace_pkey ON public.removed_workspace USING btree (workspace_id)',
        'table removed_workspace',
      ]);
    } finally {
      await reference.end();
    }
  });

  it('0102 refuses a live workspace file written after 0101 (a rolled-back deployment), and changes nothing', async () => {
    await pool.query(`insert into agent_workspace_entry(id, workspace_id, path, kind) values ($1, $2, '/late.md', 'file')`, [IDS.lateFile, IDS.workspace]);
    await expect(apply(pool, NEXT)).rejects.toThrow(/0102_drop_workspace_columns refused: workspace data exists \(1 live workspace file\(s\) in agent_workspace_entry\)/);
    /* Nothing went: tables, columns and the permissive kind check are all still there. */
    const left = await pool.query(`select
      to_regclass('public.agent_workspace_entry') is not null as entries,
      to_regclass('public.oauth_client') is not null as clients,
      exists (select 1 from information_schema.columns where table_name = 'api_key' and column_name = 'workspace_id') as key_column,
      exists (select 1 from information_schema.columns where table_name = 'knowledge' and column_name = 'secret_found') as knowledge_column,
      (select pg_get_constraintdef(oid) from pg_constraint where conname = 'knowledge_kind_check') as kind_check`);
    expect(left.rows[0]).toMatchObject({ entries: true, clients: true, key_column: true, knowledge_column: true, kind_check: expect.stringContaining("'file'") });
    await pool.query(`update agent_workspace_entry set deleted_at = now() where id = $1`, [IDS.lateFile]);
  });

  it("0102 then drops what is left: 0094's schema plus removed_workspace, with the kind check NOT VALID, and it runs again", async () => {
    /* A workspace and a workspace key made after 0101: 0102 lists the one for the Blob cleanup and revokes the other. */
    await pool.query(`insert into agent_workspace(id, owner_id, name) values ($1, $2, 'late')`, [IDS.late, IDS.user]);
    await pool.query(`insert into api_key(id, user_id, name, key_digest, key_tail, workspace_access, workspace_id) values ($1, $2, 'late workspace', 'digest-4', 'tail4', 'write', $3)`, [IDS.lateKey, IDS.user, IDS.late]);
    await apply(pool, NEXT);
    await apply(pool, NEXT);
    const baseline = createPool(urlOf(BASELINE));
    try {
      const [after, before] = await Promise.all([shape(pool), shape(baseline)]);
      const check = [...before].find((line) => line.startsWith('constraint knowledge.knowledge_kind_check '))!;
      expect(difference(before, after)).toEqual([check]);
      expect(difference(after, before)).toEqual([
        'column removed_workspace.removed_at timestamp with time zone null=NO default=now()',
        'column removed_workspace.workspace_id uuid null=NO default=',
        `${check} NOT VALID`,
        'constraint removed_workspace.removed_workspace_pkey PRIMARY KEY (workspace_id)',
        'index CREATE UNIQUE INDEX removed_workspace_pkey ON public.removed_workspace USING btree (workspace_id)',
        'table removed_workspace',
      ].sort());
      /* Validating it later succeeds: every row already passes. */
      const scratch = await pool.connect();
      try {
        await scratch.query('begin');
        await scratch.query('alter table knowledge validate constraint knowledge_kind_check');
        await scratch.query('rollback');
      } finally {
        scratch.release();
      }
      expect((await pool.query(`select workspace_id from removed_workspace order by workspace_id`)).rows.map((row) => row.workspace_id)).toEqual([IDS.workspace, IDS.gone, IDS.late]);
      const keys = await pool.query(`select id, revoked_at is not null as revoked from api_key order by id`);
      expect(keys.rows).toEqual([
        { id: IDS.accountKey, revoked: false },
        { id: IDS.workspaceKey, revoked: true },
        { id: IDS.oauthKey, revoked: true },
        { id: IDS.lateKey, revoked: true },
      ]);
      /* The connector's post keeps its key. */
      expect((await pool.query(`select api_key_id from post where id = $1`, [IDS.post])).rows[0].api_key_id).toBe(IDS.oauthKey);
    } finally {
      await baseline.end();
    }
  });
});

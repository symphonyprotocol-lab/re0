/**
 * The production database deploy, and the one-time switch from the old app's
 * schema to the rebuild (docs/cutover/production-cutover.md).
 *
 * Production still holds the old app's 61-migration schema in `public`, and
 * the rebuild's migrations start over at `0001_init`, so `drizzle-kit
 * migrate` alone would collide with the old tables. `deployDatabase` runs
 * after `next build` in a production build and, in ONE transaction under an
 * advisory lock:
 *
 *   1. looks at what `public` holds;
 *   2. if it is the old app's schema (and nothing has been archived or
 *      parked yet), moves every table and type of the old app from `public`
 *      into a new schema `legacy_main`, and renames `drizzle` (the old
 *      journal) to `legacy_drizzle`;
 *   3. applies the pending migrations exactly as drizzle's migrator does
 *      (same files, hashes, journal table and `created_at` rule).
 *
 * `public` itself is never renamed or recreated, so its owner and grants stay
 * as Neon made them, and the `vector` extension (whose type both apps use
 * unqualified) stays where it is: moving an extension needs its owner, which
 * the build's role may not be. Indexes, constraints and owned sequences move
 * with their tables.
 *
 * Either all of it commits or none of it does, so a failed or retried build
 * leaves the database as it found it, and a second build waiting on the lock
 * finds the rebuild's schema and only applies what is new. Nothing is
 * dropped: the old data stays in `legacy_main` until `dropLegacy`.
 *
 * `rollbackCutover` swaps the two back (the rebuild's objects are parked in
 * `rebuild_parked`), so an Instant Rollback to the old deployment finds its
 * own schema again; `resumeCutover` swaps them forward once more. While the
 * rebuild is parked, `deployDatabase` refuses: a build that is not promoted
 * automatically must not pull the database out from under the old app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';

/** What the functions here need from a connection: one session, so `begin` / `commit` and the lock hold. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const LOCK_KEY = 're0:database-deploy';

/**
 * Every transaction here runs with these. A migration waiting on a lock queues
 * every later query on that table behind it (an `ALTER TABLE credit_entry`
 * behind one long transaction stalls all billing), so it gives up after
 * `lockTimeoutMs` and the build fails with the old deployment still serving;
 * a statement that runs away is cut off rather than holding the build.
 */
export interface TransactionLimits {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}
export const DEFAULT_LIMITS: TransactionLimits = { lockTimeoutMs: 10_000, statementTimeoutMs: 10 * 60_000 };
/** `when` of the old app's last migration (`0060_manual_payout` on `main`). */
export const LEGACY_LAST_WHEN = 1793200000000;
export const LEGACY_SCHEMA = 'legacy_main';
export const LEGACY_JOURNAL_SCHEMA = 'legacy_drizzle';
export const PARKED_SCHEMA = 'rebuild_parked';
export const PARKED_JOURNAL_SCHEMA = 'rebuild_parked_drizzle';

export class CutoverRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CutoverRefused';
  }
}

export interface DatabaseState {
  /** `rebuild`: has `ree`; `legacy`: has the old app's `workspace`; `empty`: no tables at all. */
  public: 'rebuild' | 'legacy' | 'both' | 'empty' | 'unknown';
  /** Newest `created_at` in `drizzle.__drizzle_migrations`, or null without a journal. */
  journalLast: number | null;
  hasJournalSchema: boolean;
  legacyArchived: boolean;
  legacyJournalArchived: boolean;
  rebuildParked: boolean;
  parkedJournal: boolean;
  /** The schema the `vector` extension lives in, or null when it is not installed. */
  vectorSchema: string | null;
}

/** Objects of a schema that belong to an extension (vector's type, functions, operators) stay where they are. */
const NOT_EXTENSION_MEMBER = (catalog: string, oid: string) =>
  `not exists (select 1 from pg_depend d where d.classid = '${catalog}'::regclass and d.objid = ${oid} and d.deptype = 'e')`;

export async function inspect(db: Queryable): Promise<DatabaseState> {
  const { rows } = await db.query(`
    select to_regclass('public.ree') is not null as rebuild,
           to_regclass('public.workspace') is not null as legacy,
           (select count(*)::int from pg_class c
             where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
               and ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}) as relations,
           to_regclass('drizzle.__drizzle_migrations') is not null as journal,
           exists (select 1 from pg_namespace where nspname = 'drizzle') as journal_schema,
           exists (select 1 from pg_namespace where nspname = '${LEGACY_SCHEMA}') as legacy_archived,
           exists (select 1 from pg_namespace where nspname = '${LEGACY_JOURNAL_SCHEMA}') as legacy_journal_archived,
           exists (select 1 from pg_namespace where nspname = '${PARKED_SCHEMA}') as rebuild_parked,
           exists (select 1 from pg_namespace where nspname = '${PARKED_JOURNAL_SCHEMA}') as parked_journal,
           (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
             where e.extname = 'vector') as vector_schema
  `);
  const row = rows[0]!;
  let journalLast: number | null = null;
  if (row.journal) {
    const last = await db.query('select max(created_at)::text as last from drizzle.__drizzle_migrations');
    journalLast = last.rows[0]?.last == null ? null : Number(last.rows[0]!.last);
  }
  const kind: DatabaseState['public'] = row.rebuild
    ? row.legacy ? 'both' : 'rebuild'
    : row.legacy ? 'legacy' : Number(row.relations) === 0 ? 'empty' : 'unknown';
  return {
    public: kind,
    journalLast,
    hasJournalSchema: Boolean(row.journal_schema),
    legacyArchived: Boolean(row.legacy_archived),
    legacyJournalArchived: Boolean(row.legacy_journal_archived),
    rebuildParked: Boolean(row.rebuild_parked),
    parkedJournal: Boolean(row.parked_journal),
    vectorSchema: (row.vector_schema as string | null) ?? null,
  };
}

export type DeployPlan = { archive: boolean; reason: string } | { refuse: string };

/** What a production build may do with a database in `state`. Pure, so every branch is unit-tested. */
export function planDeploy(state: DatabaseState): DeployPlan {
  switch (state.public) {
    case 'rebuild':
      return { archive: false, reason: 'public already holds the rebuild schema' };
    case 'empty':
      return { archive: false, reason: 'public has no tables: a fresh database' };
    case 'both':
      return { refuse: 'public holds both the old app (workspace) and the rebuild (ree); fix it by hand' };
    case 'unknown':
      return { refuse: 'public holds tables of neither the old app nor the rebuild; refusing to touch it' };
    case 'legacy':
      if (state.rebuildParked) {
        return {
          refuse: `the cutover was rolled back (the rebuild is parked in ${PARKED_SCHEMA}); run \`npm run db:cutover -- resume\` before deploying the rebuild again`,
        };
      }
      if (state.legacyArchived || state.legacyJournalArchived) {
        return { refuse: `public holds the old app but ${LEGACY_SCHEMA} / ${LEGACY_JOURNAL_SCHEMA} already exists; fix it by hand` };
      }
      if (state.journalLast !== null && state.journalLast > LEGACY_LAST_WHEN) {
        return { refuse: `public holds the old app but its journal ends at ${state.journalLast}, after the old app's last migration (${LEGACY_LAST_WHEN})` };
      }
      return { archive: true, reason: `public holds the old app's schema (journal ends at ${state.journalLast ?? 'none'}); archiving it to ${LEGACY_SCHEMA}` };
  }
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Moves every table, view, free-standing sequence, type and routine of `from`
 * that no extension owns into `to` (created when missing). Indexes, constraints,
 * owned sequences, row types and array types follow on their own. Fails if
 * anything is left behind, so nothing of one app is ever mixed into the other.
 */
async function moveObjects(db: Queryable, from: string, to: string) {
  await db.query(`create schema if not exists ${ident(to)}`);
  const ns = `(select oid from pg_namespace where nspname = '${from}')`;
  const relations = await db.query(`
    select c.relname as name, c.relkind as kind from pg_class c
    where c.relnamespace = ${ns} and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
      and ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
    order by c.relname`);
  const verb: Record<string, string> = { r: 'table', p: 'table', v: 'view', m: 'materialized view', f: 'foreign table' };
  for (const row of relations.rows) {
    await db.query(`alter ${verb[row.kind as string]} ${ident(from)}.${ident(row.name as string)} set schema ${ident(to)}`);
  }
  /* Sequences a column owns (serial, identity) moved with their table. */
  const sequences = await db.query(`
    select c.relname as name from pg_class c
    where c.relnamespace = ${ns} and c.relkind = 'S' and ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}
      and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype in ('a', 'i'))`);
  for (const row of sequences.rows) await db.query(`alter sequence ${ident(from)}.${ident(row.name as string)} set schema ${ident(to)}`);
  /* Enums, domains, ranges and stand-alone composites; array and row types move with what they belong to. */
  const types = await db.query(`
    select t.typname as name from pg_type t
    where t.typnamespace = ${ns} and t.typtype in ('e', 'd', 'r', 'c') and t.typcategory <> 'A'
      and (t.typtype <> 'c' or (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c')
      and ${NOT_EXTENSION_MEMBER('pg_type', 't.oid')}`);
  for (const row of types.rows) await db.query(`alter type ${ident(from)}.${ident(row.name as string)} set schema ${ident(to)}`);
  const routines = await db.query(`
    select p.oid::regprocedure::text as signature from pg_proc p
    where p.pronamespace = ${ns} and p.prokind in ('f', 'p') and ${NOT_EXTENSION_MEMBER('pg_proc', 'p.oid')}`);
  for (const row of routines.rows) await db.query(`alter routine ${row.signature as string} set schema ${ident(to)}`);

  const left = await db.query(`
    select (select count(*)::int from pg_class c where c.relnamespace = ${ns} and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and ${NOT_EXTENSION_MEMBER('pg_class', 'c.oid')}) as relations,
           (select count(*)::int from pg_type t where t.typnamespace = ${ns} and t.typtype in ('e', 'd', 'r', 'c', 'm') and t.typcategory <> 'A'
              and (t.typtype <> 'c' or (select c.relkind from pg_class c where c.oid = t.typrelid) = 'c') and ${NOT_EXTENSION_MEMBER('pg_type', 't.oid')}) as types,
           (select count(*)::int from pg_proc p where p.pronamespace = ${ns} and ${NOT_EXTENSION_MEMBER('pg_proc', 'p.oid')}) as routines`);
  const remaining = left.rows[0]!;
  if (Number(remaining.relations) || Number(remaining.types) || Number(remaining.routines)) {
    throw new CutoverRefused(`could not move everything out of ${from}: ${JSON.stringify(remaining)} left; nothing was changed`);
  }
}

async function archiveLegacy(db: Queryable, state: DatabaseState, now: Date) {
  await moveObjects(db, 'public', LEGACY_SCHEMA);
  if (state.hasJournalSchema) await db.query(`alter schema drizzle rename to ${LEGACY_JOURNAL_SCHEMA}`);
  await db.query(`comment on schema ${LEGACY_SCHEMA} is 're0 cutover: the old app''s tables, moved out of public ${now.toISOString()}'`);
}

export interface AppliedMigration {
  tag: string;
  when: number;
}

/**
 * drizzle-orm's `PgDialect.migrate` (0.45), inside the caller's transaction
 * instead of its own: the same journal table, the same sha256 of each file,
 * and a file runs when its `when` is later than the newest applied one. A
 * later `drizzle-kit migrate` therefore sees this journal as its own.
 *
 * Unlike drizzle, a file whose `when` is not later than the newest applied
 * one but that never ran (its `when` is in no journal row) is refused rather
 * than skipped for good: that is a migration renumbered or merged below one
 * already deployed. A file edited after it ran keeps its `when` and is not
 * flagged.
 */
export async function applyMigrations(db: Queryable, folder: string): Promise<AppliedMigration[]> {
  await db.query('create schema if not exists drizzle');
  await db.query('create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)');
  const journal = await db.query('select created_at::text as created_at from drizzle.__drizzle_migrations');
  const ran = new Set(journal.rows.map((row) => Number(row.created_at)));
  const lastWhen = ran.size ? Math.max(...ran) : null;
  const tags = (JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string }[] }).entries.map((e) => e.tag);
  const files = readMigrationFiles({ migrationsFolder: folder });
  const skipped = files.flatMap((migration, index) =>
    lastWhen !== null && migration.folderMillis <= lastWhen && !ran.has(migration.folderMillis) ? [tags[index] ?? String(migration.folderMillis)] : [],
  );
  if (skipped.length) {
    throw new CutoverRefused(
      `${skipped.join(', ')} would be skipped: a migration with a later \`when\` (${lastWhen}) is already applied. Give ${skipped.length > 1 ? 'them' : 'it'} a \`when\` above every applied one; nothing was changed`,
    );
  }
  const applied: AppliedMigration[] = [];
  for (const [index, migration] of files.entries()) {
    if (lastWhen !== null && lastWhen >= migration.folderMillis) continue;
    for (const statement of migration.sql) {
      if (statement.trim()) await db.query(statement);
    }
    await db.query('insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)', [migration.hash, migration.folderMillis]);
    applied.push({ tag: tags[index] ?? String(migration.folderMillis), when: migration.folderMillis });
  }
  return applied;
}

async function inTransaction<T>(db: Queryable, work: () => Promise<T>, limits: TransactionLimits = DEFAULT_LIMITS): Promise<T> {
  await db.query('begin');
  try {
    await db.query(`set local statement_timeout = ${Math.max(1, Math.trunc(limits.statementTimeoutMs))}`);
    /* Waiting for a concurrent build is not a lock to give up on: the lock timeout starts once this build holds the deploy lock. */
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
    await db.query(`set local lock_timeout = ${Math.max(1, Math.trunc(limits.lockTimeoutMs))}`);
    const result = await work();
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback').catch(() => undefined);
    throw error;
  }
}

export interface DeployResult {
  before: DatabaseState;
  archived: boolean;
  reason: string;
  applied: AppliedMigration[];
}

/** The production build's database step: archive the old app's schema once, then migrate; all or nothing. */
export async function deployDatabase(db: Queryable, folder: string, now = new Date(), limits: TransactionLimits = DEFAULT_LIMITS): Promise<DeployResult> {
  return inTransaction(db, async () => {
    const before = await inspect(db);
    const plan = planDeploy(before);
    if ('refuse' in plan) throw new CutoverRefused(plan.refuse);
    if (plan.archive) await archiveLegacy(db, before, now);
    const applied = await applyMigrations(db, folder);
    return { before, archived: plan.archive, reason: plan.reason, applied };
  }, limits);
}

/** Puts the old app's tables back in `public` and parks the rebuild's, for an Instant Rollback to the old deployment. */
export async function rollbackCutover(db: Queryable, now = new Date()): Promise<DatabaseState> {
  return inTransaction(db, async () => {
    const state = await inspect(db);
    if (state.public !== 'rebuild') throw new CutoverRefused(`public does not hold the rebuild schema (it is ${state.public}); nothing to roll back`);
    if (!state.legacyArchived) throw new CutoverRefused(`${LEGACY_SCHEMA} does not exist; there is no old schema to restore`);
    if (state.rebuildParked || state.parkedJournal) throw new CutoverRefused(`${PARKED_SCHEMA} already exists; fix it by hand`);
    await moveObjects(db, 'public', PARKED_SCHEMA);
    if (state.hasJournalSchema) await db.query(`alter schema drizzle rename to ${PARKED_JOURNAL_SCHEMA}`);
    await moveObjects(db, LEGACY_SCHEMA, 'public');
    /* Empty now; without `cascade` this fails rather than drop anything that did not move. */
    await db.query(`drop schema ${LEGACY_SCHEMA}`);
    if (state.legacyJournalArchived) await db.query(`alter schema ${LEGACY_JOURNAL_SCHEMA} rename to drizzle`);
    await db.query(`comment on schema ${PARKED_SCHEMA} is 're0 cutover: the rebuild''s tables, parked by a rollback ${now.toISOString()}'`);
    return inspect(db);
  });
}

/** Swaps the parked rebuild back into `public` after a rollback (the reverse of `rollbackCutover`). */
export async function resumeCutover(db: Queryable, now = new Date()): Promise<DatabaseState> {
  return inTransaction(db, async () => {
    const state = await inspect(db);
    if (state.public !== 'legacy' || !state.rebuildParked) throw new CutoverRefused(`nothing is parked (public is ${state.public}); a normal deploy cuts over`);
    if (state.legacyArchived || state.legacyJournalArchived) throw new CutoverRefused(`${LEGACY_SCHEMA} already exists; fix it by hand`);
    await archiveLegacy(db, state, now);
    await moveObjects(db, PARKED_SCHEMA, 'public');
    await db.query(`drop schema ${PARKED_SCHEMA}`);
    if (state.parkedJournal) await db.query(`alter schema ${PARKED_JOURNAL_SCHEMA} rename to drizzle`);
    return inspect(db);
  });
}

/** Ends the rollback window: drops the archived old tables and journal. The rebuild must be live in `public`. */
export async function dropLegacy(db: Queryable): Promise<DatabaseState> {
  return inTransaction(db, async () => {
    const state = await inspect(db);
    if (state.public !== 'rebuild') throw new CutoverRefused(`public does not hold the rebuild schema (it is ${state.public}); refusing to drop the old one`);
    if (!state.legacyArchived && !state.legacyJournalArchived) throw new CutoverRefused('there is no archived old schema to drop');
    if (state.legacyArchived) await db.query(`drop schema ${LEGACY_SCHEMA} cascade`);
    if (state.legacyJournalArchived) await db.query(`drop schema ${LEGACY_JOURNAL_SCHEMA} cascade`);
    return inspect(db);
  });
}

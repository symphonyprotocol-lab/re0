/**
 * Whether a database's drizzle journal fits the migrations on disk.
 *
 * drizzle-kit's migrator records each applied file as the sha256 of its full
 * text plus the journal's `when`, and on the next run applies only the files
 * whose `when` is later than the newest applied one. A preview copy that ran
 * a migration this branch has since rewritten (or a branch that applied a
 * later-numbered file first) can therefore never catch up: the rewritten file
 * collides with what is already there, or an earlier file is skipped for
 * good. `db:prepare-preview` clears such a copy instead of failing the build.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LocalMigration {
  tag: string;
  hash: string;
  when: number;
}

export interface AppliedMigration {
  hash: string;
  createdAt: number;
}

/** The migrations in `db/migrations`, as drizzle's migrator hashes them. */
export function localMigrations(dir: string): LocalMigration[] {
  const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as { entries: { tag: string; when: number }[] };
  return journal.entries.map((entry) => ({
    tag: entry.tag,
    when: entry.when,
    hash: createHash('sha256').update(readFileSync(join(dir, `${entry.tag}.sql`), 'utf8')).digest('hex'),
  }));
}

/**
 * What makes the applied journal incompatible with the local files: applied
 * hashes no local file has, and local files the migrator would skip because
 * something newer is already applied. Empty when `drizzle-kit migrate` can
 * simply carry on.
 */
export function journalProblems(applied: readonly AppliedMigration[], local: readonly LocalMigration[]): string[] {
  const problems: string[] = [];
  const known = new Set(local.map((migration) => migration.hash));
  const done = new Set(applied.map((migration) => migration.hash));
  for (const migration of applied) {
    if (!known.has(migration.hash)) problems.push(`applied migration ${migration.hash.slice(0, 12)} (${new Date(migration.createdAt).toISOString()}) is not in db/migrations`);
  }
  const newest = Math.max(-Infinity, ...applied.map((migration) => migration.createdAt));
  for (const migration of local) {
    if (!done.has(migration.hash) && migration.when <= newest) problems.push(`${migration.tag} would be skipped: a newer migration is already applied`);
  }
  return problems;
}

/** `db:prepare-preview`'s journal check: when a preview copy's applied migrations no longer fit db/migrations. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { journalProblems, localMigrations } from '../../scripts/migration-journal.mjs';

const local = localMigrations('db/migrations');

describe('preview journal check', () => {
  it('hashes each file as drizzle does: sha256 of its full text, in journal order', () => {
    expect(local.map((m) => m.tag)).toEqual([...local.map((m) => m.tag)].sort());
    expect(local[0]!.hash).toBe(createHash('sha256').update(readFileSync('db/migrations/0001_init.sql', 'utf8')).digest('hex'));
    /* Each file's `when` is later than the one before, or the migrator would skip it. */
    for (let i = 1; i < local.length; i += 1) expect(local[i]!.when).toBeGreaterThan(local[i - 1]!.when);
  });

  it('accepts an empty, a partial and a complete journal', () => {
    expect(journalProblems([], local)).toEqual([]);
    const applied = local.map((m) => ({ hash: m.hash, createdAt: m.when }));
    expect(journalProblems(applied.slice(0, 3), local)).toEqual([]);
    expect(journalProblems(applied, local)).toEqual([]);
  });

  it('flags a rewritten migration and a file that would be skipped', () => {
    const applied = local.slice(0, 4).map((m) => ({ hash: m.hash, createdAt: m.when }));
    /* The pre-merge 0006: other text, applied before 0005 existed. */
    const stale = [...applied, { hash: 'f'.repeat(64), createdAt: 1793606068090 }];
    const problems = journalProblems(stale, local);
    expect(problems.some((p) => p.startsWith('applied migration ffffffffffff'))).toBe(true);
    expect(problems.some((p) => p.startsWith('0005_conversations_explore would be skipped'))).toBe(true);
  });
});

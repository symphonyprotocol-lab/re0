/**
 * The migration journal (`db/migrations/meta/_journal.json`) against the SQL
 * files beside it.
 *
 * `drizzle-kit migrate` applies a journal entry only when its `when` is
 * strictly greater than the `created_at` of the last migration the database
 * recorded (drizzle-orm pg-core dialect: `lastDbMigration.created_at <
 * migration.folderMillis`). An entry stamped at or below the previous one is
 * skipped without an error in every environment that already ran the previous
 * one -- production included -- while `scripts/test-integration.sh` and CI
 * run every `00*.sql` file through psql and apply it. Tests then pass and the
 * deploy fails at runtime on the missing column.
 *
 * From 0058 on the stamps are not `Date.now()` but hand-picked steps of 1e8 ms,
 * and they already lie in the future (0066 is 2026-11-04). Rule for a new
 * migration: its `when` is the previous entry's `when` + 100000000, never
 * `Date.now()`. Two parallel branches that both add a migration must renumber
 * at merge time so the stamps stay strictly increasing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };

const MIGRATIONS = join(process.cwd(), 'db/migrations');
const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
  entries: JournalEntry[];
};
const entries = journal.entries;

/** The stamp step used since 0058; see the header. */
const WHEN_STEP = 100_000_000;

describe('migration journal', () => {
  it('numbers its entries 0, 1, 2, ... with tags that carry the same number', () => {
    entries.forEach((entry, position) => {
      expect(entry.idx).toBe(position);
      expect(entry.tag.slice(0, 4)).toBe(String(position).padStart(4, '0'));
    });
  });

  it('stamps every entry strictly later than the one before, or drizzle skips it', () => {
    for (let i = 1; i < entries.length; i += 1) {
      const previous = entries[i - 1]!;
      const entry = entries[i]!;
      expect(
        entry.when,
        `${entry.tag} (when ${entry.when}) must be later than ${previous.tag} (when ${previous.when})`,
      ).toBeGreaterThan(previous.when);
    }
  });

  it('steps by 1e8 from 0058 on, so a new entry is never stamped with Date.now()', () => {
    const from = entries.findIndex((entry) => entry.tag === '0058_render_config');
    expect(from).toBeGreaterThan(0);
    for (let i = from + 1; i < entries.length; i += 1) {
      expect(entries[i]!.when - entries[i - 1]!.when, entries[i]!.tag).toBe(WHEN_STEP);
    }
  });

  it('has an entry for every SQL file and a SQL file for every entry', () => {
    const files = readdirSync(MIGRATIONS)
      .filter((file) => /^\d{4}_.*\.sql$/.test(file))
      .map((file) => file.replace(/\.sql$/, ''))
      .sort();
    expect(entries.map((entry) => entry.tag).sort()).toEqual(files);
  });
});

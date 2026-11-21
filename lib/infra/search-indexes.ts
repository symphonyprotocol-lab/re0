/**
 * Discover's search indexes (lib/services/explore.ts): HNSW indexes on
 * binary-quantized copies of the vectors -- one per vector slot of `chunk`,
 * and one on the profiles -- and the older half-precision passage indexes.
 *
 * The search reads the binary ones once they are valid, and the
 * half-precision ones until then. A binary copy is 192 bytes against 3 KB
 * (half) or 6 KB (full) per vector: on production's million passages the
 * half-precision index is about 4 GB, more than Neon's local file cache
 * holds, so a first search read some 800 of its pages from storage (1.3 s);
 * the binary one is about a tenth of that and stays cached. Its distance is
 * coarse, so the search reads twice the rows it needs and orders them by
 * the stored vectors (`nearestPassages`): on production vectors that found
 * the same 50 passages as an exact scan.
 *
 * They are not built by a migration. A production deploy applies every
 * pending migration in one transaction with a ten-minute statement limit
 * (scripts/database-cutover.mts); building an HNSW index over every passage
 * there ran past it and rolled the whole release back, and while it ran no
 * passage could be written. Instead `ensureSearchIndexes` builds them with
 * `CREATE INDEX CONCURRENTLY` after that transaction commits (`db:deploy`),
 * or by hand (`db:cutover -- search-indexes`): reads and writes carry on
 * while it runs, and it never fails the deploy.
 *
 * Re-running it is always safe. A valid index is left alone; an INVALID one
 * (an interrupted concurrent build leaves one behind) is dropped and built
 * again; a build that runs out of time is cancelled and its half-built index
 * dropped, so the next run starts clean. A session advisory lock keeps two
 * builds (two deploys, or a deploy and a manual run) from dropping each
 * other's index in progress. Until both of a pair are valid, the search uses
 * what it used before they existed: the half-precision pair, else its exact
 * scan; the profiles, their own full-precision index (a migration's).
 *
 * Plain SQL over one session (`Queryable`): the deploy script, a manual run
 * and the tests share it, and settings and the lock hold across statements.
 */

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const DIMENSIONS = 1536;
const binary = (column: string) => `(binary_quantize("${column}")::bit(${DIMENSIONS})) bit_hamming_ops`;
const half = (column: string) => `(("${column}"::halfvec(${DIMENSIONS})) halfvec_cosine_ops)`;

/** In build order: the binary ones first, which the search prefers (the half-precision pair exists already where it was built before). */
export const SEARCH_INDEXES = [
  { name: 'ree_profile_vector_embedding_bit_idx', table: 'ree_profile_vector', group: 'profile-bit', using: `(${binary('embedding')})` },
  { name: 'chunk_embedding_bit_idx', table: 'chunk', group: 'passage-bit', using: `(${binary('embedding')})` },
  { name: 'chunk_embedding_next_bit_idx', table: 'chunk', group: 'passage-bit', using: `(${binary('embedding_next')})` },
  { name: 'chunk_embedding_half_idx', table: 'chunk', group: 'passage-half', using: half('embedding') },
  { name: 'chunk_embedding_next_half_idx', table: 'chunk', group: 'passage-half', using: half('embedding_next') },
] as const;

export type SearchIndexGroup = (typeof SEARCH_INDEXES)[number]['group'];

export const SEARCH_INDEX_LOCK = 're0:search-indexes';

export type SearchIndexState = 'valid' | 'invalid' | 'missing';

export interface SearchIndexOutcome {
  name: string;
  /** `valid`: nothing to do; `built` / `rebuilt` (an invalid one dropped first); `failed`; `skipped` (another build holds the lock, or no time left). */
  action: 'valid' | 'built' | 'rebuilt' | 'failed' | 'skipped';
  ms: number;
  detail?: string;
}

export interface SearchIndexOptions {
  /** The whole run's time limit; a build still running then is cancelled. */
  budgetMs: number;
  /** `maintenance_work_mem` for the build, only ever raised (HNSW builds far faster when the graph fits in it). */
  memory?: string;
  /** How long to wait for a lock on the table before giving up on an index. */
  lockTimeoutMs?: number;
  log?: (line: string) => void;
}

/** Each index's state: valid (usable by the planner), invalid (left by an interrupted concurrent build, or still being built) or missing. */
export async function searchIndexStates(db: Queryable): Promise<Map<string, SearchIndexState>> {
  const { rows } = await db.query(
    `select c.relname as name, (i.indisvalid and i.indisready) as valid
     from pg_index i join pg_class c on c.oid = i.indexrelid
     where c.relnamespace = 'public'::regnamespace and c.relname = any($1::text[])`,
    [SEARCH_INDEXES.map((index) => index.name)],
  );
  const found = new Map(rows.map((row) => [String(row.name), row.valid === true || row.valid === 't']));
  return new Map(SEARCH_INDEXES.map((index) => [index.name, found.has(index.name) ? (found.get(index.name) ? 'valid' : 'invalid') : 'missing']));
}

/** The index's CREATE statement; the tests build them without CONCURRENTLY (nothing else runs there). */
export function createIndexStatement(index: (typeof SEARCH_INDEXES)[number], { concurrently = true } = {}): string {
  return `create index ${concurrently ? 'concurrently ' : ''}if not exists "${index.name}" on public.${index.table} using hnsw ${index.using}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds whichever search index is missing or invalid; never throws for a failed build (see the file comment). */
export async function ensureSearchIndexes(db: Queryable, options: SearchIndexOptions): Promise<SearchIndexOutcome[]> {
  const log = options.log ?? (() => {});
  const deadline = Date.now() + options.budgetMs;
  const locked = await db.query('select pg_try_advisory_lock(hashtext($1)) as ok', [SEARCH_INDEX_LOCK]);
  if (!(locked.rows[0]?.ok === true || locked.rows[0]?.ok === 't')) {
    log('search indexes: another build holds the lock; leaving them to it');
    return SEARCH_INDEXES.map((index) => ({ name: index.name, action: 'skipped', ms: 0, detail: 'another build holds the lock' }));
  }
  const outcomes: SearchIndexOutcome[] = [];
  try {
    await db.query(`set lock_timeout = ${Math.max(1, Math.trunc(options.lockTimeoutMs ?? 10_000))}`);
    if (options.memory) {
      /* Only ever raised; a value the server refuses leaves its own. */
      await db
        .query(`select set_config('maintenance_work_mem', $1, false) where pg_size_bytes($1) > pg_size_bytes(current_setting('maintenance_work_mem'))`, [options.memory])
        .catch((error: unknown) => log(`search indexes: keeping maintenance_work_mem (${message(error)})`));
    }
    const states = await searchIndexStates(db);
    for (const index of SEARCH_INDEXES) {
      const started = Date.now();
      const state = states.get(index.name)!;
      if (state === 'valid') {
        outcomes.push({ name: index.name, action: 'valid', ms: 0 });
        continue;
      }
      const left = deadline - Date.now();
      if (left < 1_000) {
        outcomes.push({ name: index.name, action: 'skipped', ms: 0, detail: 'no time left' });
        continue;
      }
      try {
        await db.query(`set statement_timeout = ${Math.trunc(left)}`);
        if (state === 'invalid') {
          log(`search indexes: ${index.name} is invalid (an interrupted build); dropping it`);
          await db.query(`drop index concurrently if exists public."${index.name}"`);
        }
        log(`search indexes: building ${index.name} concurrently (up to ${(left / 60_000).toFixed(1)} min)`);
        await db.query(createIndexStatement(index));
        const ms = Date.now() - started;
        outcomes.push({ name: index.name, action: state === 'invalid' ? 'rebuilt' : 'built', ms });
        log(`search indexes: ${index.name} ready in ${Math.round(ms / 1000)} s`);
      } catch (error) {
        outcomes.push({ name: index.name, action: 'failed', ms: Date.now() - started, detail: message(error) });
        log(`search indexes: ${index.name} failed (${message(error)}); search keeps its exact scan until a later run builds it`);
        /* A cancelled concurrent build leaves an invalid index behind: drop it, so writes stop maintaining it and the next run starts clean. */
        await db.query('set statement_timeout = 60000').catch(() => undefined);
        const after = await searchIndexStates(db).catch(() => null);
        if (after?.get(index.name) === 'invalid') {
          await db.query(`drop index concurrently if exists public."${index.name}"`).catch((dropError: unknown) => log(`search indexes: could not drop the invalid ${index.name} (${message(dropError)}); the next run will`));
        }
      }
    }
  } finally {
    await db.query('reset statement_timeout').catch(() => undefined);
    await db.query('reset lock_timeout').catch(() => undefined);
    await db.query('reset maintenance_work_mem').catch(() => undefined);
    await db.query('select pg_advisory_unlock(hashtext($1))', [SEARCH_INDEX_LOCK]).catch(() => undefined);
  }
  return outcomes;
}

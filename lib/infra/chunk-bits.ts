/**
 * Filling `chunk_bit` (db/schema.ts `chunkBit`) for the chunk vectors stored
 * before migration 0079 put its trigger on `chunk`; every write since keeps
 * it current on its own. Run by hand, `db:cutover -- chunk-bits`, never by
 * a deploy: on production's million passages it reads every 6 KB vector
 * once (a random read each on a cold cache), far past the deploy's
 * transaction and its time.
 *
 * Only inserts: nothing in `chunk` is rewritten, so its indexes (two HNSW
 * among them) and its heap take no new row versions. Source by source --
 * public Rees' first, then by Ree -- up to `batch` passages per statement
 * through `chunk_knowledge_idx`, each statement its own transaction, and
 * `pauseMs` of rest per `batch` passages (a small source's statement shares
 * a batch with the next ones'). A passage that already has its row is
 * skipped before its vector is read, so a run stopped halfway (or run
 * twice) picks up where the last one left off; a row the trigger wrote
 * meanwhile is never replaced.
 *
 * Last, one pass over the whole table checks every slot holding a vector
 * in some space against its row, and drops rows no slot backs any more (a
 * slot cleared while its row was being copied). With nothing missing it
 * marks `chunk_bit_backfill`, and Discover ranks a named Ree's passages by
 * their bits from then on (explore.ts `nearestOwnPassage`); otherwise it
 * says how many are missing and leaves the mark alone.
 */
import type { Queryable } from './search-indexes';

const BASE_SPACE = '00000000-0000-0000-0000-000000000000';
const BITS = 'bit(1536)';

export interface ChunkBitOptions {
  /** Passages per statement (1 to 5,000). */
  batch: number;
  /** Rest after each `batch` passages (a small source shares its statement's batch with the next ones), so the compute keeps answering searches. */
  pauseMs: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ChunkBitOutcome {
  inserted: number;
  statements: number;
  /** Rows dropped because no slot backs them any more. */
  dropped: number;
  /** Slots with a vector in a space and no row, after the run. */
  missing: number;
  completed: boolean;
  ms: number;
}

/* Each slot's rows from `chunk c`, skipping the ones already there. */
const slotRows = [
  `select c.id, 0::smallint, coalesce(c.embedding_space, '${BASE_SPACE}'::uuid), c.ree_id, c.knowledge_id, binary_quantize(c.embedding)::${BITS}
    from chunk c where c.knowledge_id = $1 and c.ordinal >= $2 and c.ordinal < $3 and c.embedding is not null
      and not exists (select 1 from chunk_bit b where b.chunk_id = c.id and b.slot = 0)`,
  `select c.id, 1::smallint, c.embedding_next_space, c.ree_id, c.knowledge_id, binary_quantize(c.embedding_next)::${BITS}
    from chunk c where c.knowledge_id = $1 and c.ordinal >= $2 and c.ordinal < $3 and c.embedding_next is not null and c.embedding_next_space is not null
      and not exists (select 1 from chunk_bit b where b.chunk_id = c.id and b.slot = 1)`,
];

/** Slots holding a vector in some space with no row (`missing`), over the whole table; reads no vector. */
export const MISSING_SQL = `select count(*)::int as missing from chunk c
  cross join lateral (values (0::smallint, c.embedding is not null), (1::smallint, c.embedding_next is not null and c.embedding_next_space is not null)) s(slot, filled)
  where s.filled and not exists (select 1 from chunk_bit b where b.chunk_id = c.id and b.slot = s.slot)`;

/* Rows whose slot no longer holds a vector in that space (or moved Ree or source). */
const STALE_SQL = `delete from chunk_bit b using chunk c where c.id = b.chunk_id and (
  c.ree_id <> b.ree_id or c.knowledge_id <> b.knowledge_id
  or (b.slot = 0 and (c.embedding is null or coalesce(c.embedding_space, '${BASE_SPACE}'::uuid) <> b.space))
  or (b.slot = 1 and (c.embedding_next is null or c.embedding_next_space is distinct from b.space)))`;

/** Whether the backfill has been marked complete. */
export async function chunkBitsComplete(db: Queryable): Promise<boolean> {
  const { rows } = await db.query('select completed_at is not null as done from chunk_bit_backfill');
  return rows[0]?.done === true;
}

export async function backfillChunkBits(db: Queryable, options: ChunkBitOptions): Promise<ChunkBitOutcome> {
  const started = Date.now();
  const batch = Math.min(5_000, Math.max(1, Math.trunc(options.batch)));
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /* Every source that holds passages: public Rees' first, then Ree by Ree. */
  const { rows: sources } = await db.query(`
    select k.id, k.ree_id, max(c.ordinal)::int as last, count(*)::int as passages
    from knowledge k join chunk c on c.knowledge_id = k.id
    left join ree r on r.id = k.ree_id
    group by k.id, k.ree_id, r.is_public, r.is_published, r.moderated_at, r.deleted_at
    order by (coalesce(r.is_public and r.is_published and r.moderated_at is null and r.deleted_at is null, false)) desc, k.ree_id, k.id`);
  const total = sources.reduce((sum, row) => sum + Number(row.passages), 0);
  log(`chunk bits: ${sources.length} sources, ${total} passages, ${batch} per statement, ${options.pauseMs} ms between`);
  let inserted = 0;
  let statements = 0;
  let seen = 0;
  let sincePause = 0;
  let lastLog = Date.now();
  for (const source of sources) {
    const last = Number(source.last);
    for (let from = 0; from <= last; from += batch) {
      const { rows } = await db.query(
        `with added as (insert into chunk_bit (chunk_id, slot, space, ree_id, knowledge_id, bits)
          ${slotRows.join(' union all ')}
          on conflict (chunk_id, slot) do nothing returning 1)
        select count(*)::int as n from added`,
        [source.id, from, from + batch],
      );
      inserted += Number(rows[0]?.n ?? 0);
      statements += 1;
      sincePause += Math.min(batch, last + 1 - from);
      if (sincePause >= batch) {
        sincePause = 0;
        if (options.pauseMs > 0) await sleep(options.pauseMs);
      }
    }
    seen += Number(source.passages);
    if (Date.now() - lastLog > 30_000) {
      log(`chunk bits: ${seen}/${total} passages looked at, ${inserted} rows added (${Math.round((Date.now() - started) / 1000)} s)`);
      lastLog = Date.now();
    }
  }
  const dropped = Number((await db.query(`with gone as (${STALE_SQL} returning 1) select count(*)::int as n from gone`)).rows[0]?.n ?? 0);
  const missing = Number((await db.query(MISSING_SQL)).rows[0]?.missing ?? 0);
  if (missing === 0) await db.query('update chunk_bit_backfill set completed_at = now()');
  const outcome = { inserted, statements, dropped, missing, completed: missing === 0, ms: Date.now() - started };
  log(`chunk bits: ${inserted} rows added in ${statements} statements, ${dropped} dropped, ${missing} missing -> ${outcome.completed ? 'complete' : 'NOT complete, run it again'} (${Math.round(outcome.ms / 1000)} s)`);
  return outcome;
}

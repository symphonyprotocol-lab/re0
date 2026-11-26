/**
 * Knowledge storage, billed to the knowledge-base owner
 * (docs/audit/credit-import-audit.md P4): every source row from its creation
 * until it is purged -- the uploaded file in Blob, and in the database its
 * text, children, activity and passages with their vectors -- at the
 * console's storage rates (`lib/services/infra-pricing.ts`), per byte and
 * millisecond. Billing stops when the row's Ree is deleted: the owner can no
 * longer reach it, and the next trash purge removes it (`purgeTrash`).
 * Billing starts at the release of storage billing for rows that existed
 * then (migration 0038 sets their `storage_billed_at`), never earlier. Time is priced at the rate that applied then: an interval a
 * rate change falls inside is split there, so a change never reprices
 * storage already accrued, and applies from the moment it was saved.
 *
 * `accrueStorage` adds what the rows cost since they were last billed
 * (`knowledge.storage_billed_at`) to the owner's `storage_accrual` and charges
 * the credits that brings due: `ceil(total cost) - charged so far`, so the
 * total charged is never below the cost and never more than one credit
 * above it. The daily cron (`/api/cron/charge-storage`) runs it for every
 * owner; purging the trash runs it for the rows it is about to delete, in
 * the same transaction, so no stored second goes unbilled. What a balance
 * cannot cover is owed (`takeOrOwe`).
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import { chunkOverheadBytes, storageCostPico } from '@/lib/domain/infra-cost';
import { picoCredits } from '@/lib/domain/provider-cost';
import { infraRateSegments } from '@/lib/services/infra-pricing';
import { db, schema, type Tx } from '@/lib/infra/db';
import { takeOrOwe } from '@/lib/services/credits';

interface Measured {
  userId: string;
  id: string;
  blobBytes: bigint;
  /** Database bytes before the passages' per-row overhead (which depends on the rate in effect). */
  databaseBytes: bigint;
  chunks: bigint;
  /** Epoch ms the row was last billed up to (rounded down, so never a millisecond short). */
  since: number;
  /** Epoch ms the row stops being billed: its Ree's deletion, if that came first (rounded up). */
  until: number | null;
}

export interface StorageCharge {
  userId: string;
  /** Pico-dollars this accrual added. */
  costPico: bigint;
  /** Credits charged now (taken plus owed). */
  credits: number;
}

/** The rows' stored bytes and when each was last billed, locked for the update that follows. */
async function measure(tx: Tx, where: SQL): Promise<Measured[]> {
  const rows = await tx.execute<{ user_id: string; id: string; blob_bytes: string; database_bytes: string; chunks: string; since: string; until: string | null }>(sql`
    select r.owner_id as user_id, k.id,
      (case when k.kind in ('document', 'audio') and k.source like 'knowledge/%' then coalesce(k.file_size, 0) else 0 end)::text as blob_bytes,
      (coalesce(octet_length(k.content), 0) + octet_length(k.children::text) + octet_length(k.activity::text)
        + coalesce((select sum(octet_length(c.content)) from ${schema.chunk} c where c.knowledge_id = k.id), 0))::text as database_bytes,
      (select count(*) from ${schema.chunk} c where c.knowledge_id = k.id)::text as chunks,
      floor(extract(epoch from coalesce(k.storage_billed_at, k.created_at)) * 1000)::bigint::text as since,
      ceil(extract(epoch from r.deleted_at) * 1000)::bigint::text as until
    from ${schema.knowledge} k join ${schema.ree} r on r.id = k.ree_id
    where ${where}
    order by k.id
    for update of k`);
  return rows.rows.map((row) => ({
    userId: row.user_id, id: row.id, blobBytes: BigInt(row.blob_bytes), databaseBytes: BigInt(row.database_bytes), chunks: BigInt(row.chunks), since: Number(row.since),
    until: row.until === null ? null : Number(row.until),
  }));
}

/**
 * Bills the matching rows' storage up to `now`, in the caller's transaction.
 * `where` selects knowledge rows (alias `k`).
 */
export async function accrueStorage(tx: Tx, where: SQL, now = new Date()): Promise<StorageCharge[]> {
  const rows = await measure(tx, where);
  if (rows.length === 0) return [];
  const end = now.getTime();
  const segments = await infraRateSegments(tx, rows.reduce((first, row) => Math.min(first, row.since), end), end);
  /* Per owner, per rate segment: byte-milliseconds of Blob and of database. */
  const perUser = new Map<string, { blob: bigint; database: bigint }[]>();
  for (const row of rows) {
    const sums = perUser.get(row.userId) ?? segments.map(() => ({ blob: 0n, database: 0n }));
    const stop = Math.min(end, row.until ?? end);
    segments.forEach((segment, at) => {
      const ms = BigInt(Math.max(0, Math.min(stop, segment.to) - Math.max(row.since, segment.from)));
      if (ms === 0n) return;
      sums[at]!.blob += row.blobBytes * ms;
      sums[at]!.database += (row.databaseBytes + row.chunks * BigInt(chunkOverheadBytes(segment.rates))) * ms;
    });
    perUser.set(row.userId, sums);
  }
  /*
   * Billed up to `now`, or to the Ree's deletion; never moved back (a row
   * created, or billed by the purge, after this run's `now` keeps its later mark).
   */
  await tx.execute(sql`
    update ${schema.knowledge} k set storage_billed_at = greatest(coalesce(k.storage_billed_at, k.created_at), least(${now}::timestamptz, coalesce(r.deleted_at, ${now}::timestamptz)))
    from ${schema.ree} r
    where r.id = k.ree_id and k.id in (${sql.join(rows.map((row) => sql`${row.id}::uuid`), sql`, `)})`);
  const charges: StorageCharge[] = [];
  for (const [userId, sums] of perUser) {
    const costPico = sums.reduce((sum, part, at) => sum + storageCostPico(part.blob, part.database, segments[at]!.rates), 0n);
    await tx.insert(schema.storageAccrual).values({ userId, updatedAt: now }).onConflictDoNothing();
    const [accrual] = await tx.select().from(schema.storageAccrual).where(eq(schema.storageAccrual.userId, userId)).for('update');
    const total = BigInt(accrual!.costPico) + costPico;
    const due = picoCredits(total) - accrual!.chargedCredits;
    if (due > 0) await takeOrOwe(tx, { userId, amount: due, reason: 'storage_charge', refId: null, note: 'Knowledge storage' }, now);
    await tx.update(schema.storageAccrual)
      .set({ costPico: total.toString(), chargedCredits: accrual!.chargedCredits + Math.max(0, due), updatedAt: now })
      .where(eq(schema.storageAccrual.userId, userId));
    charges.push({ userId, costPico, credits: Math.max(0, due) });
  }
  return charges;
}

/** Storage of one owner's knowledge, every row of every Ree of theirs. */
export function ownedBy(userId: string): SQL {
  return sql`r.owner_id = ${userId}`;
}

/** Specific rows (the batch the trash purge is about to delete). */
export function rowsIn(ids: readonly string[]): SQL {
  return ids.length === 0 ? sql`false` : sql`k.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`;
}

/**
 * The daily run: every owner with knowledge not billed for at least
 * `minimumSeconds` (and not already billed up to its Ree's deletion), one
 * transaction each, the longest unbilled first, in pages of `limit` until
 * none is left or `budgetMs` is spent -- so owners past the first page are
 * reached the same day, and those a run could not reach are first the next
 * day. Overlapping runs are safe: an owner's rows are locked and re-read in
 * `accrueStorage`, so a second run finds them already billed and adds nothing.
 */
export async function chargeStorage(now = new Date(), { budgetMs = 240_000, minimumSeconds = 3600, limit = 1000 } = {}): Promise<StorageCharge[]> {
  const started = Date.now();
  const cutoff = new Date(now.getTime() - minimumSeconds * 1000);
  const charged: StorageCharge[] = [];
  /* A billed owner no longer matches (billed up to `now`); one whose billing failed is skipped for the rest of the run. */
  const failed = new Set<string>();
  const seen = new Set<string>();
  for (;;) {
    if (Date.now() - started > budgetMs) break;
    const skip = [...failed];
    const page = await db().execute<{ user_id: string }>(sql`
      select r.owner_id as user_id
      from ${schema.knowledge} k join ${schema.ree} r on r.id = k.ree_id
      where coalesce(k.storage_billed_at, k.created_at) < ${cutoff}
        and (r.deleted_at is null or coalesce(k.storage_billed_at, k.created_at) < r.deleted_at)
        ${skip.length ? sql`and r.owner_id not in (${sql.join(skip.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
      group by r.owner_id
      order by min(coalesce(k.storage_billed_at, k.created_at)), r.owner_id
      limit ${limit}`);
    /* Nothing new on the page (a `minimumSeconds` of 0 matches what was just billed): done. */
    if (page.rows.every((row) => seen.has(row.user_id))) break;
    for (const { user_id: userId } of page.rows) {
      if (Date.now() - started > budgetMs) break;
      if (seen.has(userId)) continue;
      seen.add(userId);
      try {
        charged.push(...(await db().transaction((tx) => accrueStorage(tx, ownedBy(userId), now))));
      } catch (error) {
        failed.add(userId);
        console.warn(`storage billing failed user=${userId}`, error instanceof Error ? error.message : error);
      }
    }
  }
  return charged;
}

/** What a user's storage has cost and been charged so far. */
export async function storageAccrualOf(userId: string): Promise<{ costPico: bigint; chargedCredits: number } | null> {
  const [row] = await db().select().from(schema.storageAccrual).where(eq(schema.storageAccrual.userId, userId));
  return row ? { costPico: BigInt(row.costPico), chargedCredits: row.chargedCredits } : null;
}

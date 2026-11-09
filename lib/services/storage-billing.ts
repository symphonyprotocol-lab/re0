/**
 * Knowledge storage, billed to the knowledge-base owner
 * (docs/audit/credit-import-audit.md P4): every source row from its creation
 * until it is purged -- the uploaded file in Blob, and in the database its
 * text, children, activity and passages with their vectors -- at
 * `INFRA_COST_RATES`, per byte-second.
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
import { asc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { CHUNK_OVERHEAD_BYTES, picoCredits, storageCostPico } from '@/lib/domain/provider-cost';
import { db, schema, type Tx } from '@/lib/infra/db';
import { takeOrOwe } from '@/lib/services/credits';

interface Measured {
  userId: string;
  id: string;
  blobBytes: string;
  databaseBytes: string;
  seconds: string;
}

export interface StorageCharge {
  userId: string;
  /** Pico-dollars this accrual added. */
  costPico: bigint;
  /** Credits charged now (taken plus owed). */
  credits: number;
}

/** The rows' stored bytes and the seconds since each was last billed, locked for the update that follows. */
async function measure(tx: Tx, where: SQL, now: Date): Promise<Measured[]> {
  const rows = await tx.execute<{ user_id: string; id: string; blob_bytes: string; database_bytes: string; seconds: string }>(sql`
    select r.owner_id as user_id, k.id,
      (case when k.kind in ('document', 'audio') and k.source like 'knowledge/%' then coalesce(k.file_size, 0) else 0 end)::text as blob_bytes,
      (coalesce(octet_length(k.content), 0) + octet_length(k.children::text) + octet_length(k.activity::text)
        + coalesce((select sum(octet_length(c.content) + ${CHUNK_OVERHEAD_BYTES}) from ${schema.chunk} c where c.knowledge_id = k.id), 0))::text as database_bytes,
      greatest(0, ceil(extract(epoch from (${now.toISOString()}::timestamptz - coalesce(k.storage_billed_at, k.created_at)))))::bigint::text as seconds
    from ${schema.knowledge} k join ${schema.ree} r on r.id = k.ree_id
    where ${where}
    order by k.id
    for update of k`);
  return rows.rows.map((row) => ({ userId: row.user_id, id: row.id, blobBytes: row.blob_bytes, databaseBytes: row.database_bytes, seconds: row.seconds }));
}

/**
 * Bills the matching rows' storage up to `now`, in the caller's transaction.
 * `where` selects knowledge rows (alias `k`).
 */
export async function accrueStorage(tx: Tx, where: SQL, now = new Date()): Promise<StorageCharge[]> {
  const rows = await measure(tx, where, now);
  if (rows.length === 0) return [];
  const perUser = new Map<string, { blob: bigint; database: bigint }>();
  for (const row of rows) {
    const seconds = BigInt(row.seconds);
    const sum = perUser.get(row.userId) ?? { blob: 0n, database: 0n };
    sum.blob += BigInt(row.blobBytes) * seconds;
    sum.database += BigInt(row.databaseBytes) * seconds;
    perUser.set(row.userId, sum);
  }
  await tx.update(schema.knowledge).set({ storageBilledAt: now }).where(inArray(schema.knowledge.id, rows.map((row) => row.id)));
  const charges: StorageCharge[] = [];
  for (const [userId, sum] of perUser) {
    const costPico = storageCostPico(sum.blob, sum.database);
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
 * `minimumSeconds`, one transaction each, oldest first, within `budgetMs`.
 */
export async function chargeStorage(now = new Date(), { budgetMs = 240_000, minimumSeconds = 3600, limit = 1000 } = {}): Promise<StorageCharge[]> {
  const started = Date.now();
  const cutoff = new Date(now.getTime() - minimumSeconds * 1000);
  const owners = await db()
    .selectDistinct({ userId: schema.ree.ownerId })
    .from(schema.knowledge)
    .innerJoin(schema.ree, eq(schema.ree.id, schema.knowledge.reeId))
    .where(lt(sql`coalesce(${schema.knowledge.storageBilledAt}, ${schema.knowledge.createdAt})`, cutoff))
    .orderBy(asc(schema.ree.ownerId))
    .limit(limit);
  const charged: StorageCharge[] = [];
  for (const { userId } of owners) {
    if (Date.now() - started > budgetMs) break;
    charged.push(...(await db().transaction((tx) => accrueStorage(tx, ownedBy(userId), now))));
  }
  return charged;
}

/** What a user's storage has cost and been charged so far. */
export async function storageAccrualOf(userId: string): Promise<{ costPico: bigint; chargedCredits: number } | null> {
  const [row] = await db().select().from(schema.storageAccrual).where(eq(schema.storageAccrual.userId, userId));
  return row ? { costPico: BigInt(row.costPico), chargedCredits: row.chargedCredits } : null;
}

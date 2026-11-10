/**
 * The console's redeem codes (docs/design/redeem-codes.md 3, 6.1): creating
 * a batch and its codes, the batch list and page, editing a batch's name,
 * note, status and expiry, turning single codes off and on, revealing and
 * exporting codes, and a batch's redemptions. Every write, every reveal and
 * every export of plaintext codes is audited.
 */
import { and, asc, count, desc, eq, gte, ilike, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { REDEEM } from '@/lib/constants';
import { periodStart, type RedeemBatchesView, type RedeemBatchView } from '@/lib/domain/admin-lists';
import { clampPage, isUuid, likePattern, type ListResult } from '@/lib/domain/list';
import {
  batchCredits,
  batchPhase,
  codeLast4,
  displayCode,
  normalizeCode,
  parseBatchInput,
  parseBatchUpdate,
  randomCode,
  type BatchPhase,
  type RedeemKind,
} from '@/lib/domain/redeem';
import { openCredential, sealCredential } from '@/lib/infra/crypto/credentials';
import { db, schema, type Tx } from '@/lib/infra/db';
import { AdminInputError, audit, assertConsole, type Administrator } from '@/lib/services/admin';
import { currentUnitCredits } from '@/lib/services/pricing';
import { codeDigest } from '@/lib/services/redeem';

type BatchRow = typeof schema.redeemBatch.$inferSelect;

export interface BatchSummary {
  id: string;
  name: string;
  note: string | null;
  kind: RedeemKind;
  planMonths: number | null;
  packQuantity: number | null;
  credits: number;
  codePrefix: string | null;
  codeCount: number;
  maxRedemptions: number | null;
  perUserLimit: number;
  startsAt: Date;
  expiresAt: Date | null;
  status: 'active' | 'disabled';
  phase: BatchPhase;
  redemptionCount: number;
  /** Uses all codes allow together; null when unlimited. */
  capacity: number | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: Date;
}

function summary(row: BatchRow, createdByName: string | null, now: Date): BatchSummary {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    kind: row.kind,
    planMonths: row.planMonths,
    packQuantity: row.packQuantity,
    credits: row.credits,
    codePrefix: row.codePrefix,
    codeCount: row.codeCount,
    maxRedemptions: row.maxRedemptions,
    perUserLimit: row.perUserLimit,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    status: row.status,
    phase: batchPhase(row, now),
    redemptionCount: row.redemptionCount,
    capacity: row.maxRedemptions === null ? null : row.maxRedemptions * row.codeCount,
    createdBy: row.createdBy,
    createdByName,
    createdAt: row.createdAt,
  };
}

/* ---------------------------------------------------------------- create */

async function insertCodes(tx: Tx, batchId: string, codes: string[], maxRedemptions: number | null, now: Date): Promise<string[]> {
  const rows = await Promise.all(
    codes.map(async (code) => {
      const normalized = normalizeCode(code)!;
      return {
        batchId,
        codeDigest: await codeDigest(normalized),
        codeSealed: await sealCredential(code, 'redeem_code'),
        codeLast4: codeLast4(normalized),
        maxRedemptions,
        createdAt: now,
      };
    }),
  );
  const inserted = await tx
    .insert(schema.redeemCode)
    .values(rows)
    .onConflictDoNothing({ target: schema.redeemCode.codeDigest })
    .returning({ digest: schema.redeemCode.codeDigest });
  const kept = new Set(inserted.map((row) => row.digest));
  return codes.filter((_, index) => kept.has(rows[index]!.codeDigest));
}

/**
 * `POST /api/admin/redeem-batches`: the batch and every code in one
 * transaction. A random code that collides with an existing one (never
 * expected at 59 bits) is drawn again; a custom code that is taken is
 * refused. Returns the plaintext codes for the console to offer as CSV.
 */
export async function createBatch(administratorId: string, raw: Record<string, unknown>, now = new Date()): Promise<{ batch: BatchSummary; codes: string[] }> {
  const input = parseBatchInput(raw, now);
  if ('error' in input) throw new AdminInputError(input.error);
  return db().transaction(async (tx) => {
    const credits = batchCredits(input, await currentUnitCredits(tx, input.kind));
    const [batch] = await tx
      .insert(schema.redeemBatch)
      .values({
        name: input.name,
        note: input.note,
        kind: input.kind,
        planMonths: input.planMonths,
        packQuantity: input.packQuantity,
        credits,
        codePrefix: input.prefix,
        codeCount: input.codeCount,
        maxRedemptions: input.maxRedemptions,
        perUserLimit: input.perUserLimit,
        startsAt: input.startsAt,
        expiresAt: input.expiresAt,
        createdBy: administratorId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const codes: string[] = [];
    if (input.customCode) {
      const kept = await insertCodes(tx, batch!.id, [input.customCode], input.maxRedemptions, now);
      if (!kept.length) throw new AdminInputError('custom_code_taken');
      codes.push(...kept);
    } else {
      for (let attempts = 0; codes.length < input.codeCount; attempts += 1) {
        if (attempts > input.codeCount / REDEEM.insertChunk + 10) throw new Error('could not draw enough unique redeem codes');
        const want = Math.min(REDEEM.insertChunk, input.codeCount - codes.length);
        const drawn = Array.from({ length: want }, () => displayCode(randomCode(), input.prefix));
        codes.push(...(await insertCodes(tx, batch!.id, [...new Set(drawn)], input.maxRedemptions, now)));
      }
    }
    await audit(tx, {
      administratorId,
      action: 'redeem.batch.create',
      target: batch!.id,
      after: {
        name: batch!.name,
        kind: batch!.kind,
        planMonths: batch!.planMonths,
        packQuantity: batch!.packQuantity,
        credits,
        codeCount: batch!.codeCount,
        maxRedemptions: batch!.maxRedemptions,
        perUserLimit: batch!.perUserLimit,
        startsAt: batch!.startsAt,
        expiresAt: batch!.expiresAt,
        prefix: batch!.codePrefix,
        custom: Boolean(input.customCode),
      },
    });
    return { batch: summary(batch!, null, now), codes };
  });
}

/* ------------------------------------------------------------------ lists */

function phaseCondition(phase: RedeemBatchesView['status'], now: Date): SQL | undefined {
  const b = schema.redeemBatch;
  if (phase === 'disabled') return eq(b.status, 'disabled');
  if (phase === 'scheduled') return and(eq(b.status, 'active'), sql`${b.startsAt} > ${now.toISOString()}::timestamptz`);
  if (phase === 'expired') return and(eq(b.status, 'active'), lte(b.startsAt, now), isNotNull(b.expiresAt), lte(b.expiresAt, now));
  if (phase === 'active') return and(eq(b.status, 'active'), lte(b.startsAt, now), or(isNull(b.expiresAt), sql`${b.expiresAt} > ${now.toISOString()}::timestamptz`));
  return undefined;
}

/** A search for a whole code finds its batch by digest; four characters also try codes' last four. */
async function batchSearch(q: string): Promise<SQL | undefined> {
  if (!q) return undefined;
  const conditions: SQL[] = [ilike(schema.redeemBatch.name, likePattern(q))];
  const normalized = normalizeCode(q);
  if (normalized) {
    const digest = await codeDigest(normalized);
    conditions.push(sql`${schema.redeemBatch.id} in (select batch_id from ${schema.redeemCode} where code_digest = ${digest})`);
  }
  const tail = q.replace(/[\s-]/g, '').toUpperCase();
  if (/^[A-Z0-9]{4}$/.test(tail)) conditions.push(sql`${schema.redeemBatch.id} in (select batch_id from ${schema.redeemCode} where code_last4 = ${tail})`);
  if (isUuid(q)) conditions.push(eq(schema.redeemBatch.id, q));
  return or(...conditions);
}

export async function listBatches(administrator: Administrator, view: RedeemBatchesView, options: { all?: boolean } = {}, now = new Date()): Promise<ListResult<BatchSummary>> {
  assertConsole(administrator);
  const conditions: SQL[] = [];
  const phase = phaseCondition(view.status, now);
  if (phase) conditions.push(phase);
  if (view.kind !== 'all') conditions.push(eq(schema.redeemBatch.kind, view.kind));
  const since = periodStart(view.period, now);
  if (since) conditions.push(gte(schema.redeemBatch.createdAt, since));
  const search = await batchSearch(view.q);
  if (search) conditions.push(search);
  const where = conditions.length ? and(...conditions) : undefined;
  const database = db();
  const [counted] = await database.select({ total: count() }).from(schema.redeemBatch).where(where);
  const total = counted?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  let query = database
    .select({ batch: schema.redeemBatch, createdByName: schema.administrator.name })
    .from(schema.redeemBatch)
    .leftJoin(schema.administrator, eq(schema.administrator.id, schema.redeemBatch.createdBy))
    .where(where)
    .orderBy(view.sort === 'oldest' ? asc(schema.redeemBatch.createdAt) : desc(schema.redeemBatch.createdAt), asc(schema.redeemBatch.id))
    .$dynamic();
  if (!options.all) query = query.limit(view.size).offset((page - 1) * view.size);
  const rows = await query;
  return { items: rows.map((row) => summary(row.batch, row.createdByName, now)), total, page, size: view.size };
}

/** The summary cards above the list, filters ignored. */
export async function batchCounts(administrator: Administrator, now = new Date()) {
  assertConsole(administrator);
  const b = schema.redeemBatch;
  const [row] = await db()
    .select({
      batches: count(),
      active: sql<number>`count(*) filter (where ${phaseCondition('active', now)})::int`,
      codes: sql<number>`coalesce(sum(${b.codeCount}), 0)::bigint`,
      redemptions: sql<number>`coalesce(sum(${b.redemptionCount}), 0)::bigint`,
    })
    .from(b);
  return { batches: row?.batches ?? 0, active: Number(row?.active ?? 0), codes: Number(row?.codes ?? 0), redemptions: Number(row?.redemptions ?? 0) };
}

export async function getBatch(administrator: Administrator, id: string, now = new Date()) {
  assertConsole(administrator);
  return batchDetail(id, now);
}

async function batchDetail(id: string, now = new Date()) {
  if (!isUuid(id)) return null;
  const database = db();
  const [row] = await database
    .select({ batch: schema.redeemBatch, createdByName: schema.administrator.name })
    .from(schema.redeemBatch)
    .leftJoin(schema.administrator, eq(schema.administrator.id, schema.redeemBatch.createdBy))
    .where(eq(schema.redeemBatch.id, id))
    .limit(1);
  if (!row) return null;
  const c = schema.redeemCode;
  const [stats] = await database
    .select({
      usedUp: sql<number>`count(*) filter (where ${c.maxRedemptions} is not null and ${c.redemptionCount} >= ${c.maxRedemptions})::int`,
      disabled: sql<number>`count(*) filter (where ${c.status} = 'disabled')::int`,
      touched: sql<number>`count(*) filter (where ${c.redemptionCount} > 0)::int`,
    })
    .from(c)
    .where(eq(c.batchId, id));
  const [users] = await database
    .select({ n: sql<number>`count(distinct ${schema.redeemRedemption.userId})::int` })
    .from(schema.redeemRedemption)
    .where(eq(schema.redeemRedemption.batchId, id));
  return {
    ...summary(row.batch, row.createdByName, now),
    stats: { usedUp: stats?.usedUp ?? 0, disabled: stats?.disabled ?? 0, touched: stats?.touched ?? 0, users: users?.n ?? 0 },
  };
}
export type BatchDetail = NonNullable<Awaited<ReturnType<typeof getBatch>>>;

export interface CodeRow {
  id: string;
  last4: string;
  maxRedemptions: number | null;
  redemptionCount: number;
  status: 'active' | 'disabled';
  lastRedeemedAt: Date | null;
  createdAt: Date;
}

async function codeConditions(batchId: string, view: RedeemBatchView): Promise<SQL[]> {
  const c = schema.redeemCode;
  const conditions: SQL[] = [eq(c.batchId, batchId)];
  if (view.status === 'disabled') conditions.push(eq(c.status, 'disabled'));
  if (view.status === 'used_up') conditions.push(sql`${c.maxRedemptions} is not null and ${c.redemptionCount} >= ${c.maxRedemptions}`);
  if (view.status === 'available') conditions.push(eq(c.status, 'active'), sql`(${c.maxRedemptions} is null or ${c.redemptionCount} < ${c.maxRedemptions})`);
  if (view.q) {
    const normalized = normalizeCode(view.q);
    const tail = view.q.replace(/[\s-]/g, '').toUpperCase().slice(-4);
    const options: SQL[] = [eq(c.codeLast4, tail)];
    if (normalized) options.push(eq(c.codeDigest, await codeDigest(normalized)));
    conditions.push(or(...options)!);
  }
  return conditions;
}

/** A batch's codes, masked (`····7KQ2`). */
export async function listCodes(administrator: Administrator, batchId: string, view: RedeemBatchView): Promise<ListResult<CodeRow>> {
  assertConsole(administrator);
  const where = and(...(await codeConditions(batchId, view)));
  const database = db();
  const [counted] = await database.select({ total: count() }).from(schema.redeemCode).where(where);
  const total = counted?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  const rows = await database
    .select()
    .from(schema.redeemCode)
    .where(where)
    .orderBy(asc(schema.redeemCode.createdAt), asc(schema.redeemCode.id))
    .limit(view.size)
    .offset((page - 1) * view.size);
  return {
    items: rows.map((row) => ({
      id: row.id,
      last4: row.codeLast4,
      maxRedemptions: row.maxRedemptions,
      redemptionCount: row.redemptionCount,
      status: row.status,
      lastRedeemedAt: row.lastRedeemedAt,
      createdAt: row.createdAt,
    })),
    total,
    page,
    size: view.size,
  };
}

export interface CodeExportRow extends CodeRow {
  code: string;
}

/** Every code of the batch the view matches, in plaintext: audited as an export. All or nothing: one code that will not open fails it. */
export async function exportCodes(administratorId: string, batchId: string, view: RedeemBatchView): Promise<{ batch: BatchDetail; rows: CodeExportRow[] }> {
  const batch = await batchDetail(batchId);
  if (!batch) throw new AdminInputError('not_found');
  const rows = await db()
    .select()
    .from(schema.redeemCode)
    .where(and(...(await codeConditions(batchId, view))))
    .orderBy(asc(schema.redeemCode.createdAt), asc(schema.redeemCode.id));
  const opened = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      code: await openCredential(row.codeSealed, 'redeem_code'),
      last4: row.codeLast4,
      maxRedemptions: row.maxRedemptions,
      redemptionCount: row.redemptionCount,
      status: row.status,
      lastRedeemedAt: row.lastRedeemedAt,
      createdAt: row.createdAt,
    })),
  );
  /* A code that will not open (ADMIN_SECRET_KEY changed) fails the export, as "显示" does, rather than writing blank codes. */
  if (opened.some((row) => row.code === null)) throw new AdminInputError('sealed');
  await audit(db(), { administratorId, action: 'redeem.batch.export', target: batchId, after: { codes: opened.length, status: view.status, q: view.q || null } });
  return { batch, rows: opened.map((row) => ({ ...row, code: row.code! })) };
}

/** One code in plaintext, for the console's "显示": audited. */
export async function revealCode(administratorId: string, codeId: string): Promise<{ code: string }> {
  if (!isUuid(codeId)) throw new AdminInputError('not_found');
  const [row] = await db().select().from(schema.redeemCode).where(eq(schema.redeemCode.id, codeId)).limit(1);
  if (!row) throw new AdminInputError('not_found');
  const code = await openCredential(row.codeSealed, 'redeem_code');
  if (!code) throw new AdminInputError('sealed');
  await audit(db(), { administratorId, action: 'redeem.code.reveal', target: row.batchId, after: { code: row.id, last4: row.codeLast4 } });
  return { code };
}

/* ------------------------------------------------------------------ edits */

/** `PATCH /api/admin/redeem-batches/[id]`: name, note, status, expiry. Target and limits are fixed at creation. */
export async function updateBatch(administratorId: string, id: string, raw: Record<string, unknown>, now = new Date()): Promise<BatchDetail> {
  if (!isUuid(id)) throw new AdminInputError('not_found');
  await db().transaction(async (tx) => {
    const [batch] = await tx.select().from(schema.redeemBatch).where(eq(schema.redeemBatch.id, id)).for('update');
    if (!batch) throw new AdminInputError('not_found');
    const update = parseBatchUpdate(raw, batch, now);
    if ('error' in update) throw new AdminInputError(update.error);
    if (!Object.keys(update).length) return;
    await tx.update(schema.redeemBatch).set({ ...update, updatedAt: now }).where(eq(schema.redeemBatch.id, id));
    const before = Object.fromEntries(Object.keys(update).map((key) => [key, batch[key as keyof typeof update]]));
    await audit(tx, { administratorId, action: 'redeem.batch.update', target: id, before, after: update });
  });
  return (await batchDetail(id, now))!;
}

/** `PATCH /api/admin/redeem-codes/[id]` `{ status }`: one code off or back on. */
export async function setCodeStatus(administratorId: string, codeId: string, status: unknown): Promise<{ id: string; status: 'active' | 'disabled' }> {
  if (status !== 'active' && status !== 'disabled') throw new AdminInputError('invalid_status');
  if (!isUuid(codeId)) throw new AdminInputError('not_found');
  return db().transaction(async (tx) => {
    const [row] = await tx.select().from(schema.redeemCode).where(eq(schema.redeemCode.id, codeId)).for('update');
    if (!row) throw new AdminInputError('not_found');
    if (row.status !== status) {
      await tx.update(schema.redeemCode).set({ status }).where(eq(schema.redeemCode.id, codeId));
      await audit(tx, {
        administratorId,
        action: status === 'disabled' ? 'redeem.code.disable' : 'redeem.code.enable',
        target: row.batchId,
        before: { code: row.id, last4: row.codeLast4, status: row.status },
        after: { code: row.id, last4: row.codeLast4, status },
      });
    }
    return { id: codeId, status };
  });
}

/* ------------------------------------------------------------ redemptions */

export interface RedemptionRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  last4: string;
  kind: RedeemKind;
  credits: number;
  planMonths: number | null;
  planStartsAt: Date | null;
  planEndsAt: Date | null;
  createdAt: Date;
}

export async function listRedemptions(administrator: Administrator, batchId: string, view: RedeemBatchView, options: { all?: boolean } = {}): Promise<ListResult<RedemptionRow>> {
  assertConsole(administrator);
  const r = schema.redeemRedemption;
  const conditions: SQL[] = [eq(r.batchId, batchId)];
  if (view.q) {
    const pattern = likePattern(view.q);
    conditions.push(or(ilike(schema.user.name, pattern), ilike(schema.user.email, pattern), sql`${schema.user.id}::text ilike ${pattern}`, eq(schema.redeemCode.codeLast4, view.q.replace(/[\s-]/g, '').toUpperCase().slice(-4)))!);
  }
  const where = and(...conditions);
  const database = db();
  const base = () =>
    database
      .select({
        id: r.id,
        userId: r.userId,
        name: schema.user.name,
        email: schema.user.email,
        last4: schema.redeemCode.codeLast4,
        kind: r.kind,
        credits: r.credits,
        planMonths: r.planMonths,
        planStartsAt: r.planStartsAt,
        planEndsAt: r.planEndsAt,
        createdAt: r.createdAt,
      })
      .from(r)
      .innerJoin(schema.user, eq(schema.user.id, r.userId))
      .innerJoin(schema.redeemCode, eq(schema.redeemCode.id, r.codeId))
      .where(where);
  const [counted] = await database
    .select({ total: count() })
    .from(r)
    .innerJoin(schema.user, eq(schema.user.id, r.userId))
    .innerJoin(schema.redeemCode, eq(schema.redeemCode.id, r.codeId))
    .where(where);
  const total = counted?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  let query = base().orderBy(desc(r.createdAt), asc(r.id)).$dynamic();
  if (!options.all) query = query.limit(view.size).offset((page - 1) * view.size);
  return { items: await query, total, page, size: view.size };
}

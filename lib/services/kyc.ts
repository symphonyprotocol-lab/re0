/**
 * Identity verification against the database and private Blob
 * (rebuild-proposal.md 2.3, 2.5 "KYC 记录", 8.4 step 6): the user's
 * submission with its two images, the console's list and review, signed
 * links whose every issue is audited, re-verification requests, and the
 * retention purge. Every decision writes the audit and a notice in the
 * transaction that makes it.
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { KYC_FILE_RETENTION_DAYS, KYC_FILE_URL_TTL_SECONDS, KYC_IMAGE_MAX_BYTES, KYC_IMAGE_TYPES, KYC_ORPHAN_HOURS, KYC_PURGE_BATCH } from '@/lib/constants';
import { parseAdminReason } from '@/lib/domain/adjustments';
import { periodStart, type KycView } from '@/lib/domain/admin-lists';
import { approvalBlocker, canSubmitKyc, filesDueAt, kycState, KYC_SLOTS, parseKycSubmission, type KycSlot, type KycState } from '@/lib/domain/kyc';
import { clampPage, isUuid, likePattern, type ListResult } from '@/lib/domain/list';
import type { UserRole } from '@/lib/domain/roles';
import { reportingDate } from '@/lib/domain/statistics';
import { uploadTicket, type UploadTicket } from '@/lib/infra/blob';
import { blobInfo, deleteBlobs, listByPrefix, signedReadUrl } from '@/lib/infra/blob-access';
import { db, schema, type Executor } from '@/lib/infra/db';
import { AdminInputError, audit } from '@/lib/services/admin';
import { notify } from '@/lib/services/notices';

export type KycRow = typeof schema.kycRecord.$inferSelect;

const DAY = 24 * 60 * 60 * 1000;

/** A refusal on the user's side, answered as `{ error: code }`. */
export class KycRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'KycRefused';
  }
}

export async function latestKyc(executor: Executor, userId: string): Promise<KycRow | null> {
  const [row] = await executor
    .select()
    .from(schema.kycRecord)
    .where(eq(schema.kycRecord.userId, userId))
    .orderBy(desc(schema.kycRecord.createdAt), desc(schema.kycRecord.id))
    .limit(1);
  return row ?? null;
}

/** The users list's KYC column: the newest record's status, `none` without one. Written qualified for correlated use. */
export const userKycState = sql<KycState>`coalesce((select k.status from ${schema.kycRecord} k where k.user_id = "user"."id" order by k.created_at desc, k.id desc limit 1), 'none')`;

/* ------------------------------------------------------------- the user */

export interface KycOverview {
  state: KycState;
  official: boolean;
  /** The newest record, without the image pathnames. */
  record: Omit<KycRow, 'documentBlob' | 'selfieBlob'> & { hasDocument: boolean; hasSelfie: boolean };
}

export async function kycOverview(userId: string): Promise<{ state: KycState; official: boolean; record: KycOverview['record'] | null }> {
  const database = db();
  const [account] = await database.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  const latest = await latestKyc(database, userId);
  return { state: kycState(latest), official: account?.role === 'official', record: latest ? withoutPaths(latest) : null };
}

function withoutPaths({ documentBlob, selfieBlob, ...row }: KycRow): KycOverview['record'] {
  return { ...row, hasDocument: Boolean(documentBlob), hasSelfie: Boolean(selfieBlob) };
}

async function submitter(executor: Executor, userId: string): Promise<{ role: UserRole; state: KycState }> {
  const [account] = await executor.select({ role: schema.user.role }).from(schema.user).where(eq(schema.user.id, userId)).limit(1);
  if (!account) throw new KycRefused('not_found');
  if (account.role === 'official') throw new KycRefused('official');
  const state = kycState(await latestKyc(executor, userId));
  if (!canSubmitKyc(state)) throw new KycRefused(state === 'pending' ? 'kyc_pending' : 'kyc_verified');
  return { role: account.role, state };
}

/**
 * A Blob token for one image, scoped to `kyc/<user>/<random>.<ext>`, the
 * type and 10 MB. Only someone who may submit gets one.
 */
export async function kycUploadTicket(userId: string, input: { contentType?: unknown; size?: unknown }): Promise<UploadTicket & { contentType: string }> {
  const contentType = typeof input.contentType === 'string' ? input.contentType : '';
  const extension = KYC_IMAGE_TYPES[contentType];
  const size = Number(input.size ?? 0);
  if (!extension || !Number.isFinite(size) || size <= 0 || size > KYC_IMAGE_MAX_BYTES) throw new KycRefused('invalid_image');
  await submitter(db(), userId);
  const ticket = await uploadTicket(`kyc/${userId}/${crypto.randomUUID()}.${extension}`, { contentTypes: [contentType], maxBytes: KYC_IMAGE_MAX_BYTES });
  return { ...ticket, contentType };
}

/**
 * Submits the identity details, both images and the tax declaration. The
 * images are checked in Blob (there, an allowed type, ≤ 10 MB, used by no
 * other record) before the row is written; the state is checked again under
 * a per-user lock, so two tabs cannot both submit.
 */
export async function submitKyc(userId: string, input: Record<string, unknown>, now = new Date()): Promise<KycRow> {
  await submitter(db(), userId);
  const parsed = parseKycSubmission(userId, input, reportingDate(now));
  if ('error' in parsed) throw new KycRefused(parsed.error);
  for (const slot of KYC_SLOTS) {
    const pathname = slot === 'document' ? parsed.documentBlob : parsed.selfieBlob;
    const info = await blobInfo(pathname);
    if (!info || info.size <= 0 || info.size > KYC_IMAGE_MAX_BYTES || !KYC_IMAGE_TYPES[info.contentType]) throw new KycRefused(slot);
  }
  return db().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kyc:${userId}`}))`);
    await submitter(tx, userId);
    const [used] = await tx
      .select({ id: schema.kycRecord.id })
      .from(schema.kycRecord)
      .where(
        or(
          inArray(schema.kycRecord.documentBlob, [parsed.documentBlob, parsed.selfieBlob]),
          inArray(schema.kycRecord.selfieBlob, [parsed.documentBlob, parsed.selfieBlob]),
        ),
      )
      .limit(1);
    if (used) throw new KycRefused('document');
    const [row] = await tx
      .insert(schema.kycRecord)
      .values({ userId, ...parsed, taxDeclaredAt: now, consentAt: now, createdAt: now })
      .returning();
    return row!;
  });
}

/* ---------------------------------------------------------- the console */

export interface KycListItem {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: UserRole;
  status: KycRow['status'];
  legalName: string | null;
  country: string | null;
  documentKind: KycRow['documentKind'];
  documentLast4: string | null;
  documentExpires: string | null;
  taxForm: KycRow['taxForm'];
  declared: boolean;
  createdAt: Date;
  decidedAt: Date | null;
  reviewer: string | null;
  reason: string | null;
  resetAt: Date | null;
  filesDeleted: boolean;
}

const reviewer = sql<string | null>`(select a.email from ${schema.administrator} a where a.id = "kyc_record"."reviewed_by")`;

function kycWhere(view: Pick<KycView, 'q' | 'status' | 'period'>, now: Date): SQL | undefined {
  const conditions: SQL[] = [];
  if (view.status !== 'all') conditions.push(eq(schema.kycRecord.status, view.status));
  const since = periodStart(view.period, now);
  if (since) conditions.push(gte(schema.kycRecord.createdAt, since));
  if (view.q) {
    const pattern = likePattern(view.q);
    conditions.push(
      or(
        ilike(schema.user.name, pattern),
        ilike(schema.user.email, pattern),
        ilike(schema.kycRecord.legalName, pattern),
        ilike(schema.kycRecord.country, pattern),
        sql`${schema.kycRecord.id}::text ilike ${pattern}`,
        sql`${schema.kycRecord.userId}::text ilike ${pattern}`,
      )!,
    );
  }
  return conditions.length ? and(...conditions) : undefined;
}

function listItem(row: KycRow, user: { name: string; email: string; role: UserRole }, by: string | null): KycListItem {
  return {
    id: row.id,
    userId: row.userId,
    ...user,
    status: row.status,
    legalName: row.legalName,
    country: row.country,
    documentKind: row.documentKind,
    documentLast4: row.documentLast4,
    documentExpires: row.documentExpires,
    taxForm: row.taxForm,
    declared: Boolean(row.taxDeclaredAt),
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    reviewer: by,
    reason: row.reason,
    resetAt: row.resetAt,
    filesDeleted: Boolean(row.filesDeletedAt),
  };
}

export async function listKyc(view: KycView, options: { all?: boolean } = {}, now = new Date()): Promise<ListResult<KycListItem> & { counts: Record<string, number> }> {
  const database = db();
  const where = kycWhere(view, now);
  const [totalRow] = await database
    .select({ total: count() })
    .from(schema.kycRecord)
    .innerJoin(schema.user, eq(schema.user.id, schema.kycRecord.userId))
    .where(where);
  const total = totalRow?.total ?? 0;
  const page = clampPage(view.page, total, view.size);
  let query = database
    .select({ record: schema.kycRecord, name: schema.user.name, email: schema.user.email, role: schema.user.role, reviewer })
    .from(schema.kycRecord)
    .innerJoin(schema.user, eq(schema.user.id, schema.kycRecord.userId))
    .where(where)
    .orderBy(view.sort === 'newest' ? desc(schema.kycRecord.createdAt) : asc(schema.kycRecord.createdAt), asc(schema.kycRecord.id))
    .$dynamic();
  if (!options.all) query = query.limit(view.size).offset((page - 1) * view.size);
  const rows = await query;
  const tallies = await database.select({ status: schema.kycRecord.status, n: count() }).from(schema.kycRecord).groupBy(schema.kycRecord.status);
  const counts: Record<string, number> = { all: 0, pending: 0, verified: 0, rejected: 0, reset: 0 };
  for (const tally of tallies) {
    counts[tally.status] = tally.n;
    counts.all! += tally.n;
  }
  return {
    items: rows.map(({ record, name, email, role, reviewer: by }) => listItem(record, { name, email, role }, by)),
    total,
    page,
    size: view.size,
    counts,
  };
}

export async function pendingKyc(): Promise<number> {
  const [row] = await db().select({ n: count() }).from(schema.kycRecord).where(eq(schema.kycRecord.status, 'pending'));
  return row?.n ?? 0;
}

/** One user's records, newest first: the user page's KYC tab and the review page's history. */
export async function kycHistory(userId: string): Promise<KycListItem[]> {
  const rows = await db()
    .select({ record: schema.kycRecord, name: schema.user.name, email: schema.user.email, role: schema.user.role, reviewer })
    .from(schema.kycRecord)
    .innerJoin(schema.user, eq(schema.user.id, schema.kycRecord.userId))
    .where(eq(schema.kycRecord.userId, userId))
    .orderBy(desc(schema.kycRecord.createdAt), desc(schema.kycRecord.id));
  return rows.map(({ record, name, email, role, reviewer: by }) => listItem(record, { name, email, role }, by));
}

export async function kycDetail(id: string) {
  const database = db();
  const [row] = await database
    .select({ record: schema.kycRecord, user: schema.user, reviewer })
    .from(schema.kycRecord)
    .innerJoin(schema.user, eq(schema.user.id, schema.kycRecord.userId))
    .where(eq(schema.kycRecord.id, id))
    .limit(1);
  if (!row) return null;
  const latest = await latestKyc(database, row.record.userId);
  const { record, user } = row;
  return {
    record: withoutPaths(record),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, disabled: Boolean(user.disabledAt) },
    reviewer: row.reviewer,
    latest: latest?.id === record.id,
    latestId: latest?.id ?? null,
    filesDueAt: filesDueAt(record),
    history: await kycHistory(user.id),
  };
}

/**
 * Signed links to a record's images, good for 60 seconds. Each link issued
 * writes a `kyc.files.view` audit row (which file, until when), so every
 * look at an identity document is on record (2.3).
 */
export async function kycFiles(administratorId: string, id: string, now = new Date()) {
  if (!isUuid(id)) throw new AdminInputError('not_found');
  const [record] = await db().select().from(schema.kycRecord).where(eq(schema.kycRecord.id, id)).limit(1);
  if (!record) throw new AdminInputError('not_found');
  const files: Record<KycSlot, { url: string; expiresAt: string } | null> = { document: null, selfie: null };
  if (record.filesDeletedAt) return { deleted: true, files, expiresAt: null };
  const issued: { slot: KycSlot; url: string; expiresAt: Date }[] = [];
  for (const slot of KYC_SLOTS) {
    const pathname = slot === 'document' ? record.documentBlob : record.selfieBlob;
    if (!pathname) continue;
    issued.push({ slot, ...(await signedReadUrl(pathname, KYC_FILE_URL_TTL_SECONDS, now.getTime())) });
  }
  await db().transaction(async (tx) => {
    for (const file of issued) {
      await audit(tx, { administratorId, action: 'kyc.files.view', target: record.id, after: { file: file.slot, user: record.userId, expiresAt: file.expiresAt.toISOString() } });
    }
  });
  for (const file of issued) files[file.slot] = { url: file.url, expiresAt: file.expiresAt.toISOString() };
  return { deleted: false, files, expiresAt: issued[0]?.expiresAt.toISOString() ?? null };
}

/**
 * Approves or rejects the newest pending submission. Approval needs the
 * reviewer's "已比对", an unexpired document, the declaration and both
 * images; rejection needs a 3–300 character reason, which the user reads.
 */
export async function decideKyc(
  administratorId: string,
  id: string,
  decision: 'verified' | 'rejected',
  input: { matched?: unknown; reason?: unknown },
  now = new Date(),
): Promise<KycRow> {
  const note = typeof input.reason === 'string' ? input.reason.trim() : '';
  const reason = note ? parseAdminReason(note) : '';
  if (reason === null || (decision === 'rejected' && !reason)) throw new AdminInputError('reason');
  if (!isUuid(id)) throw new AdminInputError('not_found');
  return db().transaction(async (tx) => {
    const [record] = await tx.select().from(schema.kycRecord).where(eq(schema.kycRecord.id, id)).for('update');
    if (!record) throw new AdminInputError('not_found');
    const [account] = await tx.select().from(schema.user).where(eq(schema.user.id, record.userId)).for('update');
    const latest = await latestKyc(tx, record.userId);
    if (decision === 'verified') {
      const blocker = approvalBlocker(record, latest?.id === record.id, input.matched === true, reportingDate(now));
      if (blocker) throw new AdminInputError(blocker);
      if (account?.role === 'official') throw new AdminInputError('official');
      if (account?.disabledAt) throw new AdminInputError('disabled');
    } else if (latest?.id !== record.id || record.status !== 'pending') {
      throw new AdminInputError('stale');
    }
    const [updated] = await tx
      .update(schema.kycRecord)
      .set({ status: decision, reason: reason || null, reviewedBy: administratorId, decidedAt: now })
      .where(eq(schema.kycRecord.id, id))
      .returning();
    await audit(tx, {
      administratorId,
      action: decision === 'verified' ? 'kyc.verified' : 'kyc.rejected',
      target: id,
      before: { status: record.status, user: record.userId },
      after: { status: decision, user: record.userId, reason },
    });
    await notify(tx, { userId: record.userId, kind: 'kyc', text: decision === 'rejected' ? reason : '', params: { decision }, refId: id });
    return updated!;
  });
}

/**
 * "要求重新验证" (2.5): on the user's newest record, verified or rejected.
 * The record is kept and stamped `reset_at` (its images then go within 30
 * days); a new `reset` row carries the reason; the user is told and must
 * submit again before any payout is approved or paid. A pending submission
 * is decided instead.
 */
export async function requestReverification(administratorId: string, id: string, rawReason: unknown, now = new Date()): Promise<KycRow> {
  const reason = parseAdminReason(rawReason);
  if (!reason) throw new AdminInputError('reason');
  if (!isUuid(id)) throw new AdminInputError('not_found');
  return db().transaction(async (tx) => {
    const [record] = await tx.select().from(schema.kycRecord).where(eq(schema.kycRecord.id, id)).limit(1);
    if (!record) throw new AdminInputError('not_found');
    /* The lock `submitKyc` holds: a reset and a resubmission never interleave, so the newest record read here stays the newest. */
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`kyc:${record.userId}`}))`);
    const [account] = await tx.select().from(schema.user).where(eq(schema.user.id, record.userId)).for('update');
    if (account?.role === 'official') throw new AdminInputError('official');
    const latest = await latestKyc(tx, record.userId);
    if (!latest || (latest.status !== 'verified' && latest.status !== 'rejected')) throw new AdminInputError(latest?.status === 'pending' ? 'kyc_pending' : 'stale');
    await tx.update(schema.kycRecord).set({ resetAt: now }).where(eq(schema.kycRecord.id, latest.id));
    const [row] = await tx
      .insert(schema.kycRecord)
      .values({
        userId: record.userId,
        status: 'reset',
        legalName: latest.legalName,
        country: latest.country,
        documentKind: latest.documentKind,
        documentLast4: latest.documentLast4,
        documentExpires: latest.documentExpires,
        taxForm: latest.taxForm,
        reason,
        reviewedBy: administratorId,
        decidedAt: now,
        createdAt: new Date(Math.max(now.getTime(), latest.createdAt.getTime() + 1)),
      })
      .returning();
    await audit(tx, {
      administratorId,
      action: 'kyc.reset',
      target: latest.id,
      before: { status: latest.status, user: record.userId },
      after: { status: 'reset', user: record.userId, reason, record: row!.id },
    });
    await notify(tx, { userId: record.userId, kind: 'kyc', text: reason, params: { decision: 'reset' }, refId: row!.id });
    return row!;
  });
}

/* --------------------------------------------------------------- purge */

/**
 * `/api/cron/purge-kyc-files` (daily, idempotent): deletes the images of
 * records 30 days past approval, rejection or a reset, keeping every other
 * field, then images uploaded but never submitted (older than a day, under
 * `kyc/<user>/` for a user of this database, and named by no record). Blob first, then the row: should the row
 * update fail, the next run deletes again, which is harmless.
 */
export async function purgeKycFiles(now = new Date(), budgetMs = 240_000): Promise<{ records: number; orphans: number }> {
  const started = Date.now();
  let records = 0;
  for (;;) {
    const purged = await purgeDueBatch(now);
    records += purged;
    if (purged < KYC_PURGE_BATCH || Date.now() - started > budgetMs) break;
  }
  /* One pass over the uploads per run, after the records. */
  return { records, orphans: await purgeOrphans(now) };
}

/** Up to one batch of due records: their images in one Blob call, the rows in one update. */
async function purgeDueBatch(now: Date): Promise<number> {
  const database = db();
  const cutoff = new Date(now.getTime() - KYC_FILE_RETENTION_DAYS * DAY);
  const due = await database
    .select({ id: schema.kycRecord.id, documentBlob: schema.kycRecord.documentBlob, selfieBlob: schema.kycRecord.selfieBlob })
    .from(schema.kycRecord)
    .where(
      and(
        isNull(schema.kycRecord.filesDeletedAt),
        or(sql`${schema.kycRecord.documentBlob} is not null`, sql`${schema.kycRecord.selfieBlob} is not null`),
        or(
          and(inArray(schema.kycRecord.status, ['verified', 'rejected']), lte(schema.kycRecord.decidedAt, cutoff)),
          lte(schema.kycRecord.resetAt, cutoff),
        ),
      ),
    )
    .orderBy(asc(schema.kycRecord.createdAt))
    .limit(KYC_PURGE_BATCH);
  if (!due.length) return 0;
  await deleteBlobs(due.flatMap((record) => [record.documentBlob, record.selfieBlob]).filter((pathname): pathname is string => Boolean(pathname)));
  await database
    .update(schema.kycRecord)
    .set({ documentBlob: null, selfieBlob: null, filesDeletedAt: now })
    .where(and(inArray(schema.kycRecord.id, due.map((record) => record.id)), isNull(schema.kycRecord.filesDeletedAt)));
  return due.length;
}

/** The user id in `kyc/<user>/<file>`, or null for anything else under the prefix. */
function ownerOf(pathname: string): string | null {
  const match = /^kyc\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/]+$/.exec(pathname);
  return match ? match[1]! : null;
}

async function purgeOrphans(now: Date): Promise<number> {
  const before = now.getTime() - KYC_ORPHAN_HOURS * 60 * 60 * 1000;
  let cursor: string | undefined;
  let removed = 0;
  let seen = 0;
  do {
    const page = await listByPrefix('kyc/', { cursor, limit: 1000 });
    seen += page.blobs.length;
    const old = page.blobs.filter((blob) => blob.uploadedAt.getTime() < before && ownerOf(blob.pathname)).map((blob) => blob.pathname);
    if (old.length) {
      /* A store may serve several environments: only users of this database are this database's to clean up. */
      const owners = await db()
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(inArray(schema.user.id, [...new Set(old.map((pathname) => ownerOf(pathname)!))]));
      const ours = new Set(owners.map((row) => row.id));
      const named = await db()
        .select({ documentBlob: schema.kycRecord.documentBlob, selfieBlob: schema.kycRecord.selfieBlob })
        .from(schema.kycRecord)
        .where(or(inArray(schema.kycRecord.documentBlob, old), inArray(schema.kycRecord.selfieBlob, old)));
      const kept = new Set(named.flatMap((row) => [row.documentBlob, row.selfieBlob]));
      const orphans = old.filter((pathname) => ours.has(ownerOf(pathname)!) && !kept.has(pathname)).slice(0, KYC_PURGE_BATCH - removed);
      await deleteBlobs(orphans);
      removed += orphans.length;
    }
    cursor = page.cursor ?? undefined;
  } while (cursor && removed < KYC_PURGE_BATCH && seen < 10_000);
  return removed;
}

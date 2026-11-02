/**
 * Knowledge in step 1: documents and pasted text (rebuild-proposal.md 2.1).
 *
 * Adding one writes the row and reserves its processing cost in one
 * transaction; processing then runs after the response (Next's `after`,
 * inside the route's `maxDuration`): read → extract → chunk → embed → store,
 * and settle the reservation to the real price -- or release all of it when
 * anything fails. Every step lands in the row's processing record.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { DOCUMENT_MAX_BYTES, KNOWLEDGE_TITLE_MAX, LIST_PAGE_SIZES } from '@/lib/constants';
import { processingCost } from '@/lib/domain/credits';
import {
  activity,
  chunkSections,
  holdFor,
  joinedContent,
  validDocument,
  validText,
  type KnowledgeActivity,
  type KnowledgeKind,
  type Section,
} from '@/lib/domain/knowledge';
import { clampPage, likePattern, type ListResult } from '@/lib/domain/list';
import { embedTexts } from '@/lib/infra/ai/models';
import { blobSize, readBlob } from '@/lib/infra/blob';
import { documentSections, ProcessingFailure } from '@/lib/infra/connectors';
import { db, schema, type Tx } from '@/lib/infra/db';
import { heldFor, placeHold, releaseHold, settleHold } from '@/lib/services/credits';

export type NewKnowledge =
  | { kind: 'document'; blobPath: string; fileName: string }
  | { kind: 'text'; title: string; content: string };

/** A new source whose upload has been checked; a document carries its stored size. */
export type CheckedKnowledge = Exclude<NewKnowledge, { kind: 'document' }> | (Extract<NewKnowledge, { kind: 'document' }> & { size: number });

export class KnowledgeInputError extends Error {
  constructor(readonly code: 'invalid_document' | 'invalid_text' | 'upload_missing' | 'busy' | 'not_found') {
    super(code);
    this.name = 'KnowledgeInputError';
  }
}

function appendActivity(entries: KnowledgeActivity[]) {
  return sql`${schema.knowledge.activity} || ${JSON.stringify(entries)}::jsonb`;
}

/**
 * Checks a document upload against Blob -- before any transaction opens, so
 * no database connection waits on the network.
 */
export async function checkKnowledge(ownerId: string, input: NewKnowledge): Promise<CheckedKnowledge> {
  if (input.kind !== 'document') return input;
  if (!input.blobPath.startsWith(`knowledge/${ownerId}/`) || !validDocument(input.fileName, 1)) {
    throw new KnowledgeInputError('invalid_document');
  }
  const size = await blobSize(input.blobPath);
  if (size === null) throw new KnowledgeInputError('upload_missing');
  if (!validDocument(input.fileName, size)) throw new KnowledgeInputError('invalid_document');
  return { ...input, size };
}

/** Writes the row and reserves its cost. Throws `InsufficientCredits` from the ledger. */
export async function createKnowledgeInTx(
  tx: Tx,
  ownerId: string,
  ree: { id: string },
  input: CheckedKnowledge,
  now = new Date(),
): Promise<string> {
  let values: typeof schema.knowledge.$inferInsert;
  let hold: number;
  if (input.kind === 'document') {
    const size = input.size;
    const title = input.fileName.slice(0, KNOWLEDGE_TITLE_MAX);
    hold = holdFor('document');
    values = {
      reeId: ree.id,
      kind: 'document',
      title,
      originalTitle: title,
      source: input.blobPath,
      fileName: input.fileName,
      fileSize: size,
    };
  } else {
    if (!validText(input.title, input.content)) throw new KnowledgeInputError('invalid_text');
    const title = input.title.trim();
    hold = holdFor('text', input.content);
    values = { reeId: ree.id, kind: 'text', title, originalTitle: title, content: input.content.trim() };
  }
  const [row] = await tx
    .insert(schema.knowledge)
    .values({ ...values, status: 'pending', activity: [activity('added', { credits: hold }, now)], createdAt: now, updatedAt: now })
    .returning({ id: schema.knowledge.id });
  await placeHold(tx, { userId: ownerId, kind: 'knowledge', amount: hold, refId: row!.id, reeId: ree.id, note: values.title }, now);
  return row!.id;
}

export async function addKnowledge(ownerId: string, ree: { id: string }, input: NewKnowledge): Promise<string> {
  const checked = await checkKnowledge(ownerId, input);
  return db().transaction((tx) => createKnowledgeInTx(tx, ownerId, ree, checked));
}

/**
 * Reprocess a ready or failed source: a fresh reservation, charged again
 * (8.2, "重新处理"), and the old passages replaced when it succeeds.
 */
export async function refreshKnowledge(ownerId: string, reeId: string, knowledgeId: string): Promise<void> {
  await db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.knowledge)
      .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.reeId, reeId)))
      .for('update');
    if (!row) throw new KnowledgeInputError('not_found');
    if (row.status === 'pending' || row.status === 'processing') throw new KnowledgeInputError('busy');
    const hold = row.kind === 'text' ? holdFor('text', row.content ?? '') : holdFor('document');
    const now = new Date();
    await tx
      .update(schema.knowledge)
      .set({ status: 'pending', error: null, updatedAt: now, activity: appendActivity([activity('refresh', { credits: hold }, now)]) })
      .where(eq(schema.knowledge.id, knowledgeId));
    await placeHold(tx, { userId: ownerId, kind: 'knowledge', amount: hold, refId: knowledgeId, reeId, note: row.title }, now);
  });
}

async function sectionsOf(row: typeof schema.knowledge.$inferSelect): Promise<Section[]> {
  if (row.kind === 'text') return [{ text: row.content ?? '', locator: {} }];
  if (row.kind !== 'document' || !row.source || !row.fileName) {
    throw new ProcessingFailure('unsupported_format', `kind ${row.kind} is not processed in step 1`);
  }
  const bytes = await readBlob(row.source);
  if (!bytes) throw new ProcessingFailure('source_missing', `${row.source} is not in storage`);
  if (bytes.length > DOCUMENT_MAX_BYTES) throw new ProcessingFailure('unsupported_format', 'file too large');
  return documentSections(bytes, row.fileName);
}

/** One embedMany call: it splits into provider-sized batches and runs them in parallel. */
async function embedAll(texts: string[]): Promise<number[][]> {
  try {
    return (await embedTexts(texts)).vectors;
  } catch (error) {
    throw new ProcessingFailure('embedding_unavailable', error instanceof Error ? error.message : 'embedding failed');
  }
}

/**
 * Runs one pending source to ready or failed. Safe to call twice: the first
 * call claims the row (pending → processing) and the second finds nothing to
 * claim.
 */
export async function processKnowledge(knowledgeId: string): Promise<void> {
  const database = db();
  const now = new Date();
  const [row] = await database
    .update(schema.knowledge)
    .set({ status: 'processing', updatedAt: now, activity: appendActivity([activity('processing', undefined, now)]) })
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.status, 'pending')))
    .returning();
  if (!row) return;

  try {
    const sections = await sectionsOf(row);
    const content = joinedContent(sections);
    if (!content.trim()) throw new ProcessingFailure('empty_text', 'no text extracted');
    const pages = sections.filter((section) => section.locator.page !== undefined).length;
    const chunks = chunkSections(sections);
    if (chunks.length === 0) throw new ProcessingFailure('empty_text', 'nothing to chunk');
    const vectors = await embedAll(chunks.map((chunk) => chunk.content));
    const price = processingCost(content.length);

    await database.transaction(async (tx) => {
      await tx.delete(schema.chunk).where(eq(schema.chunk.knowledgeId, row.id));
      for (let at = 0; at < chunks.length; at += 200) {
        await tx.insert(schema.chunk).values(
          chunks.slice(at, at + 200).map((chunk, offset) => ({
            knowledgeId: row.id,
            reeId: row.reeId,
            ordinal: chunk.ordinal,
            content: chunk.content,
            embedding: vectors[at + offset]!,
            locator: chunk.locator,
          })),
        );
      }
      const holdId = await heldFor(tx, row.id, 'knowledge');
      const settled = holdId ? await settleHold(tx, holdId, price, { reeId: row.reeId, note: row.title }) : null;
      const done = new Date();
      const log: KnowledgeActivity[] = [
        activity('parsed', pages > 0 ? { chars: content.length, pages } : { chars: content.length }, done),
        activity('chunked', { chunks: chunks.length }, done),
      ];
      if (settled) log.push(activity('settled', { charged: settled.charged, released: settled.released }, done));
      log.push(activity('ready', undefined, done));
      await tx
        .update(schema.knowledge)
        .set({
          status: 'ready',
          error: null,
          content: row.kind === 'text' ? row.content : content,
          updatedAt: done,
          activity: appendActivity(log),
        })
        .where(eq(schema.knowledge.id, row.id));
    });
  } catch (error) {
    const code = error instanceof ProcessingFailure ? error.code : 'unknown';
    console.warn(`knowledge ${row.id} failed code=${code} detail=${error instanceof Error ? error.message : 'unknown'}`);
    await database.transaction(async (tx) => {
      const holdId = await heldFor(tx, row.id, 'knowledge');
      const released = holdId ? await releaseHold(tx, holdId, { reeId: row.reeId, note: row.title }) : null;
      const done = new Date();
      const log: KnowledgeActivity[] = [activity('failed', { reason: code }, done)];
      if (released) log.push(activity('refunded', { credits: released }, done));
      await tx
        .update(schema.knowledge)
        .set({ status: 'failed', error: code, updatedAt: done, activity: appendActivity(log) })
        .where(eq(schema.knowledge.id, row.id));
    });
  }
}

/* -------------------------------------------------------------------- read */

export const KNOWLEDGE_STATUSES = ['all', 'ready', 'processing', 'failed'] as const;
export const KNOWLEDGE_KINDS = ['all', 'document', 'text'] as const;
export const KNOWLEDGE_SORTS = ['recent', 'oldest', 'name'] as const;
export type KnowledgeTab = (typeof KNOWLEDGE_STATUSES)[number];

export interface KnowledgeListItem {
  id: string;
  title: string;
  kind: KnowledgeKind;
  status: string;
  error: string | null;
  fileName: string | null;
  fileSize: number | null;
  chars: number;
  chunks: number;
  updatedAt: Date;
}

export async function listKnowledge(
  reeId: string,
  query: { q: string; status: KnowledgeTab; kind: string; sort: string; size: number; page: number },
): Promise<ListResult<KnowledgeListItem> & { counts: Record<KnowledgeTab, number> }> {
  const base: SQL[] = [eq(schema.knowledge.reeId, reeId)];
  if (query.kind !== 'all') base.push(eq(schema.knowledge.kind, query.kind as KnowledgeKind));
  if (query.q) {
    const pattern = likePattern(query.q);
    base.push(or(ilike(schema.knowledge.title, pattern), ilike(schema.knowledge.content, pattern))!);
  }
  const database = db();
  const [counts] = await database
    .select({
      all: sql<number>`count(*)::int`,
      ready: sql<number>`count(*) filter (where ${schema.knowledge.status} = 'ready')::int`,
      processing: sql<number>`count(*) filter (where ${schema.knowledge.status} in ('pending', 'processing'))::int`,
      failed: sql<number>`count(*) filter (where ${schema.knowledge.status} = 'failed')::int`,
    })
    .from(schema.knowledge)
    .where(and(...base));
  const tabCounts = counts ?? { all: 0, ready: 0, processing: 0, failed: 0 };
  const conditions = [...base];
  if (query.status === 'ready') conditions.push(eq(schema.knowledge.status, 'ready'));
  if (query.status === 'processing') conditions.push(inArray(schema.knowledge.status, ['pending', 'processing']));
  if (query.status === 'failed') conditions.push(eq(schema.knowledge.status, 'failed'));
  const total = tabCounts[query.status];
  const size = (LIST_PAGE_SIZES as readonly number[]).includes(query.size) ? query.size : LIST_PAGE_SIZES[0];
  const page = clampPage(query.page, total, size);
  const order =
    query.sort === 'oldest'
      ? [asc(schema.knowledge.createdAt)]
      : query.sort === 'name'
        ? [asc(sql`lower(${schema.knowledge.title})`), desc(schema.knowledge.updatedAt)]
        : [desc(schema.knowledge.updatedAt)];
  const items = await database
    .select({
      id: schema.knowledge.id,
      title: schema.knowledge.title,
      kind: schema.knowledge.kind,
      status: schema.knowledge.status,
      error: schema.knowledge.error,
      fileName: schema.knowledge.fileName,
      fileSize: schema.knowledge.fileSize,
      chars: sql<number>`coalesce(length(${schema.knowledge.content}), 0)::int`,
      chunks: sql<number>`(select count(*)::int from ${schema.chunk} c where c.knowledge_id = "knowledge"."id")`,
      updatedAt: schema.knowledge.updatedAt,
    })
    .from(schema.knowledge)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(size)
    .offset((page - 1) * size);
  return { items, total, page, size, counts: tabCounts };
}

export async function knowledgeDetail(reeId: string, knowledgeId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(knowledgeId)) return null;
  const database = db();
  const [row] = await database
    .select()
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.reeId, reeId)))
    .limit(1);
  if (!row) return null;
  const chunks = await database
    .select({ id: schema.chunk.id, ordinal: schema.chunk.ordinal, content: schema.chunk.content, locator: schema.chunk.locator })
    .from(schema.chunk)
    .where(eq(schema.chunk.knowledgeId, knowledgeId))
    .orderBy(asc(schema.chunk.ordinal));
  const { source: _source, ...rest } = row;
  return { ...rest, chunks };
}

/** How long a run may stay in `processing` before it is presumed dead (the function's limit is 300 s). */
const STALE_PROCESSING_MS = 15 * 60 * 1000;
/** A `pending` row older than this missed its after-response run. */
const STALE_PENDING_MS = 60 * 1000;

/**
 * Housekeeping on read: a run that died mid-way is failed and refunded, and
 * rows whose run never started are returned so the caller can start them.
 */
export async function recoverStale(reeId: string, now = new Date()): Promise<string[]> {
  const database = db();
  const dead = await database
    .select({ id: schema.knowledge.id })
    .from(schema.knowledge)
    .where(
      and(
        eq(schema.knowledge.reeId, reeId),
        eq(schema.knowledge.status, 'processing'),
        sql`${schema.knowledge.updatedAt} < ${new Date(now.getTime() - STALE_PROCESSING_MS)}`,
      ),
    );
  for (const { id } of dead) {
    await database.transaction(async (tx) => {
      const holdId = await heldFor(tx, id, 'knowledge');
      const released = holdId ? await releaseHold(tx, holdId, { reeId }) : null;
      const log: KnowledgeActivity[] = [activity('failed', { reason: 'unknown' }, now)];
      if (released) log.push(activity('refunded', { credits: released }, now));
      await tx
        .update(schema.knowledge)
        .set({ status: 'failed', error: 'unknown', updatedAt: now, activity: appendActivity(log) })
        .where(and(eq(schema.knowledge.id, id), eq(schema.knowledge.status, 'processing')));
    });
  }
  const waiting = await database
    .select({ id: schema.knowledge.id })
    .from(schema.knowledge)
    .where(
      and(
        eq(schema.knowledge.reeId, reeId),
        eq(schema.knowledge.status, 'pending'),
        sql`${schema.knowledge.updatedAt} < ${new Date(now.getTime() - STALE_PENDING_MS)}`,
      ),
    )
    .orderBy(asc(schema.knowledge.createdAt))
    .limit(5);
  return waiting.map((row) => row.id);
}

export async function readiness(reeId: string): Promise<{ ready: number; processing: number }> {
  const [row] = await db()
    .select({
      ready: sql<number>`count(*) filter (where ${schema.knowledge.status} = 'ready')::int`,
      processing: sql<number>`count(*) filter (where ${schema.knowledge.status} in ('pending', 'processing'))::int`,
    })
    .from(schema.knowledge)
    .where(eq(schema.knowledge.reeId, reeId));
  return row ?? { ready: 0, processing: 0 };
}

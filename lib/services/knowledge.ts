/**
 * Knowledge: the six kinds of rebuild-proposal.md 2.1, from added to ready.
 *
 * Adding one checks it first -- the upload against Blob, a repository's
 * access (public, or through the owner's GitHub connection), a website's
 * domain claim -- outside any transaction, then writes the row and
 * reserves its processing cost in one transaction. Processing runs after the
 * response (Next's `after`, inside the route's `maxDuration`): read or fetch
 * or transcribe → chunk → embed → store, and settle the reservation to the
 * real price, or release all of it when anything fails. Every step lands in
 * the row's processing record.
 */
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { AUDIO_MAX_BYTES, DOCUMENT_MAX_BYTES, KNOWLEDGE_BATCH_MAX, KNOWLEDGE_TITLE_MAX, LIST_PAGE_SIZES, PREVIEW_CHUNKS_MAX } from '@/lib/constants';
import {
  activity,
  assemble,
  audioFormat,
  audioProblem,
  chunkSections,
  CHUNK_TARGET_TOKENS,
  estimateTokens,
  holdFor,
  validDocument,
  validText,
  type DraftChunk,
  type KnowledgeActivity,
  type KnowledgeChild,
  type KnowledgeKind,
  type Section,
} from '@/lib/domain/knowledge';
import type { Locator } from '@/lib/domain/answer';
import { clampPage, likePattern, type ListResult } from '@/lib/domain/list';
import { parseGithubRepo, parseWebUrl, repositoryUrl, type RepositoryRef } from '@/lib/domain/sources';
import { embedTexts, forgetModelCache } from '@/lib/infra/ai/models';
import { storingSpace } from '@/lib/services/reembed';
import { transcribeAudio } from '@/lib/infra/ai/transcription';
import { isKnowledgeUploadPath } from '@/lib/domain/blob-path';
import { blobSize, readBlob } from '@/lib/infra/blob';
import { documentSections, ProcessingFailure } from '@/lib/infra/connectors';
import { simulatedFailureFor } from '@/lib/infra/connectors/failure';
import { fetchRepositoryFiles, resolveRepository } from '@/lib/infra/connectors/github';
import { crawlSite, fetchPage } from '@/lib/infra/connectors/web';
import { db, schema, type Tx } from '@/lib/infra/db';
import { githubTokenFor, hasVerifiedDomainFor } from '@/lib/services/connections';
import { heldFor, InsufficientCredits, placeHold, reserveKnowledgeUsage, settleHold } from '@/lib/services/credits';
import { afterKnowledgeReady } from '@/lib/services/profile';
import { drainProviderCalls, flushTransfer, meterTransfer, withProviderMeter } from '@/lib/infra/ai/provider-meter';
import { chargeLateReceipt, settleRun } from '@/lib/services/metered-work';
import { ProviderCostUnavailable, providerTotal, type ProviderCharge } from '@/lib/domain/provider-cost';
import { providerPrices } from '@/lib/services/provider-pricing';

export type NewKnowledge = (
  | { kind: 'document'; blobPath: string; fileName: string }
  | { kind: 'audio'; blobPath: string; fileName: string; consent: boolean }
  | { kind: 'text'; title: string; content: string }
  | { kind: 'github'; url: string }
  | { kind: 'page'; url: string }
  | { kind: 'site'; url: string }
) & { folderId?: string | null };

/** A new source whose input has been checked: uploads carry their stored size, URLs their parsed form. */
export type CheckedKnowledge = (
  | { kind: 'document'; blobPath: string; fileName: string; size: number }
  | { kind: 'audio'; blobPath: string; fileName: string; size: number }
  | { kind: 'text'; title: string; content: string }
  | { kind: 'github'; ref: RepositoryRef; fullName: string; private: boolean }
  | { kind: 'page'; url: URL }
  | { kind: 'site'; url: URL }
) & { folderId?: string | null };

export type KnowledgeInputCode =
  | 'invalid_document'
  | 'invalid_audio'
  | 'm4a_too_long'
  | 'consent_required'
  | 'invalid_text'
  | 'invalid_url'
  | 'invalid_github_url'
  | 'github_not_connected'
  | 'github_repo_not_found'
  | 'domain_unverified'
  | 'source_unreachable'
  | 'upload_missing'
  | 'invalid_folder'
  | 'invalid_title'
  | 'busy'
  | 'not_found';

export class KnowledgeInputError extends Error {
  constructor(readonly code: KnowledgeInputCode) {
    super(code);
    this.name = 'KnowledgeInputError';
  }
}

/** The HTTP status a refusal answers with: missing rows 404, a busy row 409, the rest 422. */
export function inputErrorStatus(code: KnowledgeInputCode): number {
  if (code === 'not_found') return 404;
  if (code === 'busy') return 409;
  if (code === 'source_unreachable') return 502;
  return 422;
}

export function appendActivity(entries: KnowledgeActivity[]) {
  return sql`${schema.knowledge.activity} || ${JSON.stringify(entries)}::jsonb`;
}

/* ------------------------------------------------------------------ checks */

/**
 * Check that the repository can be read: a public one by anyone, a private
 * one through the owner's GitHub connection (`resolveRepository`).
 */
export async function checkRepository(ownerId: string, ref: RepositoryRef): Promise<{ fullName: string; private: boolean }> {
  try {
    const access = await resolveRepository(ref, await githubTokenFor(ownerId));
    if (!access.ok) throw new KnowledgeInputError(access.reason === 'not_found' ? 'github_repo_not_found' : 'github_not_connected');
    return { fullName: access.repository.fullName, private: access.repository.private };
  } catch (error) {
    if (error instanceof KnowledgeInputError) throw error;
    /* Throttled or unanswered: `resolveRepository` already turned a refused owner token into `not_connected`. */
    throw new KnowledgeInputError('source_unreachable');
  }
}

/** An upload's pathname as `/api/upload-token` issues it (`isKnowledgeUploadPath`). */
export function ownUploadPath(ownerId: string, blobPath: string): boolean {
  return isKnowledgeUploadPath(blobPath, ownerId);
}

async function checkUpload(ownerId: string, blobPath: string, fileName: string, valid: (name: string, size: number) => boolean, code: KnowledgeInputCode) {
  if (!ownUploadPath(ownerId, blobPath) || !valid(fileName, 1)) throw new KnowledgeInputError(code);
  const size = await blobSize(blobPath);
  if (size === null) throw new KnowledgeInputError('upload_missing');
  if (!valid(fileName, size)) throw new KnowledgeInputError(code);
  return size;
}

/**
 * Checks a new source -- before any transaction opens, so no database
 * connection waits on Blob, GitHub or DNS.
 */
export async function checkKnowledge(ownerId: string, input: NewKnowledge): Promise<CheckedKnowledge> {
  const folderId = input.folderId ?? null;
  switch (input.kind) {
    case 'document': {
      const size = await checkUpload(ownerId, input.blobPath, input.fileName, validDocument, 'invalid_document');
      return { kind: 'document', blobPath: input.blobPath, fileName: input.fileName, size, folderId };
    }
    case 'audio': {
      if (!input.consent) throw new KnowledgeInputError('consent_required');
      const size = await checkUpload(ownerId, input.blobPath, input.fileName, (name, bytes) => audioProblem(name, bytes) !== 'invalid_audio', 'invalid_audio');
      const problem = audioProblem(input.fileName, size);
      if (problem) throw new KnowledgeInputError(problem);
      return { kind: 'audio', blobPath: input.blobPath, fileName: input.fileName, size, folderId };
    }
    case 'text':
      if (!validText(input.title, input.content)) throw new KnowledgeInputError('invalid_text');
      return { ...input, folderId };
    case 'github': {
      const ref = parseGithubRepo(input.url);
      if (!ref) throw new KnowledgeInputError('invalid_github_url');
      const repository = await checkRepository(ownerId, ref);
      return { kind: 'github', ref, ...repository, folderId };
    }
    case 'page': {
      const url = parseWebUrl(input.url);
      if (!url) throw new KnowledgeInputError('invalid_url');
      return { kind: 'page', url, folderId };
    }
    case 'site': {
      const url = parseWebUrl(input.url);
      if (!url) throw new KnowledgeInputError('invalid_url');
      if (!(await hasVerifiedDomainFor(ownerId, url.hostname))) throw new KnowledgeInputError('domain_unverified');
      return { kind: 'site', url, folderId };
    }
  }
}

/** The title a fetched source starts with (prototype: `host + path`, or `owner/name`). */
function urlTitle(url: URL): string {
  return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`.slice(0, KNOWLEDGE_TITLE_MAX);
}

async function folderBelongs(tx: Tx, reeId: string, folderId: string | null | undefined): Promise<string | null> {
  if (!folderId) return null;
  if (!/^[0-9a-f-]{36}$/i.test(folderId)) throw new KnowledgeInputError('invalid_folder');
  const [folder] = await tx
    .select({ id: schema.knowledgeFolder.id })
    .from(schema.knowledgeFolder)
    .where(and(eq(schema.knowledgeFolder.id, folderId), eq(schema.knowledgeFolder.reeId, reeId)))
    .limit(1);
  if (!folder) throw new KnowledgeInputError('invalid_folder');
  return folder.id;
}

/** Writes the row and reserves its cost. Throws `InsufficientCredits` from the ledger. */
export async function createKnowledgeInTx(tx: Tx, ownerId: string, ree: { id: string }, input: CheckedKnowledge, now = new Date()): Promise<string> {
  const folderId = await folderBelongs(tx, ree.id, input.folderId);
  let values: Omit<typeof schema.knowledge.$inferInsert, 'reeId'>;
  let hold: number;
  switch (input.kind) {
    case 'document':
    case 'audio': {
      const title = input.fileName.slice(0, KNOWLEDGE_TITLE_MAX);
      hold = input.kind === 'audio' ? holdFor('audio', input.size) : holdFor('document');
      values = {
        kind: input.kind,
        title,
        originalTitle: title,
        source: input.blobPath,
        fileName: input.fileName,
        fileSize: input.size,
        consentAt: input.kind === 'audio' ? now : null,
      };
      break;
    }
    case 'text': {
      const title = input.title.trim();
      hold = holdFor('text', input.content);
      values = { kind: 'text', title, originalTitle: title, content: input.content.trim() };
      break;
    }
    case 'github':
      hold = holdFor('github');
      values = { kind: 'github', title: input.fullName, originalTitle: input.fullName, source: repositoryUrl(input.ref) };
      break;
    case 'page':
    case 'site':
      hold = holdFor(input.kind);
      values = { kind: input.kind, title: urlTitle(input.url), originalTitle: urlTitle(input.url), source: input.url.href };
      break;
  }
  const [row] = await tx
    .insert(schema.knowledge)
    .values({ ...values, reeId: ree.id, folderId, status: 'pending', activity: [activity('added', { credits: hold }, now)], createdAt: now, updatedAt: now })
    .returning({ id: schema.knowledge.id });
  const holdId = await placeHold(tx, { userId: ownerId, kind: 'knowledge', amount: hold, refId: row!.id, reeId: ree.id, note: values.title }, now);
  await snapshotCostRun(tx, holdId, row!.id, now);
  return row!.id;
}

export async function addKnowledge(ownerId: string, ree: { id: string }, input: NewKnowledge): Promise<string> {
  const checked = await checkKnowledge(ownerId, input);
  return db().transaction((tx) => createKnowledgeInTx(tx, ownerId, ree, checked));
}

/* ---------------------------------------------------------- reprocessing */

type KnowledgeRow = typeof schema.knowledge.$inferSelect;

async function snapshotCostRun(tx: Tx, holdId: string, knowledgeId: string, now: Date) {
  const [source] = await tx.select({ title: schema.knowledge.title, kind: schema.knowledge.kind, reeId: schema.ree.id, reeName: schema.ree.name, userId: schema.ree.ownerId })
    .from(schema.knowledge).innerJoin(schema.ree, eq(schema.knowledge.reeId, schema.ree.id)).where(eq(schema.knowledge.id, knowledgeId));
  if (!source) throw new Error('knowledge cost source missing');
  await tx.insert(schema.knowledgeCostRun).values({ ...source, id: holdId, knowledgeId, status: 'pending', createdAt: now }).onConflictDoNothing();
}

function processingRun(row: Pick<KnowledgeRow, 'activity'>): string | undefined {
  const entry = row.activity.filter((item) => item.code === 'processing').at(-1);
  return String(entry?.detail?.runId ?? entry?.at ?? '');
}
function ownsProcessingRun(row: Pick<KnowledgeRow, 'status' | 'activity'> | undefined, runId: string): boolean {
  return row?.status === 'processing' && processingRun(row) === runId;
}
function runCharges(log: KnowledgeActivity[], runId: string): ProviderCharge[] {
  return log.filter((entry) => entry.code === 'provider_usage' && entry.detail?.runId === runId)
    .map((entry) => JSON.parse(String(entry.detail!.charge)) as ProviderCharge);
}

/** Persist each successful supplier response, including its price snapshot, before proceeding. */
async function recordProviderCharge(knowledgeId: string, charge: ProviderCharge): Promise<void> {
  const outcome = await db().transaction(async (tx) => {
    const [row] = await tx.select().from(schema.knowledge).where(eq(schema.knowledge.id, knowledgeId)).for('update');
    // Receipts outlive source content, including late replies after a stale run was refunded.
    await tx.update(schema.knowledgeCostRun).set({ charges: sql`${schema.knowledgeCostRun.charges} || ${JSON.stringify([charge])}::jsonb` })
      .where(and(eq(schema.knowledgeCostRun.runId, charge.runId), sql`not exists (select 1 from jsonb_array_elements(${schema.knowledgeCostRun.charges}) c where c->>'id' = ${charge.id})`));
    // A run already closed (refunded as dead, or purged) is billed for what arrived late.
    if (!row) {
      if (charge.costUsd !== null) await chargeLateReceipt(tx, charge.runId);
      return 'stale';
    }
    const previous = runCharges(row!.activity, charge.runId);
    if (previous.some((entry) => entry.id === charge.id)) return null;
    const current = ownsProcessingRun(row, charge.runId);
    await tx.update(schema.knowledge).set({ activity: appendActivity([activity('provider_usage', { runId: charge.runId, charge: JSON.stringify(charge), ...(current ? {} : { late: 1 }) })]) }).where(eq(schema.knowledge.id, knowledgeId));
    // A late supplier cost is billed to the run it belongs to, without touching a newer run's credits.
    if (!current) {
      if (charge.costUsd !== null) await chargeLateReceipt(tx, charge.runId);
      return 'stale';
    }
    // An unresolved receipt reserves nothing; the known costs around it still do.
    if (charge.costUsd === null) return null;
    const holdId = await heldFor(tx, knowledgeId, 'knowledge');
    if (!holdId) throw new Error('knowledge reservation missing');
    try {
      const known = [...previous, charge].filter((entry) => entry.costUsd !== null);
      const extra = await reserveKnowledgeUsage(tx, holdId, providerTotal(known).credits, { reeId: row!.reeId, note: row!.title });
      if (extra > 0) await tx.update(schema.knowledge).set({ activity: appendActivity([activity('reserved', { credits: extra })]) }).where(eq(schema.knowledge.id, knowledgeId));
    } catch (error) {
      // Allocation checks the full balance before mutating; retain the usage record even on refusal.
      if (error instanceof InsufficientCredits) return error;
      throw error;
    }
    return null;
  });
  if (outcome === 'stale') throw new Error('stale processing run');
  if (outcome) throw outcome;
}

/**
 * Before a paid call: the run's known costs plus the estimated cost of every
 * call in flight (this one included) are reserved, or `InsufficientCredits`
 * stops the call before it is made (the supplier is never paid for work the
 * balance cannot cover). The bill is still the measured usage; whatever the
 * estimates reserved beyond it is returned at settlement.
 */
async function reserveEstimate(knowledgeId: string, runId: string, inflight: readonly string[]): Promise<void> {
  await db().transaction(async (tx) => {
    const [row] = await tx.select().from(schema.knowledge).where(eq(schema.knowledge.id, knowledgeId)).for('update');
    if (!row || !ownsProcessingRun(row, runId)) throw new Error('stale processing run');
    const holdId = await heldFor(tx, knowledgeId, 'knowledge');
    if (!holdId) throw new Error('knowledge reservation missing');
    const known = runCharges(row.activity, runId).filter((entry) => entry.costUsd !== null);
    const extra = await reserveKnowledgeUsage(tx, holdId, providerTotal([...known, ...inflight.map((costUsd) => ({ costUsd }))]).credits, { reeId: row.reeId, note: row.title });
    if (extra > 0) await tx.update(schema.knowledge).set({ activity: appendActivity([activity('reserved', { credits: extra, estimate: 1 })]) }).where(eq(schema.knowledge.id, knowledgeId));
  });
}

/** Initial reservation only; supplier responses determine the final price. */
export function reprocessHold(row: Pick<KnowledgeRow, 'kind' | 'content' | 'fileSize'>): number {
  if (row.kind === 'text') return holdFor('text', row.content ?? '');
  if (row.kind === 'audio') return holdFor('audio', row.fileSize ?? 0);
  return holdFor(row.kind);
}

/**
 * The network half of the reprocess check: a repository must still be
 * public or readable through the GitHub connection, a website still needs its domain. Run before the transaction.
 */
export async function checkReprocess(ownerId: string, rows: readonly Pick<KnowledgeRow, 'kind' | 'source'>[]): Promise<void> {
  for (const row of rows) {
    if (row.kind === 'github') {
      const ref = parseGithubRepo(row.source);
      if (!ref) throw new KnowledgeInputError('invalid_github_url');
      await checkRepository(ownerId, ref);
    }
    if (row.kind === 'site') {
      const url = parseWebUrl(row.source);
      if (!url) throw new KnowledgeInputError('invalid_url');
      if (!(await hasVerifiedDomainFor(ownerId, url.hostname))) throw new KnowledgeInputError('domain_unverified');
    }
  }
}

/**
 * Reprocess ready or failed sources: each a fresh usage reservation, charged again
 * (8.2, "重新处理"), its old passages replaced when it succeeds. All or none:
 * a busy row or a short balance refuses the whole batch.
 */
export async function reprocessInTx(tx: Tx, ownerId: string, reeId: string, ids: readonly string[], now = new Date()): Promise<void> {
  const rows = await tx
    .select()
    .from(schema.knowledge)
    .where(and(inArray(schema.knowledge.id, [...ids]), eq(schema.knowledge.reeId, reeId), isNull(schema.knowledge.deletedAt)))
    .for('update');
  if (rows.length !== new Set(ids).size) throw new KnowledgeInputError('not_found');
  if (rows.some((row) => row.status === 'pending' || row.status === 'processing')) throw new KnowledgeInputError('busy');
  for (const row of rows) {
    const hold = reprocessHold(row);
    await tx
      .update(schema.knowledge)
      .set({ status: 'pending', error: null, updatedAt: now, activity: appendActivity([activity('refresh', { credits: hold }, now)]) })
      .where(eq(schema.knowledge.id, row.id));
    const holdId = await placeHold(tx, { userId: ownerId, kind: 'knowledge', amount: hold, refId: row.id, reeId, note: row.title }, now);
    await snapshotCostRun(tx, holdId, row.id, now);
  }
}

export async function refreshKnowledge(ownerId: string, reeId: string, knowledgeId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(knowledgeId)) throw new KnowledgeInputError('not_found');
  const [row] = await db()
    .select({ kind: schema.knowledge.kind, source: schema.knowledge.source })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.reeId, reeId), isNull(schema.knowledge.deletedAt)))
    .limit(1);
  if (!row) throw new KnowledgeInputError('not_found');
  await checkReprocess(ownerId, [row]);
  await db().transaction((tx) => reprocessInTx(tx, ownerId, reeId, [knowledgeId]));
}

/* -------------------------------------------------------------- processing */

interface Extracted {
  sections: Section[];
  /** Passages built by the kind itself (audio windows); otherwise the sections are chunked. */
  chunks?: DraftChunk[];
  audioSeconds?: number;
  log: KnowledgeActivity[];
  /** A fetched page's own title, used when the owner has not renamed the source. */
  title?: string;
}

/** A passage spans at most this much audio, so the second it cites is near what it says. */
const AUDIO_PASSAGE_SECONDS = 120;

/** Transcript segments grouped into passages of about the chunker's target size, each citing its first second. */
function audioChunks(segments: readonly { start: number; text: string }[]): DraftChunk[] {
  const chunks: DraftChunk[] = [];
  let buffer: string[] = [];
  let start = 0;
  let tokens = 0;
  const flush = (): void => {
    if (buffer.length > 0) chunks.push({ ordinal: chunks.length, content: buffer.join(' '), locator: { time: Math.floor(start) } });
    buffer = [];
    tokens = 0;
  };
  for (const segment of segments) {
    const size = estimateTokens(segment.text);
    if (tokens > 0 && (tokens + size > CHUNK_TARGET_TOKENS || segment.start - start >= AUDIO_PASSAGE_SECONDS)) flush();
    if (buffer.length === 0) start = segment.start;
    buffer.push(segment.text);
    tokens += size;
  }
  flush();
  return chunks;
}

async function ownerOf(reeId: string): Promise<string> {
  const [ree] = await db().select({ ownerId: schema.ree.ownerId }).from(schema.ree).where(eq(schema.ree.id, reeId)).limit(1);
  return ree!.ownerId;
}

async function extract(row: KnowledgeRow): Promise<Extracted> {
  if (simulatedFailureFor(row.fileName, row.title, row.originalTitle)) {
    throw new ProcessingFailure('simulated', 'the name asks for the failure path (test environments only)');
  }
  switch (row.kind) {
    case 'text':
      return { sections: [{ text: row.content ?? '', locator: {} }], log: [] };
    case 'document': {
      if (!row.source || !row.fileName) throw new ProcessingFailure('source_missing', 'no stored file');
      const bytes = await readBlob(row.source);
      if (!bytes) throw new ProcessingFailure('source_missing', `${row.source} is not in storage`);
      meterTransfer('blob_read', bytes.length);
      if (bytes.length > DOCUMENT_MAX_BYTES) throw new ProcessingFailure('unsupported_format', 'file too large');
      return { sections: await documentSections(bytes, row.fileName), log: [] };
    }
    case 'audio': {
      const format = row.fileName ? audioFormat(row.fileName) : null;
      if (!row.source || !format) throw new ProcessingFailure('source_missing', 'no stored audio');
      const bytes = await readBlob(row.source);
      if (!bytes) throw new ProcessingFailure('source_missing', `${row.source} is not in storage`);
      meterTransfer('blob_read', bytes.length);
      if (bytes.length > AUDIO_MAX_BYTES) throw new ProcessingFailure('unsupported_format', 'file too large');
      const transcript = await transcribeAudio(bytes, format);
      if (transcript.segments.length === 0) throw new ProcessingFailure('empty_text', 'nothing was transcribed');
      const seconds = Math.max(transcript.durationSeconds, transcript.segments.at(-1)?.end ?? 0);
      return {
        sections: transcript.segments.map((segment) => ({
          text: segment.text,
          locator: { time: Math.floor(segment.start) },
          child: { label: '', time: Math.round(segment.start * 10) / 10, end: Math.round(segment.end * 10) / 10 },
        })),
        chunks: audioChunks(transcript.segments),
        audioSeconds: seconds,
        log: [activity('transcribed', { seconds })],
      };
    }
    case 'github': {
      const ref = parseGithubRepo(row.source);
      if (!ref) throw new ProcessingFailure('github_repo_not_found', 'not a repository URL');
      /* A public repository is read without a connection; a private one fails `github_not_connected` without it. */
      const snapshot = await fetchRepositoryFiles(ref, await githubTokenFor(await ownerOf(row.reeId)));
      return {
        sections: snapshot.files.map((file) => ({ text: file.content, locator: { path: file.path }, byLines: true, child: { label: file.path, path: file.path } })),
        log: [
          activity('fetched', {
            files: snapshot.files.length,
            revision: snapshot.revision.slice(0, 7),
            ...(snapshot.unread ? { unread: snapshot.unread } : {}),
          }),
        ],
      };
    }
    case 'page': {
      const page = await fetchPage(row.source ?? '');
      return { sections: [{ text: page.markdown, locator: { url: page.url } }], log: [activity('fetched', { pages: 1 })], title: page.title };
    }
    case 'site': {
      const entry = parseWebUrl(row.source);
      if (!entry) throw new ProcessingFailure('source_missing', 'not a URL');
      const { pages, truncated } = await crawlSite(entry);
      return {
        sections: pages.map((page) => ({ text: page.markdown, locator: { url: page.url }, child: { label: page.title.slice(0, 300), url: page.url } })),
        log: [activity('fetched', truncated ? { pages: pages.length, truncated: 1 } : { pages: pages.length })],
      };
    }
  }
}

/** One embedMany call: it splits into provider-sized batches and runs them in parallel. */
async function embedAll(texts: string[]): Promise<{ vectors: number[][]; configId: string | null }> {
  try {
    const { vectors, endpoint } = await embedTexts(texts);
    return { vectors, configId: endpoint.configId };
  } catch (error) {
    if (error instanceof ProviderCostUnavailable || error instanceof InsufficientCredits) throw error;
    throw new ProcessingFailure('embedding_unavailable', error instanceof Error ? error.message : 'embedding failed');
  }
}

/**
 * Runs one pending source to ready or failed. Safe to call twice: the first
 * call claims the row (pending → processing) and the second finds nothing to
 * claim.
 */
export async function processKnowledge(knowledgeId: string, options: { profile?: boolean } = {}): Promise<string | null> {
  const runId = crypto.randomUUID();
  const prices = await providerPrices();
  /* Estimates of the calls not yet answered: parallel calls reserve for each other too. */
  const inflight = new Map<symbol, string>();
  const reeId = await withProviderMeter({
    runId, prices,
    record: (charge) => recordProviderCharge(knowledgeId, charge),
    reserve: async (costUsd) => {
      const key = Symbol('estimate');
      inflight.set(key, costUsd);
      try {
        await reserveEstimate(knowledgeId, runId, [...inflight.values()]);
      } catch (error) {
        inflight.delete(key);
        throw error;
      }
      return () => { inflight.delete(key); };
    },
  }, () => processKnowledgeRun(knowledgeId, runId));
  // Profile maintenance is billed on its own run (`meteredWork`, P2), outside this source's cost scope.
  if (reeId && options.profile !== false) await afterKnowledgeReady(reeId);
  return reeId;
}

async function processKnowledgeRun(knowledgeId: string, runId: string): Promise<string | null> {
  const database = db();
  const now = new Date();
  const row = await database.transaction(async (tx) => {
    const [claimed] = await tx
    .update(schema.knowledge)
    .set({ status: 'processing', updatedAt: now, activity: appendActivity([activity('processing', { runId }, now)]) })
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.status, 'pending')))
    .returning();
    if (!claimed) return null;
    const holdId = await heldFor(tx, knowledgeId, 'knowledge');
    if (!holdId) throw new Error('knowledge reservation missing');
    await snapshotCostRun(tx, holdId, knowledgeId, now);
    await tx.update(schema.knowledgeCostRun).set({ runId, status: 'processing', metered: true }).where(eq(schema.knowledgeCostRun.id, holdId));
    return claimed;
  });
  if (!row) return null;

  try {
    const extracted = await extract(row);
    // What reading the source moved (pages fetched, the upload read back and sent on) is a receipt like any supplier's.
    await flushTransfer();
    const { content, children } = assemble(extracted.sections);
    if (!content.trim()) throw new ProcessingFailure('empty_text', 'no text extracted');
    const pages = extracted.sections.filter((section) => section.locator.page !== undefined).length;
    const chunks = extracted.chunks ?? chunkSections(extracted.sections);
    if (chunks.length === 0) throw new ProcessingFailure('empty_text', 'nothing to chunk');
    let embedded = await embedAll(chunks.map((chunk) => chunk.content));

    /*
     * A re-embed job may switch the embedding model between embedding and
     * storing: vectors from the model that is no longer in use are made
     * again rather than stored (step 5, `lib/services/reembed.ts`).
     */
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await database.transaction(async (tx) => {
        /* A run presumed dead was failed and refunded by `recoverStale`; its late result is dropped, not given away. */
        const [current] = await tx.select({ status: schema.knowledge.status, activity: schema.knowledge.activity, title: schema.knowledge.title, originalTitle: schema.knowledge.originalTitle }).from(schema.knowledge).where(eq(schema.knowledge.id, row.id)).for('update');
        if (!ownsProcessingRun(current, runId)) return 'dropped';
        const space = await storingSpace(tx, embedded.configId);
        if (space === null) return 'stale_model';
        const vectors = embedded.vectors;
        await tx.delete(schema.chunk).where(eq(schema.chunk.knowledgeId, row.id));
        for (let at = 0; at < chunks.length; at += 200) {
          await tx.insert(schema.chunk).values(
            chunks.slice(at, at + 200).map((chunk, offset) => ({
              knowledgeId: row.id,
              reeId: row.reeId,
              ordinal: chunk.ordinal,
              content: chunk.content,
              embedding: vectors[at + offset]!,
              embeddingSpace: space,
              locator: chunk.locator,
            })),
          );
        }
        const holdId = await heldFor(tx, row.id, 'knowledge');
        if (!holdId) throw new Error('knowledge reservation missing');
        // A source never becomes ready with a cost nobody can price: it would be billed as zero.
        const charges = runCharges(current!.activity, runId);
        const resolved = charges.filter((charge) => charge.costUsd !== null);
        if (resolved.length !== charges.length) throw new ProviderCostUnavailable('usage_unavailable');
        const total = providerTotal(resolved);
        const settled = await settleHold(tx, holdId, total.credits, { reeId: row.reeId, note: row.title });
        if (!settled || settled.charged !== total.credits) throw new Error('knowledge settlement mismatch');
        const done = new Date();
        await tx.update(schema.knowledgeCostRun).set({ status: 'ready', chargedCredits: settled.charged }).where(eq(schema.knowledgeCostRun.id, holdId));
        const log: KnowledgeActivity[] = extracted.log.map((entry) => ({ ...entry, at: done.toISOString() }));
        log.push(activity('parsed', pages > 0 ? { chars: content.length, pages } : { chars: content.length }, done));
        log.push(activity('chunked', { chunks: chunks.length }, done));
        log.push(activity('settled', { charged: settled.charged, released: settled.released, costUsd: total.costUsd, tariff: 'provider-cost-v1' }, done));
        log.push(activity('ready', undefined, done));
        const renamed = current!.title !== current!.originalTitle;
        const fetchedTitle = extracted.title?.trim().slice(0, KNOWLEDGE_TITLE_MAX);
        await tx
          .update(schema.knowledge)
          .set({
            status: 'ready',
            error: null,
            content: row.kind === 'text' ? row.content : content,
            children: children as KnowledgeChild[],
            ...(fetchedTitle && !renamed ? { title: fetchedTitle, originalTitle: fetchedTitle } : {}),
            updatedAt: done,
            activity: appendActivity(log),
          })
          .where(eq(schema.knowledge.id, row.id));
        return 'stored';
      });
      if (outcome === 'dropped') return null;
      if (outcome !== 'stale_model') break;
      if (attempt >= 1) throw new ProcessingFailure('embedding_unavailable', 'the embedding model switched twice while storing');
      forgetModelCache();
      embedded = await embedAll(chunks.map((chunk) => chunk.content));
    }
    /* The last step (2.4): suggested example questions and the knowledge profile, free of charge (a batch does it once at its end). */
    return row.reeId;
  } catch (error) {
    await drainProviderCalls();
    // Transfer before the failure was incurred all the same; a refusal to reserve it still leaves its receipt.
    await flushTransfer().catch(() => undefined);
    const code = error instanceof InsufficientCredits ? 'insufficient_credits' : error instanceof ProviderCostUnavailable ? error.code : error instanceof ProcessingFailure ? error.code : 'unknown';
    console.warn(`knowledge ${row.id} failed code=${code} detail=${error instanceof Error ? error.message : 'unknown'}`);
    await failAndRefund(row.id, row.reeId, row.title, code, new Date(), runId);
    return null;
  }
}

async function failAndRefund(id: string, reeId: string, title: string | null, code: string, when = new Date(), runId?: string): Promise<void> {
  await db().transaction(async (tx) => {
    const [current] = await tx.select().from(schema.knowledge).where(eq(schema.knowledge.id, id)).for('update');
    if (current?.status !== 'processing' || (runId && !ownsProcessingRun(current, runId))) return;
    const holdId = await heldFor(tx, id, 'knowledge');
    /*
     * A failure keeps every cost the run incurred (docs/audit/credit-import-audit.md,
     * P1): its resolved receipts are charged, the call that overran the
     * balance included, and only what was reserved and never used goes back.
     * What the balance cannot cover is owed. A run with nothing spent is
     * refunded in full.
     */
    const failedRun = runId ?? processingRun(current);
    const charges = failedRun ? runCharges(current.activity, failedRun) : [];
    const settled = holdId ? await settleRun(tx, holdId, charges, { reeId, note: title }) : null;
    if (holdId || failedRun) await tx.update(schema.knowledgeCostRun).set({ status: 'failed', error: code, chargedCredits: settled?.charged ?? 0 })
      .where(holdId ? eq(schema.knowledgeCostRun.id, holdId) : eq(schema.knowledgeCostRun.runId, failedRun!));
    const log: KnowledgeActivity[] = [activity('failed', { reason: code }, when)];
    if (settled && !settled.refunded) log.push(activity('settled', { charged: settled.charged, released: settled.released, ...(settled.owed > 0 ? { owed: settled.owed } : {}) }, when));
    if (settled?.refunded) log.push(activity('refunded', { credits: settled.released }, when));
    await tx
      .update(schema.knowledge)
      .set({ status: 'failed', error: code, updatedAt: when, activity: appendActivity(log) })
      .where(and(eq(schema.knowledge.id, id), eq(schema.knowledge.status, 'processing')));
  });
}

/** Several sources, two at a time (a batch reprocess), inside one function run; each Ree's profile is rebuilt once at the end. */
export async function processMany(ids: readonly string[]): Promise<void> {
  const queue = [...ids];
  const ready = new Set<string>();
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      const reeId = await processKnowledge(id, { profile: false });
      if (reeId) ready.add(reeId);
    }
  };
  await Promise.all([worker(), worker()]);
  for (const reeId of ready) await afterKnowledgeReady(reeId);
}

/* -------------------------------------------------------------------- read */

export const KNOWLEDGE_STATUSES = ['all', 'ready', 'processing', 'failed', 'paused'] as const;
export const KNOWLEDGE_KINDS = ['all', 'document', 'audio', 'github', 'page', 'site', 'text'] as const;
/** The prototype's `sort` values first; step 1's names stay readable. */
export const KNOWLEDGE_SORTS = ['new', 'old', 'title'] as const;
export const KNOWLEDGE_SORT_ALIASES: Record<string, (typeof KNOWLEDGE_SORTS)[number]> = { recent: 'new', oldest: 'old', name: 'title' };
export type KnowledgeTab = (typeof KNOWLEDGE_STATUSES)[number];
export type KnowledgeSort = (typeof KNOWLEDGE_SORTS)[number];

export interface KnowledgeQuery {
  q: string;
  status: KnowledgeTab;
  kind: string;
  sort: string;
  size: number;
  page: number;
  /** `all`, `unfiled`, or a folder id. */
  folder?: string;
  /** The trash instead of the library. */
  trash?: boolean;
}

export interface KnowledgeListItem {
  id: string;
  title: string;
  kind: KnowledgeKind;
  status: string;
  error: string | null;
  enabled: boolean;
  folderId: string | null;
  source: string | null;
  fileName: string | null;
  fileSize: number | null;
  chars: number;
  chunks: number;
  children: number;
  /** Seconds, for audio. */
  duration: number | null;
  deletedAt: Date | null;
  updatedAt: Date;
}

function scopeConditions(reeId: string, query: Pick<KnowledgeQuery, 'q' | 'kind' | 'folder' | 'trash'>): SQL[] {
  const conditions: SQL[] = [eq(schema.knowledge.reeId, reeId)];
  conditions.push(query.trash ? isNotNull(schema.knowledge.deletedAt) : isNull(schema.knowledge.deletedAt));
  if (query.kind && query.kind !== 'all') conditions.push(eq(schema.knowledge.kind, query.kind as KnowledgeKind));
  if (query.folder === 'unfiled') conditions.push(isNull(schema.knowledge.folderId));
  else if (query.folder && query.folder !== 'all') conditions.push(eq(schema.knowledge.folderId, query.folder));
  if (query.q) {
    const pattern = likePattern(query.q);
    conditions.push(
      or(
        ilike(schema.knowledge.title, pattern),
        ilike(schema.knowledge.source, pattern),
        ilike(schema.knowledge.fileName, pattern),
        ilike(schema.knowledge.content, pattern),
        sql`${schema.knowledge.children}::text ilike ${pattern}`,
      )!,
    );
  }
  return conditions;
}

function statusCondition(status: KnowledgeTab): SQL | null {
  if (status === 'ready') return eq(schema.knowledge.status, 'ready');
  if (status === 'processing') return inArray(schema.knowledge.status, ['pending', 'processing']);
  if (status === 'failed') return eq(schema.knowledge.status, 'failed');
  if (status === 'paused') return eq(schema.knowledge.enabled, false);
  return null;
}

function orderFor(sort: string): SQL[] {
  if (sort === 'old') return [asc(schema.knowledge.createdAt), asc(schema.knowledge.id)];
  if (sort === 'title') return [asc(sql`lower(${schema.knowledge.title})`), desc(schema.knowledge.updatedAt), asc(schema.knowledge.id)];
  return [desc(schema.knowledge.updatedAt), asc(schema.knowledge.id)];
}

/** A folder filter that names no folder of this Ree falls back to all (prototype `view`). */
async function validFolder(reeId: string, folder: string | undefined): Promise<string> {
  if (!folder || folder === 'all' || folder === 'unfiled') return folder ?? 'all';
  if (!/^[0-9a-f-]{36}$/i.test(folder)) return 'all';
  const [row] = await db()
    .select({ id: schema.knowledgeFolder.id })
    .from(schema.knowledgeFolder)
    .where(and(eq(schema.knowledgeFolder.id, folder), eq(schema.knowledgeFolder.reeId, reeId)))
    .limit(1);
  return row ? folder : 'all';
}

export interface KnowledgeListResult extends ListResult<KnowledgeListItem> {
  counts: Record<KnowledgeTab | 'trash', number>;
  folder: string;
  folders: { id: string; name: string; count: number }[];
  folderCounts: { all: number; unfiled: number };
}

/**
 * The library page: one page of rows plus the tab counts (in the current
 * folder, search and type) and the folder counts (of the library or the
 * trash, whichever is shown).
 */
export async function listKnowledge(reeId: string, query: KnowledgeQuery): Promise<KnowledgeListResult> {
  const database = db();
  const folder = await validFolder(reeId, query.folder);
  const base = scopeConditions(reeId, { ...query, folder, trash: false });
  const [counts] = await database
    .select({
      all: sql<number>`count(*)::int`,
      ready: sql<number>`count(*) filter (where ${schema.knowledge.status} = 'ready')::int`,
      processing: sql<number>`count(*) filter (where ${schema.knowledge.status} in ('pending', 'processing'))::int`,
      failed: sql<number>`count(*) filter (where ${schema.knowledge.status} = 'failed')::int`,
      paused: sql<number>`count(*) filter (where not ${schema.knowledge.enabled})::int`,
    })
    .from(schema.knowledge)
    .where(and(...base));
  const [trashCount] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.knowledge)
    .where(and(...scopeConditions(reeId, { ...query, folder, trash: true })));
  const tabCounts = { ...(counts ?? { all: 0, ready: 0, processing: 0, failed: 0, paused: 0 }), trash: trashCount?.n ?? 0 };

  const conditions = scopeConditions(reeId, { ...query, folder });
  const status = query.trash ? null : statusCondition(query.status);
  if (status) conditions.push(status);
  const total = query.trash ? tabCounts.trash : tabCounts[query.status];
  const size = (LIST_PAGE_SIZES as readonly number[]).includes(query.size) ? query.size : LIST_PAGE_SIZES[0];
  const page = clampPage(query.page, total, size);
  const items = await database
    .select({
      id: schema.knowledge.id,
      title: schema.knowledge.title,
      kind: schema.knowledge.kind,
      status: schema.knowledge.status,
      error: schema.knowledge.error,
      enabled: schema.knowledge.enabled,
      folderId: schema.knowledge.folderId,
      source: sql<string | null>`case when ${schema.knowledge.kind} in ('github', 'page', 'site') then ${schema.knowledge.source} end`,
      fileName: schema.knowledge.fileName,
      fileSize: schema.knowledge.fileSize,
      chars: sql<number>`coalesce(length(${schema.knowledge.content}), 0)::int`,
      chunks: sql<number>`(select count(*)::int from ${schema.chunk} c where c.knowledge_id = "knowledge"."id")`,
      children: sql<number>`jsonb_array_length(${schema.knowledge.children})::int`,
      duration: sql<number | null>`case when ${schema.knowledge.kind} = 'audio' then (${schema.knowledge.children} -> -1 ->> 'end')::float end`,
      deletedAt: schema.knowledge.deletedAt,
      updatedAt: schema.knowledge.updatedAt,
    })
    .from(schema.knowledge)
    .where(and(...conditions))
    .orderBy(...orderFor(query.sort))
    .limit(size)
    .offset((page - 1) * size);

  /* Folder counts: everything in the library (or the trash), no other filter. */
  const view = query.trash ? isNotNull(schema.knowledge.deletedAt) : isNull(schema.knowledge.deletedAt);
  const perFolder = await database
    .select({ folderId: schema.knowledge.folderId, n: sql<number>`count(*)::int` })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, reeId), view))
    .groupBy(schema.knowledge.folderId);
  const folderRows = await database
    .select({ id: schema.knowledgeFolder.id, name: schema.knowledgeFolder.name })
    .from(schema.knowledgeFolder)
    .where(eq(schema.knowledgeFolder.reeId, reeId))
    .orderBy(asc(schema.knowledgeFolder.createdAt));
  const countOf = new Map(perFolder.map((row) => [row.folderId, row.n]));
  return {
    items,
    total,
    page,
    size,
    counts: tabCounts,
    folder,
    folders: folderRows.map((row) => ({ ...row, count: countOf.get(row.id) ?? 0 })),
    folderCounts: { all: perFolder.reduce((sum, row) => sum + row.n, 0), unfiled: countOf.get(null) ?? 0 },
  };
}

async function matchingConditions(reeId: string, query: Omit<KnowledgeQuery, 'size' | 'page'>): Promise<SQL[]> {
  const folder = await validFolder(reeId, query.folder);
  const conditions = scopeConditions(reeId, { ...query, folder });
  const status = query.trash ? null : statusCondition(query.status);
  if (status) conditions.push(status);
  return conditions;
}

/** Every id the filters match, in list order, for the preview's previous / next (at most one batch's worth). */
export async function matchingIds(reeId: string, query: Omit<KnowledgeQuery, 'size' | 'page'>): Promise<string[]> {
  const rows = await db()
    .select({ id: schema.knowledge.id })
    .from(schema.knowledge)
    .where(and(...(await matchingConditions(reeId, query))))
    .orderBy(...orderFor(query.sort))
    .limit(KNOWLEDGE_BATCH_MAX);
  return rows.map((row) => row.id);
}

/** What a batch dialog needs to list and price a source. */
export type KnowledgeActionItem = Pick<KnowledgeListItem, 'id' | 'title' | 'kind' | 'status' | 'enabled' | 'folderId' | 'fileSize' | 'chars' | 'deletedAt'>;

/**
 * "选择全部 N 个筛选结果": the first batch's worth of matching sources, in
 * list order, with what the dialogs show -- one query, so the selection is
 * ready to act on without paging through the list.
 */
export async function matchingItems(reeId: string, query: Omit<KnowledgeQuery, 'size' | 'page'>): Promise<KnowledgeActionItem[]> {
  return db()
    .select({
      id: schema.knowledge.id,
      title: schema.knowledge.title,
      kind: schema.knowledge.kind,
      status: schema.knowledge.status,
      enabled: schema.knowledge.enabled,
      folderId: schema.knowledge.folderId,
      fileSize: schema.knowledge.fileSize,
      chars: sql<number>`coalesce(length(${schema.knowledge.content}), 0)::int`,
      deletedAt: schema.knowledge.deletedAt,
    })
    .from(schema.knowledge)
    .where(and(...(await matchingConditions(reeId, query))))
    .orderBy(...orderFor(query.sort))
    .limit(KNOWLEDGE_BATCH_MAX);
}

export interface KnowledgeDetail {
  id: string;
  title: string;
  originalTitle: string;
  kind: KnowledgeKind;
  status: string;
  error: string | null;
  enabled: boolean;
  folderId: string | null;
  folderName: string | null;
  source: string | null;
  fileName: string | null;
  fileSize: number | null;
  chars: number;
  /** The extracted text; for websites and repositories it comes per page / file instead. */
  content: string | null;
  children: KnowledgeChild[];
  activity: KnowledgeActivity[];
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  chunks: { id: string; ordinal: number; content: string; locator: Locator }[];
  chunkTotal: number;
}

/** One source for the preview (trash included, so a trashed source can still be read). */
export async function knowledgeDetail(reeId: string, knowledgeId: string): Promise<KnowledgeDetail | null> {
  if (!/^[0-9a-f-]{36}$/i.test(knowledgeId)) return null;
  const database = db();
  const [row] = await database
    .select({ knowledge: schema.knowledge, folderName: schema.knowledgeFolder.name })
    .from(schema.knowledge)
    .leftJoin(schema.knowledgeFolder, eq(schema.knowledgeFolder.id, schema.knowledge.folderId))
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.reeId, reeId)))
    .limit(1);
  if (!row) return null;
  const k = row.knowledge;
  const chunks = await database
    .select({ id: schema.chunk.id, ordinal: schema.chunk.ordinal, content: schema.chunk.content, locator: schema.chunk.locator })
    .from(schema.chunk)
    .where(eq(schema.chunk.knowledgeId, knowledgeId))
    .orderBy(asc(schema.chunk.ordinal))
    .limit(PREVIEW_CHUNKS_MAX);
  const [count] = await database.select({ n: sql<number>`count(*)::int` }).from(schema.chunk).where(eq(schema.chunk.knowledgeId, knowledgeId));
  const perChild = k.kind === 'site' || k.kind === 'github';
  return {
    id: k.id,
    title: k.title,
    originalTitle: k.originalTitle,
    kind: k.kind,
    status: k.status,
    error: k.error,
    enabled: k.enabled,
    folderId: k.folderId,
    folderName: row.folderName,
    /* Blob paths are ours, not the owner's; only URLs are shown. */
    source: k.kind === 'github' || k.kind === 'page' || k.kind === 'site' ? k.source : null,
    fileName: k.fileName,
    fileSize: k.fileSize,
    chars: k.content?.length ?? 0,
    content: perChild ? null : k.content,
    children: k.children,
    activity: k.activity,
    deletedAt: k.deletedAt,
    createdAt: k.createdAt,
    updatedAt: k.updatedAt,
    chunks,
    chunkTotal: count?.n ?? 0,
  };
}

/**
 * One page of a website or one file of a repository: its slice of the stored
 * text. Sliced here, not in SQL: offsets are JavaScript string offsets, and
 * Postgres counts characters differently once a page has an emoji in it.
 */
export async function knowledgeChild(reeId: string, knowledgeId: string, index: number): Promise<{ child: KnowledgeChild; content: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(knowledgeId) || !Number.isInteger(index) || index < 0) return null;
  const [row] = await db()
    .select({ child: sql<KnowledgeChild | null>`${schema.knowledge.children} -> ${index}::int`, content: schema.knowledge.content })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.reeId, reeId)))
    .limit(1);
  const child = row?.child;
  if (!child) return null;
  return { child, content: (row.content ?? '').slice(child.offset, child.offset + child.length) };
}

/** Just enough for a page title: the name and kind, trash included. */
export async function knowledgeHeader(reeId: string, knowledgeId: string): Promise<{ title: string; kind: KnowledgeKind } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(knowledgeId)) return null;
  const [row] = await db()
    .select({ title: schema.knowledge.title, kind: schema.knowledge.kind })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.reeId, reeId)))
    .limit(1);
  return row ?? null;
}

/** The whole extracted text and a file name for it ("下载解析文本"). */
export async function knowledgeText(reeId: string, knowledgeId: string): Promise<{ title: string; content: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(knowledgeId)) return null;
  const [row] = await db()
    .select({ title: schema.knowledge.title, content: schema.knowledge.content })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.reeId, reeId)))
    .limit(1);
  return row ? { title: row.title, content: row.content ?? '' } : null;
}

/** The stored upload of a document or audio source, for playback and download. */
export async function knowledgeFile(reeId: string, knowledgeId: string): Promise<{ pathname: string; fileName: string; kind: KnowledgeKind } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(knowledgeId)) return null;
  const [row] = await db()
    .select({ kind: schema.knowledge.kind, source: schema.knowledge.source, fileName: schema.knowledge.fileName })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.id, knowledgeId), eq(schema.knowledge.reeId, reeId)))
    .limit(1);
  if (!row || (row.kind !== 'document' && row.kind !== 'audio') || !row.source || !row.fileName) return null;
  return { pathname: row.source, fileName: row.fileName, kind: row.kind };
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
    .select({ id: schema.knowledge.id, title: schema.knowledge.title, activity: schema.knowledge.activity })
    .from(schema.knowledge)
    .where(
      and(
        eq(schema.knowledge.reeId, reeId),
        eq(schema.knowledge.status, 'processing'),
        sql`${schema.knowledge.updatedAt} < ${new Date(now.getTime() - STALE_PROCESSING_MS)}`,
      ),
    );
  for (const { id, title, activity: log } of dead) {
    await failAndRefund(id, reeId, title, 'unknown', now, processingRun({ activity: log }));
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

/**
 * A deleted Ree's sources that are waiting to be processed will never be
 * (nobody can reach the Ree to start them): each is failed as `ree_deleted`
 * and its reservation goes back in full -- nothing was spent before a run
 * starts. A run that claims the row meanwhile wins (the row is no longer
 * `pending`). Called by the trash purge before it removes the Ree's knowledge.
 */
export async function abandonPending(reeId: string, now = new Date()): Promise<number> {
  const waiting = await db()
    .select({ id: schema.knowledge.id, title: schema.knowledge.title })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, reeId), eq(schema.knowledge.status, 'pending'), sql`${schema.knowledge.updatedAt} < ${new Date(now.getTime() - STALE_PENDING_MS)}`));
  let abandoned = 0;
  for (const { id, title } of waiting) {
    await db().transaction(async (tx) => {
      const [current] = await tx.select({ status: schema.knowledge.status }).from(schema.knowledge).where(eq(schema.knowledge.id, id)).for('update');
      if (current?.status !== 'pending') return;
      const holdId = await heldFor(tx, id, 'knowledge');
      const settled = holdId ? await settleRun(tx, holdId, [], { reeId, note: title }) : null;
      if (holdId) await tx.update(schema.knowledgeCostRun).set({ status: 'failed', error: 'ree_deleted', chargedCredits: 0 }).where(eq(schema.knowledgeCostRun.id, holdId));
      const log: KnowledgeActivity[] = [activity('failed', { reason: 'ree_deleted' }, now)];
      if (settled?.refunded) log.push(activity('refunded', { credits: settled.released }, now));
      await tx.update(schema.knowledge).set({ status: 'failed', error: 'ree_deleted', updatedAt: now, activity: appendActivity(log) }).where(eq(schema.knowledge.id, id));
      abandoned += 1;
    });
  }
  return abandoned;
}

/**
 * The cron's share of `recoverStale`: dead runs in every Ree, not only the
 * ones whose owner opens the list, so a reservation never stays frozen
 * because nobody looked. Answers how many Rees it swept (at most `limit`).
 * Waiting rows are left for the list to start (it runs them after the response).
 */
export async function recoverStaleEverywhere(now = new Date(), limit = 50): Promise<number> {
  const rees = await db()
    .selectDistinct({ reeId: schema.knowledge.reeId })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.status, 'processing'), sql`${schema.knowledge.updatedAt} < ${new Date(now.getTime() - STALE_PROCESSING_MS)}`))
    .limit(limit);
  for (const { reeId } of rees) await recoverStale(reeId, now);
  return rees.length;
}

/** What answers can draw on: ready, enabled and not in the trash; and what is still being prepared. */
export async function readiness(reeId: string): Promise<{ ready: number; processing: number }> {
  const [row] = await db()
    .select({
      ready: sql<number>`count(*) filter (where ${schema.knowledge.status} = 'ready' and ${schema.knowledge.enabled})::int`,
      processing: sql<number>`count(*) filter (where ${schema.knowledge.status} in ('pending', 'processing'))::int`,
    })
    .from(schema.knowledge)
    .where(and(eq(schema.knowledge.reeId, reeId), isNull(schema.knowledge.deletedAt)));
  return row ?? { ready: 0, processing: 0 };
}

/**
 * What a reviewer may read of a public user library, and the one thing
 * they may do to it short of deciding: ask it a question.
 * review-visibility-proposal.md 3, 4.1, 4.2 and 4.4; requirement.md 3.1
 * ("Reviewer: sees what the review needs") and 7.4.
 *
 * The content shown is the content that will be served: the documents and
 * chunks of the current version, never the uploaded originals. A private
 * library is never reviewed, so nothing here opens one -- `reviewable`
 * answers null for it exactly as for a platform or a deleted library, and
 * every reader goes through that gate first.
 *
 * Reading leaves a trace. A reviewer's look at a document and a probe are
 * audit entries (7.4: every review action is logged); the probe's question
 * is kept as a digest only, like a caller's query (architecture.md 17.1).
 */
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { documentPreview, type DocumentPreview } from '@/lib/application/libraries/documents';
import {
  defaultRetrievalDependencies,
  type RetrievalDependencies,
} from '@/lib/application/retrieval/query-docs';
import { rankChunks } from '@/lib/application/retrieval/rank';
import { PlatformLibraryRefused } from '@/lib/domain/library';
import { isSafetyFinding, type SafetyFinding } from '@/lib/domain/ingestion';
import { DEFAULT_RETRIEVAL_SETTINGS } from '@/lib/domain/retrieval-config';
import { REVIEW_PROBE_MAX_LENGTH } from '@/lib/domain/review';
import type { Visibility } from '@/lib/domain';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { originDigest, recordAudit } from './audit';
import type { PlatformActor } from './manage-platform-libraries';

const AUDIT_TARGET = 'user_library';

/** The same budget a caller gets by default (contracts/schemas.ts), so the ranks match theirs. */
const PROBE_MAX_TOKENS = 4000;
/** How many flagged documents the safety panel lists. */
const FLAGGED_LIMIT = 50;

export interface ReviewableLibrary {
  id: string;
  publicId: string;
  visibility: Visibility;
  currentVersionId: string | null;
}

/**
 * The library, if a reviewer may read its content: a user library that is
 * public and not deleted. Null otherwise, with no distinction between
 * "private" and "does not exist" -- a private library's existence is the
 * owner's business.
 */
export async function reviewable(libraryId: string): Promise<ReviewableLibrary | null> {
  if (!isUuid(libraryId)) return null;
  const [row] = await db()
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      visibility: schema.library.visibility,
      currentVersionId: schema.library.currentVersionId,
      isPlatformLibrary: schema.library.isPlatformLibrary,
    })
    .from(schema.library)
    .where(and(eq(schema.library.id, libraryId), isNull(schema.library.deletedAt)))
    .limit(1);
  if (!row || row.isPlatformLibrary || row.visibility !== 'public') return null;
  return { id: row.id, publicId: row.publicId, visibility: row.visibility, currentVersionId: row.currentVersionId };
}

/* --------------------------------------------------------------- documents */

export interface ReviewDocumentRow {
  id: string;
  title: string;
  sourceUrl: string;
  chunks: number;
  /** Chunks the scan marked `flagged`; served, but worth a look. */
  flaggedChunks: number;
  safetyFindings: SafetyFinding[];
}

/** The current version's documents, a page at a time, with what the scan found in each. */
export async function listReviewDocuments(input: {
  libraryId: string;
  versionId: string;
  limit: number;
  offset: number;
}): Promise<{ documents: ReviewDocumentRow[]; total: number }> {
  if (!isUuid(input.libraryId) || !isUuid(input.versionId)) return { documents: [], total: 0 };
  const database = db();
  const scope = and(
    eq(schema.document.libraryId, input.libraryId),
    eq(schema.document.versionId, input.versionId),
  );
  const [rows, [totalRow]] = await Promise.all([
    database
      .select({
        id: schema.document.id,
        title: schema.document.title,
        sourceUrl: schema.document.sourceUrl,
        safetyFindings: schema.document.safetyFindings,
        chunks: count(schema.chunk.id),
        flaggedChunks: sql<number>`count(*) filter (where ${schema.chunk.safetyStatus} = 'flagged')::int`,
      })
      .from(schema.document)
      .leftJoin(schema.chunk, eq(schema.chunk.documentId, schema.document.id))
      .where(scope)
      .groupBy(schema.document.id)
      .orderBy(asc(schema.document.sourceUrl), asc(schema.document.id))
      .limit(input.limit)
      .offset(input.offset),
    database.select({ n: count() }).from(schema.document).where(scope),
  ]);
  return {
    documents: rows.map((row) => ({ ...row, safetyFindings: findings(row.safetyFindings) })),
    total: totalRow?.n ?? 0,
  };
}

/** The documents the scan flagged, for the safety panel: what fired, and where. */
export async function listFlaggedDocuments(input: {
  libraryId: string;
  versionId: string;
}): Promise<ReviewDocumentRow[]> {
  if (!isUuid(input.libraryId) || !isUuid(input.versionId)) return [];
  const rows = await db()
    .select({
      id: schema.document.id,
      title: schema.document.title,
      sourceUrl: schema.document.sourceUrl,
      safetyFindings: schema.document.safetyFindings,
      chunks: count(schema.chunk.id),
      flaggedChunks: sql<number>`count(*) filter (where ${schema.chunk.safetyStatus} = 'flagged')::int`,
    })
    .from(schema.document)
    .leftJoin(schema.chunk, eq(schema.chunk.documentId, schema.document.id))
    .where(
      and(
        eq(schema.document.libraryId, input.libraryId),
        eq(schema.document.versionId, input.versionId),
      ),
    )
    .groupBy(schema.document.id)
    .having(
      sql`jsonb_array_length(${schema.document.safetyFindings}) > 0 or count(*) filter (where ${schema.chunk.safetyStatus} = 'flagged') > 0`,
    )
    .orderBy(asc(schema.document.sourceUrl), asc(schema.document.id))
    .limit(FLAGGED_LIMIT);
  return rows.map((row) => ({ ...row, safetyFindings: findings(row.safetyFindings) }));
}

export interface ReviewDocument extends DocumentPreview {
  safetyFindings: SafetyFinding[];
}

/**
 * One document as its chunks, for the reviewer to read, and the look is
 * recorded. The library gate runs first, so a document id from a private
 * or a platform library is not found here even though the row exists.
 */
export async function readReviewDocument(input: {
  actor: PlatformActor;
  libraryId: string;
  documentId: string;
}): Promise<ReviewDocument | null> {
  const library = await reviewable(input.libraryId);
  if (!library) return null;
  const preview = await documentPreview({ libraryId: library.id, documentId: input.documentId });
  if (!preview) return null;
  const [row] = await db()
    .select({ safetyFindings: schema.document.safetyFindings })
    .from(schema.document)
    .where(eq(schema.document.id, preview.id))
    .limit(1);
  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'user_library.view_document',
    targetType: AUDIT_TARGET,
    targetId: library.id,
    afterValue: { publicId: library.publicId, documentId: preview.id, versionId: preview.versionId },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });
  return { ...preview, safetyFindings: findings(row?.safetyFindings) };
}

/* ------------------------------------------------------------------- probe */

export interface ProbeResult {
  query: string;
  chunks: {
    text: string;
    score: number;
    tokens: number;
    sourceUrl: string;
    documentTitle: string;
    section: string | null;
  }[];
  confidence: { bestDistance: number | null; keywordHits: number };
}

export type ProbeDependencies = Pick<RetrievalDependencies, 'embeddings' | 'rerank' | 'configured' | 'settings'>;

/**
 * Ask the library a question as a caller would, with none of what a call
 * is: no policy, no reservation, no usage event, no cache, no request log.
 * The same path as the build's benchmark evaluation (ingestion/evaluate.ts),
 * which is what makes the ranks the reviewer sees the ranks a caller gets.
 * Works on a library in any lifecycle state, since the point is to read a
 * library that is *not* published yet.
 */
export async function probeReviewLibrary(input: {
  actor: PlatformActor;
  libraryId: string;
  query: string;
  dependencies?: ProbeDependencies;
}): Promise<ProbeResult> {
  const library = await reviewable(input.libraryId);
  if (!library) throw new PlatformLibraryRefused('not_found', 'no such library');
  const query = input.query.trim().slice(0, REVIEW_PROBE_MAX_LENGTH);
  if (query.length === 0) throw new PlatformLibraryRefused('reason_required', 'a question is needed');
  if (!library.currentVersionId) throw new PlatformLibraryRefused('no_version', 'nothing has been built to ask');

  const database = db();
  const [version] = await database
    .select({
      id: schema.libraryVersion.id,
      searchConfig: schema.libraryVersion.searchConfig,
      embeddingModel: schema.libraryVersion.embeddingModel,
      embeddingDimensions: schema.libraryVersion.embeddingDimensions,
      indexStatus: schema.libraryVersion.indexStatus,
    })
    .from(schema.libraryVersion)
    .where(eq(schema.libraryVersion.id, library.currentVersionId))
    .limit(1);
  if (!version || version.indexStatus !== 'ready') {
    throw new PlatformLibraryRefused('no_ready_version', 'the current version is not indexed');
  }

  const dependencies = input.dependencies ?? defaultRetrievalDependencies();
  const settings = dependencies.settings ? await dependencies.settings() : DEFAULT_RETRIEVAL_SETTINGS;
  const { chunks, confidence } = await rankChunks(
    database,
    { libraryId: library.id, version, query, maxTokens: PROBE_MAX_TOKENS },
    dependencies,
    settings,
  );

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'user_library.probe',
    targetType: AUDIT_TARGET,
    targetId: library.id,
    afterValue: {
      publicId: library.publicId,
      versionId: version.id,
      queryDigest: await originDigest(query),
      results: chunks.length,
    },
    clientAddress: input.actor.clientAddress ?? null,
    result: 'success',
  });

  return {
    query,
    chunks: chunks.map((chunk) => ({
      text: chunk.text,
      score: chunk.score,
      tokens: chunk.tokens,
      sourceUrl: chunk.citation.sourceUrl,
      documentTitle: chunk.citation.documentTitle,
      section: sectionOf(chunk.citation),
    })),
    confidence: { bestDistance: confidence.bestDistance, keywordHits: confidence.keywordHits },
  };
}

/* ------------------------------------------------------------------ scores */

export interface ReviewScore {
  trustScore: number;
  benchmarkScore: number;
  breakdown: Record<string, number>;
  computedAt: Date;
}

/** The newest score row, which is what the catalogue would show once published. */
export async function reviewScore(libraryId: string): Promise<ReviewScore | null> {
  if (!isUuid(libraryId)) return null;
  const [row] = await db()
    .select({
      trustScore: schema.libraryScore.trustScore,
      benchmarkScore: schema.libraryScore.benchmarkScore,
      breakdown: schema.libraryScore.breakdown,
      computedAt: schema.libraryScore.computedAt,
    })
    .from(schema.libraryScore)
    .where(eq(schema.libraryScore.libraryId, libraryId))
    .orderBy(desc(schema.libraryScore.computedAt))
    .limit(1);
  return row ?? null;
}

/* ----------------------------------------------------------------- helpers */

function findings(value: unknown): SafetyFinding[] {
  return Array.isArray(value) ? value.filter(isSafetyFinding) : [];
}

function sectionOf(citation: Record<string, unknown>): string | null {
  const section = citation.section;
  return typeof section === 'string' && section.trim() ? section : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

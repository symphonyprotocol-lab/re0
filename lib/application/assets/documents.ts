/**
 * The documents of one version, and one document's text -- read from the
 * chunk table, which is what retrieval reads, rather than from the normalized
 * object in storage. What an operator previews is then exactly what a query
 * can return, and the preview needs no object-store round trip.
 *
 * Neither function checks who is asking: the callers already resolved the
 * asset through their own ownership-aware loaders (the workspace detail,
 * the platform detail) and pass its id on. Both take the asset id as well
 * as the narrower id, so a document id from another asset answers nothing.
 */
import { and, asc, count, eq } from 'drizzle-orm';
import { db, schema } from '@/lib/infrastructure/postgres/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Page sizes a documents panel offers; the first is the default. */
export const DOCUMENTS_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DOCUMENTS_PAGE_SIZE: number = DOCUMENTS_PAGE_SIZES[0];

/** Which page of documents `?docs=` asks for: a positive integer, else the first. */
export function documentsPage(value: string | string[] | undefined): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** How many per page `?size=` asks for: one of the offered sizes, else the default. */
export function documentsPageSize(value: string | string[] | undefined): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return (DOCUMENTS_PAGE_SIZES as readonly number[]).includes(n) ? n : DOCUMENTS_PAGE_SIZE;
}

export interface VersionDocument {
  id: string;
  title: string;
  sourceUrl: string;
  chunks: number;
}

export async function listVersionDocuments(input: {
  assetId: string;
  versionId: string;
  limit?: number;
  offset?: number;
}): Promise<{ documents: VersionDocument[]; total: number }> {
  if (!UUID.test(input.assetId) || !UUID.test(input.versionId)) return { documents: [], total: 0 };
  const database = db();
  const scope = and(
    eq(schema.document.assetId, input.assetId),
    eq(schema.document.versionId, input.versionId),
  );
  const [rows, [totalRow]] = await Promise.all([
    database
      .select({
        id: schema.document.id,
        title: schema.document.title,
        sourceUrl: schema.document.sourceUrl,
        chunks: count(schema.chunk.id),
      })
      .from(schema.document)
      .leftJoin(schema.chunk, eq(schema.chunk.documentId, schema.document.id))
      .where(scope)
      .groupBy(schema.document.id)
      /* `source_url` repeats across documents, so it cannot order a page on its
         own: two rows sharing one url may swap between offsets and be skipped or
         served twice. The id is unique and settles it. */
      .orderBy(asc(schema.document.sourceUrl), asc(schema.document.id))
      .limit(input.limit ?? DOCUMENTS_PAGE_SIZE)
      .offset(input.offset ?? 0),
    database.select({ n: count() }).from(schema.document).where(scope),
  ]);
  return { documents: rows, total: totalRow?.n ?? 0 };
}

export interface DocumentPreview {
  id: string;
  title: string;
  sourceUrl: string;
  versionId: string;
  chunks: { ordinal: number; tokens: number; body: string; heading: string | null }[];
}

export async function documentPreview(input: {
  assetId: string;
  documentId: string;
}): Promise<DocumentPreview | null> {
  if (!UUID.test(input.assetId) || !UUID.test(input.documentId)) return null;
  const database = db();
  const [document] = await database
    .select({
      id: schema.document.id,
      title: schema.document.title,
      sourceUrl: schema.document.sourceUrl,
      versionId: schema.document.versionId,
    })
    .from(schema.document)
    .where(and(eq(schema.document.id, input.documentId), eq(schema.document.assetId, input.assetId)))
    .limit(1);
  if (!document) return null;

  const chunks = await database
    .select({
      ordinal: schema.chunk.ordinal,
      tokens: schema.chunk.tokens,
      body: schema.chunk.body,
      citation: schema.chunk.citation,
    })
    .from(schema.chunk)
    .where(eq(schema.chunk.documentId, document.id))
    .orderBy(asc(schema.chunk.ordinal));

  return {
    ...document,
    chunks: chunks.map((chunk) => ({
      ordinal: chunk.ordinal,
      tokens: chunk.tokens,
      body: chunk.body,
      heading: headingOf(chunk.citation),
    })),
  };
}

/** The section a chunk cites (`Citation.section`), when it names one. */
function headingOf(citation: Record<string, unknown>): string | null {
  return typeof citation.section === 'string' && citation.section.trim() ? citation.section : null;
}

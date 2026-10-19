/**
 * What the rewrite-on-miss is told about the libraries it rewrites for.
 * architecture.md 9.6: the profile (`library_profile`, the build's `profile`
 * step) is the content-derived description of a library -- page titles and
 * the vocabulary that sets it apart -- and that is exactly what a question
 * has to be restated into.
 *
 * Read by public id, live rows only, for libraries the exchange has already
 * read: the caller's right to see each one was enforced by the retrieval
 * that just ran (query-docs.ts), so this reader adds no gate of its own and
 * must only be handed libraries that retrieval did not refuse. A library
 * without a profile still contributes its title and description.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { REWRITE_LIMITS, type RewriteHint } from '@/lib/domain/generation';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export async function libraryRewriteHints(publicIds: readonly string[]): Promise<RewriteHint[]> {
  if (publicIds.length === 0) return [];
  const rows = await db()
    .select({
      publicId: schema.library.publicId,
      title: schema.library.title,
      description: schema.library.description,
      language: schema.library.language,
      documentTitles: schema.libraryProfile.documentTitles,
      terms: schema.libraryProfile.terms,
    })
    .from(schema.library)
    .leftJoin(
      schema.libraryProfile,
      eq(schema.libraryProfile.versionId, schema.library.currentVersionId),
    )
    .where(and(inArray(schema.library.publicId, [...publicIds]), isNull(schema.library.deletedAt)));

  /* In the order the exchange routed them: the top candidate first. */
  const byId = new Map(rows.map((row) => [row.publicId, row]));
  return publicIds.flatMap((publicId) => {
    const row = byId.get(publicId);
    if (!row) return [];
    return [
      {
        libraryId: publicId,
        title: row.title,
        description: row.description,
        language: row.language,
        documentTitles: (row.documentTitles ?? []).slice(0, REWRITE_LIMITS.maxTitles),
        terms: (row.terms ?? []).slice(0, REWRITE_LIMITS.maxTerms),
        /* The retrieval that just missed supplies these (playground/index.ts). */
        excerpts: [],
      },
    ];
  });
}

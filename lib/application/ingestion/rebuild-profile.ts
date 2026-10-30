/**
 * Rebuild a version's profile from its stored content. architecture.md 6.4:
 * the profile is derived data, and a smarter extractor (a new
 * PROFILE_VERSION) means the rows written by the old one are stale, not
 * wrong -- the build wrote them; the build is the only other place they are
 * written, and a build only runs when the source changed.
 *
 * Titles come from the document rows and terms from the chunk bodies, as in
 * the build. The centroid vectors are left alone: they derive from the
 * embeddings, which the extractor does not touch.
 */
import { and, eq, ne, or, isNull } from 'drizzle-orm';
import { uuidv7 } from '@/lib/domain/id';
import {
  extractTerms,
  PROFILE_LIMITS,
  PROFILE_VERSION,
  profileSearchText,
} from '@/lib/domain/profile';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { platformTermWeight } from './term-weights';

/** Chunk bodies are read in pages so a large version is not one result set. */
const READ_BATCH = 500;

export async function rebuildProfile(versionId: string): Promise<{ titles: number; terms: number }> {
  const database = db();
  const [version] = await database
    .select({ id: schema.assetVersion.id, assetId: schema.assetVersion.assetId })
    .from(schema.assetVersion)
    .where(eq(schema.assetVersion.id, versionId));
  if (!version) throw new Error(`no such version: ${versionId}`);

  const documents = await database
    .select({ title: schema.document.title })
    .from(schema.document)
    .where(eq(schema.document.versionId, versionId))
    .orderBy(schema.document.id);
  const titles = documents.map((row) => row.title).slice(0, PROFILE_LIMITS.maxTitles);

  const bodies: string[] = [];
  for (let offset = 0; ; offset += READ_BATCH) {
    const rows = await database
      .select({ body: schema.chunk.body })
      .from(schema.chunk)
      .where(eq(schema.chunk.versionId, versionId))
      .orderBy(schema.chunk.id)
      .limit(READ_BATCH)
      .offset(offset);
    for (const row of rows) bodies.push(row.body);
    if (rows.length < READ_BATCH) break;
  }
  const terms = extractTerms(bodies, PROFILE_LIMITS.maxTerms, await platformTermWeight(version.assetId));

  await database.transaction(async (tx) => {
    await tx.delete(schema.assetProfile).where(eq(schema.assetProfile.versionId, versionId));
    await tx.insert(schema.assetProfile).values({
      id: uuidv7(),
      assetId: version.assetId,
      versionId,
      profileVersion: PROFILE_VERSION,
      documentTitles: titles,
      terms,
      searchText: profileSearchText(titles, terms),
    });
  });

  return { titles: titles.length, terms: terms.length };
}

/**
 * Every current version whose profile was written by an older extractor, or
 * has none, rebuilt in turn -- or every current version, with `all`. Returns
 * what was rebuilt, for the operator.
 */
export async function rebuildStaleProfiles(
  options: { all?: boolean } = {},
): Promise<{ publicId: string; versionId: string; titles: number; terms: number }[]> {
  const database = db();
  const stale = await database
    .select({ publicId: schema.asset.publicId, versionId: schema.asset.currentVersionId })
    .from(schema.asset)
    .leftJoin(
      schema.assetProfile,
      eq(schema.assetProfile.versionId, schema.asset.currentVersionId),
    )
    .where(
      and(
        /* A deleted asset's profile is gone for good, not stale. */
        isNull(schema.asset.deletedAt),
        options.all
          ? undefined
          : or(
              isNull(schema.assetProfile.id),
              ne(schema.assetProfile.profileVersion, PROFILE_VERSION),
            ),
      ),
    );

  const rebuilt: { publicId: string; versionId: string; titles: number; terms: number }[] = [];
  for (const row of stale) {
    if (!row.versionId) continue;
    const result = await rebuildProfile(row.versionId);
    rebuilt.push({ publicId: row.publicId, versionId: row.versionId, ...result });
  }
  return rebuilt;
}

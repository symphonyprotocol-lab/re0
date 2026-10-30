/**
 * The platform's other assets, as a term-frequency table for the profile
 * extractor. architecture.md 9.6: a profile is what makes an asset findable
 * among the others, so "what do the others already say" is the right prior
 * for "what is distinctive here". Read from every other asset's current
 * profile -- one row per asset, terms already extracted -- which is cheap
 * and needs no second corpus.
 *
 * The asset being profiled is excluded so its own vocabulary never counts
 * against it, and a rebuild of one asset reads the platform as it is at
 * that moment; profiles are not rebuilt in cascade.
 */
import { and, eq, isNull, ne } from 'drizzle-orm';
import { platformSpecificity, type TermWeight } from '@/lib/domain/profile';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export async function platformTermWeight(assetId: string): Promise<TermWeight> {
  const rows = await db()
    .select({ terms: schema.assetProfile.terms })
    .from(schema.assetProfile)
    .innerJoin(schema.asset, eq(schema.asset.currentVersionId, schema.assetProfile.versionId))
    .where(and(ne(schema.asset.id, assetId), isNull(schema.asset.deletedAt)));

  const frequency = new Map<string, number>();
  for (const row of rows) {
    for (const term of new Set(row.terms)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  return platformSpecificity(frequency, rows.length);
}

/**
 * What the build reads of the owner's FAQ: every entry of the asset, by
 * asset alone (the build owns no session). Lives on the ingestion side so
 * the build does not import the dashboard's FAQ use cases -- which import
 * the assets module, which imports ingestion: a cycle that works only
 * while nothing on it is used at module-evaluation time.
 */
import { asc, eq } from 'drizzle-orm';
import type { FaqEntryContent } from '@/lib/domain/faq';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export async function faqEntriesForBuild(assetId: string): Promise<FaqEntryContent[]> {
  return db()
    .select({
      id: schema.assetFaq.id,
      question: schema.assetFaq.question,
      answer: schema.assetFaq.answer,
      pageUrl: schema.assetFaq.pageUrl,
    })
    .from(schema.assetFaq)
    .where(eq(schema.assetFaq.assetId, assetId))
    .orderBy(asc(schema.assetFaq.id));
}

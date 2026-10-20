/**
 * What the build reads of the owner's FAQ: every entry of the library, by
 * library alone (the build owns no session). Lives on the ingestion side so
 * the build does not import the dashboard's FAQ use cases -- which import
 * the libraries module, which imports ingestion: a cycle that works only
 * while nothing on it is used at module-evaluation time.
 */
import { asc, eq } from 'drizzle-orm';
import type { FaqEntryContent } from '@/lib/domain/faq';
import { db, schema } from '@/lib/infrastructure/postgres/client';

export async function faqEntriesForBuild(libraryId: string): Promise<FaqEntryContent[]> {
  return db()
    .select({
      id: schema.libraryFaq.id,
      question: schema.libraryFaq.question,
      answer: schema.libraryFaq.answer,
      pageUrl: schema.libraryFaq.pageUrl,
    })
    .from(schema.libraryFaq)
    .where(eq(schema.libraryFaq.libraryId, libraryId))
    .orderBy(asc(schema.libraryFaq.id));
}

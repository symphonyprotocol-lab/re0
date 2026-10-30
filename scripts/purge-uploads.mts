/**
 * Deletes uploaded PDFs that no asset ever claimed: objects under
 * `uploads/` older than a day and listed by no `pdf` source. The drain does
 * the same at the end of every run; this is for doing it by hand.
 *
 *   npm run uploads:purge
 *
 * Safe to run locally because the store is paired with the database: the `dev`
 * Neon branch goes with `recall0-blob-dev` (architecture.md 3.2), so what this
 * machine reads as "no asset claims this object" is a statement about the
 * same environment it is deleting from.
 *
 * `.mts` for the same reason as the other scripts: the env has to be loaded
 * before anything reads DATABASE_URL or BLOB_READ_WRITE_TOKEN.
 */
import nextEnv from '@next/env';

nextEnv.loadEnvConfig(process.cwd());

const { purgeAbandonedUploads, isIngestionConfigured } = await import('@/lib/application/ingestion');

if (!isIngestionConfigured()) {
  console.error('object storage is not configured');
  process.exit(1);
}
const outcome = await purgeAbandonedUploads();
console.log(`${outcome.listed} upload(s) listed, ${outcome.deleted} abandoned one(s) deleted`);
process.exit(0);

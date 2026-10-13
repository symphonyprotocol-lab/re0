/**
 * Sweeps uploads nobody followed up on.
 *
 * The wizard puts PDFs in the store before the library exists (architecture.md
 * 7, `uploads/`), so a session that stops after picking files leaves objects
 * and no row. An S3 bucket would expire them by lifecycle rule; Vercel Blob
 * has none, so the drain does it: list the prefix, subtract every key a `pdf`
 * source still lists, and delete what is older than the grace period.
 *
 * Referenced keys are read *after* the listing, so an upload that is created
 * into a library between the two reads is on the referenced side. The other
 * race -- a create that lands after this decides -- is closed by age: the
 * grace period is far longer than an upload token lives.
 */
import { inArray } from 'drizzle-orm';
import { abandonedUploadKeys, UPLOAD_SOURCE_TYPES, uploadedFilesOf } from '@/lib/domain/library';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { defaultDependencies, type IngestionDependencies } from './dependencies';

const UPLOAD_PREFIX = 'uploads/';
const DELETE_CONCURRENCY = 8;

export interface PurgeUploadsOutcome {
  listed: number;
  deleted: number;
}

export async function purgeAbandonedUploads(input: {
  now?: number;
  maxAgeMs?: number;
  dependencies?: IngestionDependencies;
} = {}): Promise<PurgeUploadsOutcome> {
  const dependencies = input.dependencies ?? defaultDependencies;
  if (!(await dependencies.configured()).storage) return { listed: 0, deleted: 0 };
  const store = dependencies.store();

  const objects = await store.list(UPLOAD_PREFIX);
  if (objects.length === 0) return { listed: 0, deleted: 0 };

  const sources = await db()
    .select({ config: schema.source.config })
    .from(schema.source)
    .where(inArray(schema.source.type, [...UPLOAD_SOURCE_TYPES]));
  const referenced = new Set(
    sources.flatMap((source) => uploadedFilesOf(source.config).map((file) => file.key)),
  );

  const keys = abandonedUploadKeys(objects, referenced, input.now ?? Date.now(), input.maxAgeMs);
  for (let at = 0; at < keys.length; at += DELETE_CONCURRENCY) {
    await Promise.all(keys.slice(at, at + DELETE_CONCURRENCY).map((key) => store.delete(key)));
  }
  return { listed: objects.length, deleted: keys.length };
}

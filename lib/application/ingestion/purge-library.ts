/**
 * The Delete Workflow's one step. architecture.md 8.4: after Postgres has made
 * the library unreachable, remove the chunk rows (and with them the full-text
 * and vector columns), the objects, and the cache.
 *
 * Runs only against a tombstone. A library without `deleted_at` is refused
 * outright, whatever operation asked: the guard is what makes it safe for
 * this to be reachable from the same queue as builds.
 *
 * Objects before rows, deliberately. The object keys are read from
 * `document.object_key` and the version and operation ids; once those rows are
 * gone a retry could no longer find what it owed. Deleting an object that is
 * already gone succeeds (the store treats 404 as done), so a run that failed
 * halfway through its keys picks up where it left off.
 *
 * What stays: `library_version` rows, as metadata. `usage_event` references
 * them by id, and a version that was billed against remains a fact about the
 * past. Their chunks and documents are gone, which is
 * what `library.index_status = 'deleting'` on the tombstone says.
 *
 * What also goes: any anchoring proof for those versions
 * (aptos-anchoring-proposal.md 6 -- "the preimage and proof are deleted with
 * the library"). The root stays on chain, as it must, but without the leaf and
 * its path nobody can show which version that root committed to. That is the
 * whole of what deletion can mean against an append-only ledger, and it is why
 * anchoring a private library was acceptable in the first place.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { IngestionFailure } from '@/lib/domain/ingestion';
import { retrievalCache } from '@/lib/infrastructure/cache/redis';
import { UPLOAD_SOURCE_TYPES, uploadedFilesOf } from '@/lib/domain/library';
import { objectKeys } from '@/lib/infrastructure/objects/store';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { defaultDependencies, type IngestionDependencies } from './dependencies';

export interface PurgeOutcome {
  documents: number;
  chunks: number;
  objects: number;
}

/** Operation types whose run wrote a source snapshot to the store. */
const SNAPSHOT_OPERATIONS = ['ingest', 'refresh'] as const;

/** Object deletes in flight at once; the store is one request per key. */
const DELETE_CONCURRENCY = 8;

export async function purgeLibrary(input: {
  libraryId: string;
  dependencies?: IngestionDependencies;
}): Promise<PurgeOutcome> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const database = db();

  const [library] = await database
    .select({ id: schema.library.id, deletedAt: schema.library.deletedAt })
    .from(schema.library)
    .where(eq(schema.library.id, input.libraryId))
    .limit(1);

  if (!library) throw new IngestionFailure('internal_error', 'purge', 'no such library');
  if (!library.deletedAt) {
    throw new IngestionFailure('internal_error', 'purge', 'the library is not deleted');
  }

  /* --------------------------------------------------------------- objects */

  const [documents, versions, operations, sources] = await Promise.all([
    database
      .select({ objectKey: schema.document.objectKey })
      .from(schema.document)
      .where(and(eq(schema.document.libraryId, library.id), isNotNull(schema.document.objectKey))),
    database
      .select({ id: schema.libraryVersion.id })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, library.id)),
    database
      .select({ id: schema.workflowOperation.id })
      .from(schema.workflowOperation)
      .where(
        and(
          eq(schema.workflowOperation.libraryId, library.id),
          inArray(schema.workflowOperation.operationType, [...SNAPSHOT_OPERATIONS]),
        ),
      ),
    /* Uploaded files are the one kind of object that exists before any
       build; a deleted library's are unreferenced from here on. */
    database
      .select({ config: schema.source.config })
      .from(schema.source)
      .where(
        and(
          eq(schema.source.libraryId, library.id),
          inArray(schema.source.type, [...UPLOAD_SOURCE_TYPES]),
        ),
      ),
  ]);

  const keys = [
    ...documents.map((row) => row.objectKey).filter((key): key is string => key !== null),
    ...versions.flatMap((version) => [
      objectKeys.documentManifest(library.id, version.id),
      objectKeys.vectorManifest(library.id, version.id),
    ]),
    ...operations.map((operation) => objectKeys.snapshot(library.id, operation.id, 'json')),
    ...sources.flatMap((source) => uploadedFilesOf(source.config).map((file) => file.key)),
  ];

  if (keys.length > 0) {
    if (!(await dependencies.configured()).storage) {
      throw new IngestionFailure('storage_unavailable', 'purge', 'no object storage is configured');
    }
    const store = dependencies.store();
    for (let at = 0; at < keys.length; at += DELETE_CONCURRENCY) {
      try {
        await Promise.all(keys.slice(at, at + DELETE_CONCURRENCY).map((key) => store.delete(key)));
      } catch (error) {
        throw new IngestionFailure(
          'storage_unavailable',
          'purge',
          `object delete failed: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
  }

  /* ------------------------------------------------------------------ rows */

  const counts = await database.transaction(async (tx) => {
    const chunks = await tx
      .delete(schema.chunk)
      .where(eq(schema.chunk.libraryId, library.id))
      .returning({ id: schema.chunk.id });
    const removed = await tx
      .delete(schema.document)
      .where(eq(schema.document.libraryId, library.id))
      .returning({ id: schema.document.id });
    await tx
      .delete(schema.libraryProfileVector)
      .where(eq(schema.libraryProfileVector.libraryId, library.id));
    await tx.delete(schema.libraryProfile).where(eq(schema.libraryProfile.libraryId, library.id));
    /* Derived from content that no longer exists; recomputed if it ever returns. */
    await tx.delete(schema.libraryScore).where(eq(schema.libraryScore.libraryId, library.id));
    /* What visitors asked of it, and what the owner answered: both go with the library. */
    await tx.delete(schema.widgetExchange).where(eq(schema.widgetExchange.libraryId, library.id));
    await tx.delete(schema.libraryFaq).where(eq(schema.libraryFaq.libraryId, library.id));

    /*
     * The proofs, but not the batches that hold them. `anchor_batch.leaf_count`
     * still counts a leaf whose row is gone, and that is correct rather than an
     * inconsistency to tidy: the root on chain commits to that leaf whatever
     * this database does, and editing the count would make the batch disagree
     * with the ledger it describes.
     */
    const versions = await tx
      .select({ id: schema.libraryVersion.id })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, library.id));
    if (versions.length > 0) {
      await tx.delete(schema.anchorLeaf).where(
        and(
          eq(schema.anchorLeaf.subjectType, 'version'),
          inArray(
            schema.anchorLeaf.subjectId,
            versions.map((version) => version.id),
          ),
        ),
      );
    }
    await tx
      .update(schema.library)
      .set({ storageBytes: 0 })
      .where(and(eq(schema.library.id, library.id), sql`${schema.library.deletedAt} is not null`));
    return { chunks: chunks.length, documents: removed.length };
  });

  /* ------------------------------------------------------------------ cache */

  /*
   * Best effort, like every cache operation (architecture.md 9.4). Nothing is
   * served from these entries anyway: a query resolves the library before it
   * looks in the cache, and the tombstone is refused there. Revoking the tag
   * just stops a deleted library's excerpts sitting in Redis until they expire.
   */
  await retrievalCache()
    .invalidateTag(`ctxtag:${library.id}`)
    .catch(() => {});

  return { documents: counts.documents, chunks: counts.chunks, objects: keys.length };
}

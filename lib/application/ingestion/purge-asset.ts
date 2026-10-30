/**
 * The Delete Workflow's one step. architecture.md 8.4: after Postgres has made
 * the asset unreachable, remove the chunk rows (and with them the full-text
 * and vector columns), the objects, and the cache.
 *
 * Runs only against a tombstone. An asset without `deleted_at` is refused
 * outright, whatever operation asked: the guard is what makes it safe for
 * this to be reachable from the same queue as builds.
 *
 * Objects before rows, deliberately. The object keys are read from
 * `document.object_key` and the version and operation ids; once those rows are
 * gone a retry could no longer find what it owed. Deleting an object that is
 * already gone succeeds (the store treats 404 as done), so a run that failed
 * halfway through its keys picks up where it left off.
 *
 * What stays: `asset_version` rows, as metadata. `usage_event` references
 * them by id, and a version that was billed against remains a fact about the
 * past. Their chunks and documents are gone, which is
 * what `asset.index_status = 'deleting'` on the tombstone says.
 *
 * What also goes: any anchoring proof for those versions
 * (aptos-anchoring-proposal.md 6 -- "the preimage and proof are deleted with
 * the asset"). The root stays on chain, as it must, but without the leaf and
 * its path nobody can show which version that root committed to. That is the
 * whole of what deletion can mean against an append-only ledger, and it is why
 * anchoring a private asset was acceptable in the first place.
 */
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { IngestionFailure } from '@/lib/domain/ingestion';
import { retrievalCache } from '@/lib/infrastructure/cache/redis';
import { UPLOAD_SOURCE_TYPES, uploadedFilesOf } from '@/lib/domain/asset';
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

export async function purgeAsset(input: {
  assetId: string;
  dependencies?: IngestionDependencies;
}): Promise<PurgeOutcome> {
  const dependencies = input.dependencies ?? defaultDependencies;
  const database = db();

  const [asset] = await database
    .select({ id: schema.asset.id, deletedAt: schema.asset.deletedAt })
    .from(schema.asset)
    .where(eq(schema.asset.id, input.assetId))
    .limit(1);

  if (!asset) throw new IngestionFailure('internal_error', 'purge', 'no such asset');
  if (!asset.deletedAt) {
    throw new IngestionFailure('internal_error', 'purge', 'the asset is not deleted');
  }

  /* --------------------------------------------------------------- objects */

  const [documents, versions, operations, sources] = await Promise.all([
    database
      .select({ objectKey: schema.document.objectKey })
      .from(schema.document)
      .where(and(eq(schema.document.assetId, asset.id), isNotNull(schema.document.objectKey))),
    database
      .select({ id: schema.assetVersion.id })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.assetId, asset.id)),
    database
      .select({ id: schema.workflowOperation.id })
      .from(schema.workflowOperation)
      .where(
        and(
          eq(schema.workflowOperation.assetId, asset.id),
          inArray(schema.workflowOperation.operationType, [...SNAPSHOT_OPERATIONS]),
        ),
      ),
    /* Uploaded files are the one kind of object that exists before any
       build; a deleted asset's are unreferenced from here on. */
    database
      .select({ config: schema.source.config })
      .from(schema.source)
      .where(
        and(
          eq(schema.source.assetId, asset.id),
          inArray(schema.source.type, [...UPLOAD_SOURCE_TYPES]),
        ),
      ),
  ]);

  const keys = [
    ...documents.map((row) => row.objectKey).filter((key): key is string => key !== null),
    ...versions.flatMap((version) => [
      objectKeys.documentManifest(asset.id, version.id),
      objectKeys.vectorManifest(asset.id, version.id),
    ]),
    ...operations.map((operation) => objectKeys.snapshot(asset.id, operation.id, 'json')),
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
      .where(eq(schema.chunk.assetId, asset.id))
      .returning({ id: schema.chunk.id });
    const removed = await tx
      .delete(schema.document)
      .where(eq(schema.document.assetId, asset.id))
      .returning({ id: schema.document.id });
    await tx
      .delete(schema.assetProfileVector)
      .where(eq(schema.assetProfileVector.assetId, asset.id));
    await tx.delete(schema.assetProfile).where(eq(schema.assetProfile.assetId, asset.id));
    /* Derived from content that no longer exists; recomputed if it ever returns. */
    await tx.delete(schema.assetScore).where(eq(schema.assetScore.assetId, asset.id));
    /* What visitors asked of it, and what the owner answered: both go with the asset. */
    await tx.delete(schema.widgetExchange).where(eq(schema.widgetExchange.assetId, asset.id));
    await tx.delete(schema.assetFaq).where(eq(schema.assetFaq.assetId, asset.id));

    /*
     * The proofs, but not the batches that hold them. `anchor_batch.leaf_count`
     * still counts a leaf whose row is gone, and that is correct rather than an
     * inconsistency to tidy: the root on chain commits to that leaf whatever
     * this database does, and editing the count would make the batch disagree
     * with the ledger it describes.
     */
    const versions = await tx
      .select({ id: schema.assetVersion.id })
      .from(schema.assetVersion)
      .where(eq(schema.assetVersion.assetId, asset.id));
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
      .update(schema.asset)
      .set({ storageBytes: 0 })
      .where(and(eq(schema.asset.id, asset.id), sql`${schema.asset.deletedAt} is not null`));
    return { chunks: chunks.length, documents: removed.length };
  });

  /* ------------------------------------------------------------------ cache */

  /*
   * Best effort, like every cache operation (architecture.md 9.4). Nothing is
   * served from these entries anyway: a query resolves the asset before it
   * looks in the cache, and the tombstone is refused there. Revoking the tag
   * just stops a deleted asset's excerpts sitting in Redis until they expire.
   */
  await retrievalCache()
    .invalidateTag(`ctxtag:${asset.id}`)
    .catch(() => {});

  return { documents: counts.documents, chunks: counts.chunks, objects: keys.length };
}

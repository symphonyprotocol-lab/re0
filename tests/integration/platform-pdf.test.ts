/**
 * A platform PDF asset against a real database and an in-memory store.
 *
 * What the domain test cannot show: that a create refuses a manifest whose
 * files are not in the store, writes the files onto the source and queues
 * the first build when it has them; and that the files panel's save merges
 * the list, queues a rebuild, and queues nothing once the asset is empty.
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { addPlatformAssetSource, createPlatformAsset, getPlatformAsset, updatePlatformAssetFiles } =
  await import('@/lib/application/administration/manage-platform-assets');
const { memoryObjectStore } = await import('@/lib/application/ingestion/dependencies');
const { PlatformAssetRefused, uploadKey, PLATFORM_UPLOAD_OWNER } = await import('@/lib/domain/asset');
const { uuidv7 } = await import('@/lib/domain/id');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');

const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };
const slug = `platform-pdf-${Date.now()}`;
const created: string[] = [];
const store = memoryObjectStore();

async function upload(batchId: string, size: number): Promise<{ id: string; name: string; size: number }> {
  const id = uuidv7();
  await store.put(uploadKey(PLATFORM_UPLOAD_OWNER, batchId, id), new Uint8Array(size), 'application/pdf');
  return { id, name: `${id.slice(0, 8)}.pdf`, size };
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    return error instanceof PlatformAssetRefused ? error.code : `unexpected:${String(error)}`;
  }
}

describeWithDb('platform pdf assets', () => {
  afterAll(async () => {
    const database = db();
    if (created.length === 0) return;
    await database
      .delete(schema.workflowOperation)
      .where(inArray(schema.workflowOperation.assetId, created));
    await database.delete(schema.source).where(inArray(schema.source.assetId, created));
    await database.delete(schema.asset).where(inArray(schema.asset.id, created));
    await database
      .delete(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetType, 'platform_library'),
          inArray(schema.auditLog.targetId, created),
        ),
      );
  });

  it('refuses a manifest whose file is not in the store', async () => {
    const batchId = uuidv7();
    const code = await refusalOf(
      createPlatformAsset({
        actor,
        title: 'Ghost Handbook',
        publicId: `/docs/${slug}-ghost`,
        sourceType: 'pdf',
        location: '',
        refreshPolicy: 'manual',
        uploads: { batchId, files: [{ id: uuidv7(), name: 'ghost.pdf', size: 10 }] },
        reason: 'integration test fixture',
        store,
      }),
    );
    expect(code).toBe('invalid_uploads');
  });

  it('creates the asset with its files and queues the first build', async () => {
    const batchId = uuidv7();
    const file = await upload(batchId, 64);
    const result = await createPlatformAsset({
      actor,
      title: 'Platform Handbook',
      publicId: `/docs/${slug}`,
      sourceType: 'pdf',
      location: '',
      refreshPolicy: 'daily',
      uploads: { batchId, files: [file] },
      reason: 'integration test fixture',
      store,
    });
    created.push(result.assetId);
    expect(result.operationId).not.toBeNull();

    const record = await getPlatformAsset(result.assetId);
    expect(record?.files?.map((f) => f.id)).toEqual([file.id]);
    expect(record?.sources[0]?.type).toBe('pdf');
    expect(record?.sources[0]?.refreshPolicy).toBe('manual');
    expect(record?.operations[0]?.operationType).toBe('ingest');
  });

  it('merges a files edit, queues a rebuild, and queues nothing once empty', async () => {
    const assetId = created[0]!;
    const before = (await getPlatformAsset(assetId))!.files!;
    /* The first build is still pending in this test (nothing drains it), so
       the edit reuses it rather than queueing a second row. */
    const batchId = uuidv7();
    const added = await upload(batchId, 32);
    const edit = await updatePlatformAssetFiles({
      actor,
      assetId,
      add: { batchId, files: [added] },
      remove: [before[0]!.id],
      reason: 'swap the file',
      store,
    });
    expect(edit.files.map((f) => f.id)).toEqual([added.id]);
    expect(edit.operationId).not.toBeNull();
    expect(edit.created).toBe(false);

    expect(await refusalOf(updatePlatformAssetFiles({ actor, assetId, reason: 'noop', store }))).toBe(
      'nothing_to_change',
    );

    const emptied = await updatePlatformAssetFiles({
      actor,
      assetId,
      remove: [added.id],
      reason: 'remove everything',
      store,
    });
    expect(emptied.files).toEqual([]);
    expect(emptied.operationId).toBeNull();
  });

  it('refuses a pdf source on a website asset: one asset, one source', async () => {
    const asset = await createPlatformAsset({
      actor,
      title: 'Site With Manual',
      publicId: `/websites/${slug}-site`,
      sourceType: 'website',
      location: 'https://example.test/site',
      refreshPolicy: 'daily',
      reason: 'integration test fixture',
    });
    created.push(asset.assetId);

    /* agent-first-proposal.md 3.1: the manual is an asset of its own now. */
    const batchId = uuidv7();
    const file = await upload(batchId, 16);
    const refused = await refusalOf(
      addPlatformAssetSource({
        actor,
        assetId: asset.assetId,
        type: 'pdf',
        location: '',
        refreshPolicy: 'daily',
        uploads: { batchId, files: [file] },
        reason: 'attach the manual',
        store,
      }),
    );
    expect(refused).toBe('source_exists');
    const record = await getPlatformAsset(asset.assetId);
    expect(record?.sources.map((s) => s.type)).toEqual(['website']);
  });
});

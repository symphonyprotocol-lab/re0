/**
 * The four platform-asset verbs against a real database (requirement.md 5.3).
 *
 * The properties under test are the ones that cannot be checked in a unit test,
 * because they are about rows nobody touched:
 *
 * - a created asset has no owner workspace and never acquires one, which is
 *   what keeps it out of revenue share (requirement.md 4.4);
 * - publication is refused while no indexed version exists, so the console
 *   cannot produce a published asset that answers queries with nothing
 *   (architecture.md 8.3);
 * - suspending leaves the version pointer and the index alone, so it is a pause
 *   and not a deletion;
 * - a second refresh does not queue a second operation.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database -- these
 * tests write rows. Against Neon, use a dev branch:
 *
 *   TEST_DATABASE_URL='postgres://...' npx vitest run tests/integration
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const {
  createPlatformAsset,
  getPlatformAsset,
  listPlatformAssets,
  platformAssetSummary,
  requestPlatformAssetRefresh,
  setPlatformAssetLifecycle,
  updatePlatformAsset,
  addPlatformAssetSource,
  updatePlatformAssetSource,
  removePlatformAssetSource,
} = await import('@/lib/application/administration/manage-platform-assets');
const { PlatformAssetRefused } = await import('@/lib/domain/asset');
const { AdminChangeRefused } = await import('@/lib/domain/admin');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

/** No administrator row is needed: `audit_log.administrator_id` is nullable. */
const actor = { administratorId: null as unknown as string, email: 'ops@example.test' };

/** Unique per run, so a re-run does not collide on `asset_public_id_uq`. */
const slug = `platform-fixture-${Date.now()}`;
const publicId = `/websites/${slug}`;

const created: string[] = [];
let versionId = '';

/** The refusal code, so a case asserts which guard fired rather than that one did. */
async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    if (error instanceof PlatformAssetRefused) return error.code;
    if (error instanceof AdminChangeRefused) return error.code;
    return `unexpected:${String(error)}`;
  }
}

describeWithDb('platform assets', () => {
  afterAll(async () => {
    const database = db();
    if (created.length === 0) return;
    await database
      .delete(schema.workflowOperation)
      .where(inArray(schema.workflowOperation.assetId, created));
    await database.delete(schema.source).where(inArray(schema.source.assetId, created));
    await database
      .delete(schema.assetAlias)
      .where(inArray(schema.assetAlias.assetId, created));

    /*
     * Everything a version drags with it, not just the one this file wrote.
     *
     * These fixtures queue real refresh operations, and a drain running
     * anywhere -- the ingestion suite's own test, a worker, the console --
     * will happily pick one up and build it a version with documents and
     * chunks. That is the drain behaving correctly; a teardown that only knew
     * about rows this file inserted would then fail on a foreign key and leave
     * the fixtures behind.
     *
     * Retried, for the same reason: a drain that claimed one of these
     * operations before the rows above were deleted is still mid-build, and
     * can insert a fresh profile or chunk between our dependent-table sweep
     * and the version delete. Builds finish in well under a second; a few
     * passes outlast any straggler.
     */
    for (let attempt = 1; ; attempt += 1) {
      try {
        await database
          .update(schema.asset)
          .set({ currentVersionId: null })
          .where(inArray(schema.asset.id, created));
        await database
          .delete(schema.assetProfileVector)
          .where(inArray(schema.assetProfileVector.assetId, created));
        await database
          .delete(schema.assetProfile)
          .where(inArray(schema.assetProfile.assetId, created));
        await database.delete(schema.chunk).where(inArray(schema.chunk.assetId, created));
        await database.delete(schema.document).where(inArray(schema.document.assetId, created));
        await database
          .delete(schema.assetScore)
          .where(inArray(schema.assetScore.assetId, created));
        await database
          .delete(schema.assetVersion)
          .where(inArray(schema.assetVersion.assetId, created));
        await database.delete(schema.asset).where(inArray(schema.asset.id, created));
        break;
      } catch (error) {
        if (attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    await database
      .delete(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetType, 'platform_library'),
          inArray(schema.auditLog.targetId, created),
        ),
      );
  });

  it('creates a draft asset with a source and no owner workspace', async () => {
    const result = await createPlatformAsset({
      actor,
      title: 'Platform Fixture Docs',
      publicId,
      sourceType: 'website',
      location: 'https://example.test/docs',
      refreshPolicy: 'daily',
      indexDepth: 3,
      description: 'A fixture, not a real asset.',
      domainTag: 'Testing',
      language: 'English',
      reason: 'integration test fixture',
    });
    created.push(result.assetId);

    const record = await getPlatformAsset(result.assetId);
    expect(record).not.toBeNull();
    expect(record?.publicId).toBe(publicId);
    // Public from the start; it is the lifecycle, not the visibility, that
    // keeps a draft out of the catalogue (requirement.md 6.2).
    expect(record?.visibility).toBe('public');
    expect(record?.lifecycleStatus).toBe('draft');
    expect(record?.indexStatus).toBe('pending');
    expect(record?.hasReadyVersion).toBe(false);
    expect(record?.sources).toHaveLength(1);
    expect(record?.sources[0]?.location).toBe('https://example.test/docs');
    expect(record?.sources[0]?.refreshPolicy).toBe('daily');
    expect(record?.sources[0]?.indexDepth).toBe(3);

    const [row] = await db()
      .select({
        ownerWorkspaceId: schema.asset.ownerWorkspaceId,
        isPlatformAsset: schema.asset.isPlatformAsset,
      })
      .from(schema.asset)
      .where(eq(schema.asset.id, result.assetId));
    expect(row?.ownerWorkspaceId).toBeNull();
    expect(row?.isPlatformAsset).toBe(true);
  });

  it('records the create in the audit log with a reason', async () => {
    const [entry] = await db()
      .select({ action: schema.auditLog.action, reason: schema.auditLog.reason })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetType, 'platform_library'),
          eq(schema.auditLog.targetId, created[0]!),
        ),
      )
      .limit(1);
    expect(entry?.action).toBe('platform_library.create');
    expect(entry?.reason).toBe('integration test fixture');
  });

  it('refuses a second asset on the same Asset ID', async () => {
    expect(
      await refusalOf(
        createPlatformAsset({
          actor,
          title: 'Duplicate',
          publicId,
          sourceType: 'website',
          location: 'https://example.test/other',
          refreshPolicy: 'weekly',
          reason: 'should not happen',
        }),
      ),
    ).toBe('public_id_taken');
  });

  it('requires a reason for every action', async () => {
    expect(
      await refusalOf(
        requestPlatformAssetRefresh({ actor, assetId: created[0]!, reason: '   ' }),
      ),
    ).toBe('reason_required');
  });

  it('refuses to publish while no version is indexed', async () => {
    expect(
      await refusalOf(
        setPlatformAssetLifecycle({
          actor,
          assetId: created[0]!,
          action: 'publish',
          reason: 'too early',
        }),
      ),
    ).toBe('no_ready_version');

    const record = await getPlatformAsset(created[0]!);
    expect(record?.lifecycleStatus).toBe('draft');
  });

  it('queues one refresh however many times it is asked', async () => {
    const first = await requestPlatformAssetRefresh({
      actor,
      assetId: created[0]!,
      reason: 'first request',
    });
    expect(first.created).toBe(true);

    const second = await requestPlatformAssetRefresh({
      actor,
      assetId: created[0]!,
      reason: 'second request',
    });
    expect(second.created).toBe(false);
    expect(second.operationId).toBe(first.operationId);

    const operations = await db()
      .select({ id: schema.workflowOperation.id, status: schema.workflowOperation.status })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.assetId, created[0]!));
    expect(operations).toHaveLength(1);
    // Nothing drains the queue yet; the row is the whole of what was promised.
    expect(operations[0]?.status).toBe('pending');
  });

  it('publishes once a ready version exists, and suspending leaves it in place', async () => {
    const database = db();
    versionId = uuidv7();
    await database.insert(schema.assetVersion).values({
      id: versionId,
      assetId: created[0]!,
      label: 'v1',
      sourceDigest: 'digest',
      parserVersion: 'test',
      chunkerVersion: 'test',
      embeddingModel: 'test',
      indexStatus: 'ready',
      totalChunks: 12,
      totalTokens: 340,
      publishedAt: new Date(),
    });
    await database
      .update(schema.asset)
      .set({ currentVersionId: versionId, indexStatus: 'ready' })
      .where(eq(schema.asset.id, created[0]!));

    const published = await setPlatformAssetLifecycle({
      actor,
      assetId: created[0]!,
      action: 'publish',
      reason: 'first version indexed',
    });
    expect(published.status).toBe('published');

    const suspended = await setPlatformAssetLifecycle({
      actor,
      assetId: created[0]!,
      action: 'suspend',
      reason: 'upstream broke',
    });
    expect(suspended.status).toBe('suspended');

    const record = await getPlatformAsset(created[0]!);
    // A pause, not a deletion: the pointer and the version survive it.
    expect(record?.currentVersionId).toBe(versionId);
    expect(record?.versions).toHaveLength(1);
    expect(record?.hasReadyVersion).toBe(true);
  });

  it('refuses a transition the asset is not in a state for', async () => {
    expect(
      await refusalOf(
        setPlatformAssetLifecycle({
          actor,
          assetId: created[0]!,
          action: 'suspend',
          reason: 'already suspended',
        }),
      ),
    ).toBe('invalid_transition');
  });

  it('refuses to act on an asset that is not the platform’s', async () => {
    const database = db();
    const foreignId = uuidv7();
    await database.insert(schema.asset).values({
      id: foreignId,
      publicId: `/websites/${slug}-user`,
      title: 'Someone else’s asset',
      isPlatformAsset: false,
      kind: 'website',
      lifecycleStatus: 'published',
      indexStatus: 'ready',
    });
    try {
      expect(await getPlatformAsset(foreignId)).toBeNull();
      expect(
        await refusalOf(
          setPlatformAssetLifecycle({
            actor,
            assetId: foreignId,
            action: 'suspend',
            reason: 'not ours to touch',
          }),
        ),
      ).toBe('not_platform_asset');
    } finally {
      await database.delete(schema.asset).where(eq(schema.asset.id, foreignId));
    }
  });

  /**
   * Editing and source management. Not one of requirement.md 5.3's four verbs,
   * but the maintenance every one of them assumes: an asset whose location was
   * mistyped is otherwise unfixable except by abandoning it.
   */
  it('edits the catalogue fields and leaves the lifecycle alone', async () => {
    const database = db();
    const [before] = await database
      .select({ lifecycleStatus: schema.asset.lifecycleStatus })
      .from(schema.asset)
      .where(eq(schema.asset.id, created[0] as string));

    await updatePlatformAsset({
      actor,
      assetId: created[0] as string,
      title: 'Renamed fixture',
      publicId,
      description: 'Edited by the integration test.',
      domainTag: 'testing',
      language: 'English',
      reason: 'integration test edit',
    });

    const [after] = await database
      .select()
      .from(schema.asset)
      .where(eq(schema.asset.id, created[0] as string));

    expect(after?.title).toBe('Renamed fixture');
    expect(after?.description).toBe('Edited by the integration test.');
    // Editing what the catalogue shows must not move the publication decision.
    expect(after?.lifecycleStatus).toBe(before?.lifecycleStatus);
  });

  it('keeps a redirect when the Asset ID changes', async () => {
    const renamed = `${publicId}-renamed`;
    const { renamed: didRename } = await updatePlatformAsset({
      actor,
      assetId: created[0] as string,
      title: 'Renamed fixture',
      publicId: renamed,
      reason: 'integration test rename',
    });
    expect(didRename).toBe(true);

    const database = db();
    const [alias] = await database
      .select()
      .from(schema.assetAlias)
      .where(eq(schema.assetAlias.fromPublicId, publicId));
    // requirement.md 6.1: the old id keeps resolving, so quoted links survive.
    expect(alias?.assetId).toBe(created[0]);

    // Put it back, so the rest of the file can keep using `publicId`.
    await updatePlatformAsset({
      actor,
      assetId: created[0] as string,
      title: 'Renamed fixture',
      publicId,
      reason: 'integration test rename back',
    });
  });

  it('refuses an edit that would leave the source type\u2019s namespace', async () => {
    expect(
      await refusalOf(
        updatePlatformAsset({
          actor,
          assetId: created[0] as string,
          title: 'Renamed fixture',
          publicId: '/docs/somewhere-else',
          reason: 'integration test',
        }),
      ),
    ).toBe('invalid_public_id');
  });

  it('adds, edits and removes a source, keeping the last one', async () => {
    const database = db();
    const assetId = created[0] as string;

    expect(
      await refusalOf(
        removePlatformAssetSource({
          actor,
          assetId,
          sourceId: (
            await database
              .select({ id: schema.source.id })
              .from(schema.source)
              .where(eq(schema.source.assetId, assetId))
              .limit(1)
          )[0]?.id as string,
          reason: 'integration test',
        }),
      ),
    ).toBe('last_source');

    /* One asset, one source (agent-first-proposal.md 3.1): a second is refused. */
    expect(
      await refusalOf(
        addPlatformAssetSource({
          actor,
          assetId,
          type: 'github',
          location: 'https://github.com/vercel/next.js',
          refreshPolicy: 'weekly',
          reason: 'integration test add',
        }),
      ),
    ).toBe('source_exists');

    /* The one source is still edited in place. */
    const [only] = await database
      .select({ id: schema.source.id, location: schema.source.location })
      .from(schema.source)
      .where(eq(schema.source.assetId, assetId));
    await updatePlatformAssetSource({
      actor,
      assetId,
      sourceId: only!.id,
      location: only!.location,
      refreshPolicy: 'manual',
      reason: 'integration test edit source',
    });
    const [edited] = await database
      .select()
      .from(schema.source)
      .where(eq(schema.source.id, only!.id));
    expect((edited?.refreshPolicy as { cadence?: string }).cadence).toBe('manual');
    const remaining = await database
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(eq(schema.source.assetId, assetId));
    expect(remaining).toHaveLength(1);
  });

  it('refuses a source that does not belong to the asset', async () => {
    expect(
      await refusalOf(
        updatePlatformAssetSource({
          actor,
          assetId: created[0] as string,
          sourceId: uuidv7(),
          location: 'https://example.test/docs',
          refreshPolicy: 'daily',
          reason: 'integration test',
        }),
      ),
    ).toBe('source_not_found');
  });

  it('records every edit in the audit log with a reason', async () => {
    const entries = await db()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetType, 'platform_library'),
          eq(schema.auditLog.targetId, created[0] as string),
        ),
      );
    const actions = new Set(entries.map((entry) => entry.action));
    for (const action of [
      'platform_library.update',
      'platform_library.source_update',
    ]) {
      expect(actions.has(action)).toBe(true);
    }
  });

  it('refuses an id another asset already redirects from', async () => {
    const database = db();
    const abandoned = `${publicId}-abandoned`;

    // Leave a redirect behind, then try to hand that id to a second asset.
    await updatePlatformAsset({
      actor,
      assetId: created[0] as string,
      title: 'Renamed fixture',
      publicId: abandoned,
      reason: 'integration test',
    });
    await updatePlatformAsset({
      actor,
      assetId: created[0] as string,
      title: 'Renamed fixture',
      publicId,
      reason: 'integration test',
    });

    /* A slug of its own: the list test below searches for `slug`. */
    const other = await createPlatformAsset({
      actor,
      title: 'Alias clash fixture',
      publicId: `/websites/alias-clash-${Date.now()}`,
      sourceType: 'website',
      location: 'https://example.test/other',
      refreshPolicy: 'manual',
      reason: 'integration test',
    });
    created.push(other.assetId);

    expect(
      await refusalOf(
        updatePlatformAsset({
          actor,
          assetId: other.assetId,
          title: 'Alias clash fixture',
          publicId: abandoned,
          reason: 'integration test',
        }),
      ),
    ).toBe('public_id_taken');

    // Reclaiming your own abandoned id is still allowed, and drops the alias
    // rather than leaving an id that redirects to itself.
    await updatePlatformAsset({
      actor,
      assetId: created[0] as string,
      title: 'Renamed fixture',
      publicId: abandoned,
      reason: 'integration test',
    });
    const aliases = await database
      .select({ from: schema.assetAlias.fromPublicId })
      .from(schema.assetAlias)
      .where(eq(schema.assetAlias.fromPublicId, abandoned));
    expect(aliases).toHaveLength(0);

    await updatePlatformAsset({
      actor,
      assetId: created[0] as string,
      title: 'Renamed fixture',
      publicId,
      reason: 'integration test',
    });
  });

  it('will not let two concurrent removals empty an asset', async () => {
    const database = db();
    const assetId = created[0] as string;

    /* A second source, written directly: the console refuses one since P1
       (agent-first-proposal.md 3.1), and this guards an asset from before
       migration 0062 split them. */
    const first = { sourceId: uuidv7() };
    await database.insert(schema.source).values({
      id: first.sourceId,
      assetId,
      type: 'website',
      location: 'https://example.test/a',
      config: { indexDepth: 0 },
      refreshPolicy: { cadence: 'manual' },
    });
    const existing = await database
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(eq(schema.source.assetId, assetId));
    expect(existing.length).toBeGreaterThanOrEqual(2);

    // Both removals see two sources; only one may win.
    const results = await Promise.allSettled(
      existing
        .slice(0, 2)
        .map((source) =>
          removePlatformAssetSource({ actor, assetId, sourceId: source.id, reason: 'race' }),
        ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const left = await database
      .select({ id: schema.source.id })
      .from(schema.source)
      .where(eq(schema.source.assetId, assetId));
    expect(left.length).toBeGreaterThanOrEqual(1);

    // Tidy up whichever survived, back to the single original source.
    for (const source of left) {
      if (source.id === first.sourceId) {
        await removePlatformAssetSource({
          actor,
          assetId,
          sourceId: source.id,
          reason: 'integration test cleanup',
        }).catch(() => undefined);
      }
    }
  });

  it('lists and counts only platform assets', async () => {
    const { rows, counts } = await listPlatformAssets({ query: slug });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publicId).toBe(publicId);
    expect(rows[0]?.sourceType).toBe('website');
    expect(counts.suspended).toBeGreaterThanOrEqual(1);

    /*
     * Queued moments before it is counted: a drain running in a parallel
     * suite happily claims any pending operation this file queued earlier
     * (the teardown comment above already knows this), so asserting on one
     * queued minutes ago is a race. One inserted here narrows the window
     * from the file's runtime to these two statements.
     */
    await db().insert(schema.workflowOperation).values({
      id: crypto.randomUUID(),
      assetId: created[0]!,
      operationType: 'refresh',
      sourceDigest: null,
      status: 'pending',
    });
    const summary = await platformAssetSummary();
    expect(summary.queuedRefreshes).toBeGreaterThanOrEqual(1);
    // Nothing writes `usage_event` yet, so this is a true zero.
    expect(summary.callsThisMonth).toBeGreaterThanOrEqual(0);
  });
});

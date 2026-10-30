/**
 * The owner's management verbs over their own asset -- pause, resume,
 * resubmit, edit metadata and configure the parse scope -- against a real
 * database. The rules themselves are unit tested (tests/contract/asset-manage);
 * what cannot be unit tested is the part these tests exist for: that the SQL
 * behind each verb writes the rows the rules decided, that the guards read
 * ownership from the table rather than from the caller, and that a build
 * run afterwards leaves the owner's configuration alone.
 *
 * The properties under test:
 *
 * - pause moves `published` -> `suspended`, withdraws the queued fetches, and
 *   leaves a `asset_review` row that says the owner stopped it; resume lifts
 *   only that, never a reviewer's suspension;
 * - a suspended asset is not picked up by refresh scheduling;
 * - resubmit takes a `changes_requested` public asset back to `submitted`
 *   with a new review row, refuses every other state, and does not disturb the
 *   reviewer's note;
 * - the metadata edit persists title, description and language, applies
 *   `visibilityTransition` to the lifecycle in both directions, and refuses an
 *   over-long description or language at the same limits creation enforces;
 * - the parse scope lands on `source.config` under the `re0.json` field names
 *   and survives a build of a source that declares no `re0.json` -- the
 *   regression that made the next build index everything -- while a connector
 *   that does declare a scope still stamps it when the owner has not overridden;
 * - every verb is refused for a `developer` or `viewer`, and an asset another
 *   workspace owns answers `asset_not_found`, as a missing one does.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { inNoChannel, shareInPublicChannel } from '../fixtures/channels';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const {
  applyOwnerLifecycleAction,
  createWorkspaceAsset,
  editAssetMetadata,
  updateParseScope,
} = await import('@/lib/application/assets');
const { buildVersion, memoryObjectStore, publishVersion } = await import(
  '@/lib/application/ingestion'
);
const { scheduleDueRefreshes, refreshSchedule } = await import(
  '@/lib/application/ingestion/schedule-refreshes'
);
const {
  DESCRIPTION_MAX_LENGTH,
  LANGUAGE_MAX_LENGTH,
  isOwnerPause,
  OWNER_REVIEW_STAGE,
  PlatformAssetRefused,
} = await import('@/lib/domain/asset');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { verifiedDomain } = await import('@/tests/fixtures/verified-domain');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const assets: string[] = [];
const planVersions: string[] = [];
const store = memoryObjectStore();

/**
 * A snapshot whose `config` is the connector's declaration of its own scope.
 * The body carries a nonce so every call is a genuinely changed source and a
 * second build is a real build rather than a skipped one.
 */
function dependencies(declared?: { folders?: string[]; excludeFolders?: string[] }) {
  const nonce = uuidv7();
  return {
    async fetchSnapshot() {
      return {
        files: [
          {
            path: 'docs/handbook.md',
            url: 'https://docs.example.test/handbook',
            content: `# Team Handbook\n\nThe quartzloft onboarding checklist lives here (${nonce}).`,
          },
        ],
        config: {
          projectTitle: null,
          description: null,
          branch: null,
          /* No re0.json means an empty declaration, which is exactly the
             shape that used to erase the owner's saved scope. */
          folders: declared?.folders ?? [],
          excludeFolders: declared?.excludeFolders ?? [],
          excludeFiles: [],
          rules: [],
        },
        revision: `fixture-${nonce}`,
        lastModifiedAt: new Date(),
        hasLicense: true,
        stale: false,
      };
    },
    embeddings: () => ({
      model: 'fixture-embed-1',
      dimensions: EMBEDDING_COLUMN_DIMENSIONS,
      async embed(texts: string[]) {
        return texts.map((text) =>
          Array.from({ length: EMBEDDING_COLUMN_DIMENSIONS }, (_, i) => ((text.length + i) % 17) / 17),
        );
      },
    }),
    store: () => store,
    configured: () => ({ embeddings: true, storage: true }),
  };
}

async function workspaceOnPlan(): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'manage-lib-test' });

  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'free',
    priceMinor: 0,
    currency: 'USD',
    monthlyCalls: 1_000,
    apiKeyLimit: 5,
    capabilities: {},
    createdAt: new Date('2000-01-01T00:00:00Z'),
  });
  await database.insert(schema.subscription).values({
    id: uuidv7(),
    workspaceId,
    planVersionId,
    status: 'active',
    periodStart: new Date(Date.now() - 86_400_000),
    periodEnd: new Date(Date.now() + 86_400_000),
  });
  return workspaceId;
}

let counter = 0;

/** A website asset owned by `workspaceId`, with the domain challenge it needs. */
async function asset(
  workspaceId: string,
  options: { visibility?: 'public' | 'private'; description?: string; language?: string } = {},
): Promise<{ assetId: string; publicId: string; operationId: string | null }> {
  const slug = `manage-${Date.now()}-${counter++}`;
  const location = `https://docs.example.test/${slug}`;
  const created = await createWorkspaceAsset({
    role: 'owner',
    workspaceId,
    title: 'Team handbook',
    description: options.description,
    language: options.language,
    sourceType: 'website',
    location,
    domainVerificationId: await verifiedDomain(workspaceId, location),
    slug,
    /* A public asset is created with its rights declared (lib/domain/rights.ts). */
    rights: { origin: 'own', license: 'open_source', generation: 'human' },
  });
  assets.push(created.assetId);
  /* Public means listed in a public channel now (agent-first-proposal.md 6.2). */
  if (options.visibility === 'public') await shareInPublicChannel(created.assetId);
  return { assetId: created.assetId, publicId: created.publicId, operationId: created.operationId };
}

/** Builds and publishes, so the asset has an indexed current version. */
async function build(assetId: string, declared?: { folders?: string[]; excludeFolders?: string[] }) {
  const built = await buildVersion({
    assetId,
    operationId: uuidv7(),
    dependencies: dependencies(declared),
  });
  expect(built.changed).toBe(true);
  if (!built.changed) throw new Error('the fixture build produced no version');
  await publishVersion({ assetId, versionId: built.versionId });
  return built;
}

async function setLifecycle(assetId: string, status: string): Promise<void> {
  await db()
    .update(schema.asset)
    .set({ lifecycleStatus: status as never })
    .where(eq(schema.asset.id, assetId));
}

async function lifecycleOf(assetId: string): Promise<string | undefined> {
  const [row] = await db()
    .select({ status: schema.asset.lifecycleStatus })
    .from(schema.asset)
    .where(eq(schema.asset.id, assetId));
  return row?.status;
}

async function assetRow(assetId: string) {
  const [row] = await db().select().from(schema.asset).where(eq(schema.asset.id, assetId));
  return row;
}

async function sourceConfig(assetId: string): Promise<Record<string, unknown>> {
  const [row] = await db()
    .select({ config: schema.source.config })
    .from(schema.source)
    .where(eq(schema.source.assetId, assetId))
    .orderBy(asc(schema.source.id))
    .limit(1);
  return (row?.config ?? {}) as Record<string, unknown>;
}

async function reviews(assetId: string) {
  return db()
    .select()
    .from(schema.assetReview)
    .where(eq(schema.assetReview.assetId, assetId))
    .orderBy(asc(schema.assetReview.createdAt), asc(schema.assetReview.id));
}

/** A reviewer's decision, written as the console writes one. */
async function reviewerDecision(
  assetId: string,
  outcome: string,
  feedback: string[],
  createdAt: Date,
): Promise<void> {
  await db().insert(schema.assetReview).values({
    id: uuidv7(),
    assetId,
    versionId: null,
    stage: 'review',
    outcome,
    feedback,
    reviewerId: null,
    createdAt,
    decidedAt: createdAt,
  });
}

/** The refusal code, so a case asserts which guard fired rather than that one did. */
async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    if (error instanceof PlatformAssetRefused) return error.code;
    if (error && typeof error === 'object' && 'code' in error) return String(error.code);
    return `unexpected:${String(error)}`;
  }
}

describeWithDb('owner asset management', () => {
  afterAll(async () => {
    const database = db();
    if (assets.length > 0) {
      await database
        .delete(schema.workflowOperation)
        .where(inArray(schema.workflowOperation.assetId, assets));
      await database
        .update(schema.asset)
        .set({ currentVersionId: null })
        .where(inArray(schema.asset.id, assets));
      await database
        .delete(schema.usageEvent)
        .where(inArray(schema.usageEvent.assetId, assets));
      await database
        .delete(schema.assetProfileVector)
        .where(inArray(schema.assetProfileVector.assetId, assets));
      await database
        .delete(schema.assetProfile)
        .where(inArray(schema.assetProfile.assetId, assets));
      await database.delete(schema.chunk).where(inArray(schema.chunk.assetId, assets));
      await database.delete(schema.document).where(inArray(schema.document.assetId, assets));
      await database
        .delete(schema.assetReview)
        .where(inArray(schema.assetReview.assetId, assets));
      await database
        .delete(schema.assetVersion)
        .where(inArray(schema.assetVersion.assetId, assets));
      await database
        .delete(schema.assetScore)
        .where(inArray(schema.assetScore.assetId, assets));
      await database
        .delete(schema.assetAlias)
        .where(inArray(schema.assetAlias.assetId, assets));
      await database
        .delete(schema.assetClaim)
        .where(inArray(schema.assetClaim.assetId, assets));
      await database.delete(schema.source).where(inArray(schema.source.assetId, assets));
      await database.delete(schema.asset).where(inArray(schema.asset.id, assets));
    }
    if (workspaces.length > 0) {
      await database
        .delete(schema.requestLog)
        .where(inArray(schema.requestLog.workspaceId, workspaces));
      await database
        .delete(schema.usageEvent)
        .where(inArray(schema.usageEvent.workspaceId, workspaces));
      await database
        .delete(schema.usageReservation)
        .where(inArray(schema.usageReservation.workspaceId, workspaces));
      await database
        .delete(schema.subscription)
        .where(inArray(schema.subscription.workspaceId, workspaces));
      await database
        .delete(schema.domainVerification)
        .where(inArray(schema.domainVerification.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
  });

  /* ------------------------------------------------------------- lifecycle */

  it('pauses a published asset, withdraws its queued fetches, and resumes it', async () => {
    const database = db();
    const workspaceId = await workspaceOnPlan();
    const created = await asset(workspaceId);
    await build(created.assetId);
    await setLifecycle(created.assetId, 'published');

    /* A refresh waiting in the queue: the pause is meant to withdraw it. */
    const queued = uuidv7();
    await database.insert(schema.workflowOperation).values({
      id: queued,
      assetId: created.assetId,
      operationType: 'refresh',
      sourceDigest: null,
      status: 'pending',
    });

    const paused = await applyOwnerLifecycleAction({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      action: 'pause',
    });
    expect(paused.lifecycleStatus).toBe('suspended');
    expect(paused.publicId).toBe(created.publicId);
    expect(paused.cancelledOperations).toBeGreaterThanOrEqual(1);
    expect(await lifecycleOf(created.assetId)).toBe('suspended');

    const [withdrawn] = await database
      .select({ status: schema.workflowOperation.status })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, queued));
    expect(withdrawn?.status).toBe('cancelled');

    /* The review row is what tells an owner's pause from a reviewer's. */
    const afterPause = await reviews(created.assetId);
    expect(afterPause).toHaveLength(1);
    expect(afterPause[0]?.stage).toBe(OWNER_REVIEW_STAGE);
    expect(afterPause[0]?.outcome).toBe('pause');
    expect(afterPause[0]?.decidedAt).not.toBeNull();
    expect(isOwnerPause(afterPause[0]!)).toBe(true);

    /*
     * Nothing schedules a refresh of it while it is stopped. A workspace
     * asset is out of `refreshSchedule` altogether (it filters on
     * `is_platform_asset`), which is the strongest form of the property:
     * asserted here so a later change that starts scheduling owned assets
     * has to decide what a paused one does.
     */
    const scheduled = await scheduleDueRefreshes(new Date(Date.now() + 30 * 86_400_000));
    expect(scheduled.some((row) => row.assetId === created.assetId)).toBe(false);
    const schedule = await refreshSchedule(new Date(), { assetId: created.assetId });
    expect(schedule).toHaveLength(0);

    /* A second pause has nothing to stop. */
    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          assetId: created.assetId,
          action: 'pause',
        }),
      ),
    ).toBe('invalid_request');

    const resumed = await applyOwnerLifecycleAction({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      action: 'resume',
    });
    expect(resumed.lifecycleStatus).toBe('published');
    expect(resumed.cancelledOperations).toBe(0);
    expect(await lifecycleOf(created.assetId)).toBe('published');
    const afterResume = await reviews(created.assetId);
    expect(afterResume).toHaveLength(2);
    expect(afterResume[1]?.outcome).toBe('resume');
    expect(isOwnerPause(afterResume[1]!)).toBe(false);
  });

  it('does not let the owner resume a reviewer’s suspension', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await asset(workspaceId, { visibility: 'public' });
    await build(created.assetId);
    await setLifecycle(created.assetId, 'published');

    /* The owner pauses, then a reviewer suspends on top of it. The newest
       row is the reviewer's, so the owner's earlier pause is not a licence. */
    await applyOwnerLifecycleAction({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      action: 'pause',
    });
    await reviewerDecision(created.assetId, 'reject', ['unlicensed content'], new Date(Date.now() + 1000));

    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          assetId: created.assetId,
          action: 'resume',
        }),
      ),
    ).toBe('invalid_request');
    expect(await lifecycleOf(created.assetId)).toBe('suspended');

    /* An asset the reviewer suspended without any owner pause behind it is
       refused the same way. */
    const other = await asset(workspaceId, { visibility: 'public' });
    await build(other.assetId);
    await setLifecycle(other.assetId, 'suspended');
    await reviewerDecision(other.assetId, 'reject', ['policy'], new Date());
    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          assetId: other.assetId,
          action: 'resume',
        }),
      ),
    ).toBe('invalid_request');
    expect(await lifecycleOf(other.assetId)).toBe('suspended');
  });

  it('reads the newest review row deterministically when two share a timestamp', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await asset(workspaceId, { visibility: 'public' });
    await build(created.assetId);
    await setLifecycle(created.assetId, 'published');

    await applyOwnerLifecycleAction({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      action: 'pause',
    });
    const [owned] = await reviews(created.assetId);
    /* The reviewer decides in the same millisecond the owner paused. `created_at`
       alone cannot order these two, so the row that decides whether the owner
       may resume must not depend on which one the planner returns first. */
    await reviewerDecision(created.assetId, 'reject', ['same instant'], owned!.createdAt);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await refusalOf(
          applyOwnerLifecycleAction({
            workspaceId,
            role: 'owner',
            assetId: created.assetId,
            action: 'resume',
          }),
        ),
      ).toBe('invalid_request');
    }
    expect(await lifecycleOf(created.assetId)).toBe('suspended');
  });

  /* -------------------------------------------------------------- metadata */

  it('persists title, description and language, and refuses over-long fields', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await asset(workspaceId);

    const edited = await editAssetMetadata({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      title: '  Quartzloft handbook  ',
      description: '  The onboarding checklist.  ',
      language: 'en',
    });
    expect(edited.lifecycleStatus).toBe('draft');

    const row = await assetRow(created.assetId);
    expect(row?.title).toBe('Quartzloft handbook');
    expect(row?.description).toBe('The onboarding checklist.');
    expect(row?.language).toBe('en');

    /* An empty description and language clear the columns rather than store ''. */
    await editAssetMetadata({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      title: 'Quartzloft handbook',
      description: '   ',
      language: '',
    });
    const cleared = await assetRow(created.assetId);
    expect(cleared?.description).toBeNull();
    expect(cleared?.language).toBeNull();

    /* The same limits the create path enforces, and refused, never truncated. */
    expect(
      await refusalOf(
        editAssetMetadata({
          workspaceId,
          role: 'owner',
          assetId: created.assetId,
          title: 'Quartzloft handbook',
          description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1),
        }),
      ),
    ).toBe('invalid_metadata');
    expect(
      await refusalOf(
        editAssetMetadata({
          workspaceId,
          role: 'owner',
          assetId: created.assetId,
          title: 'Quartzloft handbook',
          language: 'x'.repeat(LANGUAGE_MAX_LENGTH + 1),
        }),
      ),
    ).toBe('invalid_metadata');
    expect(
      await refusalOf(
        editAssetMetadata({
          workspaceId,
          role: 'owner',
          assetId: created.assetId,
          title: '   ',
        }),
      ),
    ).toBe('invalid_title');

    /* Creation refuses exactly the same lengths, so a value the form cannot
       save can never be stored in the first place. */
    const location = `https://docs.example.test/too-long-${Date.now()}`;
    expect(
      await refusalOf(
        createWorkspaceAsset({
          role: 'owner',
          workspaceId,
          title: 'Too long',
          description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1),
          sourceType: 'website',
          location,
          domainVerificationId: await verifiedDomain(workspaceId, location),
          slug: `too-long-${Date.now()}`,
        }),
      ),
    ).toBe('invalid_request');

    /* Nothing above changed the row. */
    const after = await assetRow(created.assetId);
    expect(after?.title).toBe('Quartzloft handbook');
    expect(after?.description).toBeNull();
  });

  it('never moves the lifecycle or the channel, and refuses an archived asset', async () => {
    const workspaceId = await workspaceOnPlan();

    /* A live asset in a public channel stays live and stays listed: who sees an
       asset is its channel (agent-first-proposal.md 6.2), not a field of this edit. */
    const live = await asset(workspaceId, { visibility: 'public' });
    await build(live.assetId);
    await setLifecycle(live.assetId, 'published');
    const edited = await editAssetMetadata({
      workspaceId,
      role: 'owner',
      assetId: live.assetId,
      title: 'Team handbook, revised',
    });
    expect(edited.lifecycleStatus).toBe('published');
    expect(await lifecycleOf(live.assetId)).toBe('published');
    expect(await inNoChannel(live.assetId)).toBe(false);

    /* A rights declaration that would not allow public use is refused while the asset is public. */
    expect(
      await refusalOf(
        editAssetMetadata({
          workspaceId,
          role: 'owner',
          assetId: live.assetId,
          title: 'Team handbook',
          rights: { origin: 'own', license: 'open_source', generation: 'generated' },
        }),
      ),
    ).toBe('rights_generated');

    /* A suspension is not lifted by an edit. */
    const stopped = await asset(workspaceId);
    await build(stopped.assetId);
    await setLifecycle(stopped.assetId, 'suspended');
    const stillStopped = await editAssetMetadata({
      workspaceId,
      role: 'owner',
      assetId: stopped.assetId,
      title: 'Team handbook',
    });
    expect(stillStopped.lifecycleStatus).toBe('suspended');

    /* An archived asset is refused, not moved. */
    await setLifecycle(stopped.assetId, 'archived');
    expect(
      await refusalOf(
        editAssetMetadata({ workspaceId, role: 'owner', assetId: stopped.assetId, title: 'Team handbook' }),
      ),
    ).toBe('archived');
  });

  /* ----------------------------------------------------------- parse scope */

  it('stores the parse scope under the re0.json field names', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await asset(workspaceId);

    const saved = await updateParseScope({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      folders: 'docs\n./guides/\ndocs',
      excludeFolders: 'vendor, node_modules',
      excludeFiles: '**/*.test.md',
      refreshPolicy: 'weekly',
    });
    expect(saved.scope.folders).toEqual(['docs', 'guides']);
    expect(saved.scope.excludeFolders).toEqual(['vendor', 'node_modules']);
    expect(saved.scope.excludeFiles).toEqual(['**/*.test.md']);
    expect(saved.refreshPolicy).toBe('weekly');
    /* Nothing is built yet, so there is nothing a rebuild would re-scope. */
    expect(saved.rebuildAdvised).toBe(false);

    const config = await sourceConfig(created.assetId);
    expect(config.folders).toEqual(['docs', 'guides']);
    expect(config.excludeFolders).toEqual(['vendor', 'node_modules']);
    expect(config.excludeFiles).toEqual(['**/*.test.md']);
    expect(config.ownerScoped).toBe(true);

    const [source] = await db()
      .select({ refreshPolicy: schema.source.refreshPolicy })
      .from(schema.source)
      .where(eq(schema.source.assetId, created.assetId));
    expect(source?.refreshPolicy).toEqual({ cadence: 'weekly' });

    /* Clearing every field hands the source back to its own re0.json. */
    const cleared = await updateParseScope({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      folders: '',
      excludeFolders: '',
      excludeFiles: '',
    });
    expect(cleared.scope.folders).toEqual([]);
    const clearedConfig = await sourceConfig(created.assetId);
    expect(clearedConfig.folders).toEqual([]);
    expect(clearedConfig.ownerScoped).toBe(false);

    /* A path that is not usable is refused, not dropped. */
    expect(
      await refusalOf(
        updateParseScope({
          workspaceId,
          role: 'owner',
          assetId: created.assetId,
          folders: '../secrets',
        }),
      ),
    ).toBe('invalid_metadata');
    expect(
      await refusalOf(
        updateParseScope({
          workspaceId,
          role: 'owner',
          assetId: created.assetId,
          folders: 'docs',
          refreshPolicy: 'hourly',
        }),
      ),
    ).toBe('invalid_refresh_policy');
    /* The refused saves left the cleared config alone. */
    expect((await sourceConfig(created.assetId)).folders).toEqual([]);

    /* Once there is a version, the form says a rebuild would apply the scope. */
    await build(created.assetId);
    const advised = await updateParseScope({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      folders: 'docs',
    });
    expect(advised.rebuildAdvised).toBe(true);

    /* An archived asset is not configured. */
    await setLifecycle(created.assetId, 'archived');
    expect(
      await refusalOf(
        updateParseScope({
          workspaceId,
          role: 'owner',
          assetId: created.assetId,
          folders: 'guides',
        }),
      ),
    ).toBe('invalid_request');
    expect((await sourceConfig(created.assetId)).folders).toEqual(['docs']);
  });

  it('keeps the owner’s scope across a build of a source that declares none', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await asset(workspaceId);

    await updateParseScope({
      workspaceId,
      role: 'owner',
      assetId: created.assetId,
      folders: 'docs',
    });
    expect((await sourceConfig(created.assetId)).folders).toEqual(['docs']);

    /*
     * The regression: the connector declares no re0.json, so its snapshot
     * config carries empty lists. A build that stamped those unconditionally
     * wrote `[]` over the owner's save, and the next build indexed everything.
     */
    await build(created.assetId);
    const afterFirst = await sourceConfig(created.assetId);
    expect(afterFirst.folders).toEqual(['docs']);
    expect(afterFirst.ownerScoped).toBe(true);

    /* And it is still there a build later, which is where it used to show. */
    await build(created.assetId);
    const afterSecond = await sourceConfig(created.assetId);
    expect(afterSecond.folders).toEqual(['docs']);
    expect(afterSecond.ownerScoped).toBe(true);
  });

  it('still stamps a connector’s own declaration when the owner has not overridden', async () => {
    const workspaceId = await workspaceOnPlan();
    const declaring = await asset(workspaceId);
    expect((await sourceConfig(declaring.assetId)).folders).toBeUndefined();

    await build(declaring.assetId, { folders: ['guides'], excludeFolders: ['vendor'] });
    const stamped = await sourceConfig(declaring.assetId);
    expect(stamped.folders).toEqual(['guides']);
    expect(stamped.excludeFolders).toEqual(['vendor']);
    expect(stamped.ownerScoped).toBeUndefined();

    /* Once the owner overrides, the declaration no longer wins. */
    await updateParseScope({
      workspaceId,
      role: 'owner',
      assetId: declaring.assetId,
      folders: 'docs',
    });
    await build(declaring.assetId, { folders: ['guides'], excludeFolders: ['vendor'] });
    const overridden = await sourceConfig(declaring.assetId);
    expect(overridden.folders).toEqual(['docs']);
    expect(overridden.ownerScoped).toBe(true);
  });

  /* ----------------------------------------------------------------- guards */

  it('refuses a developer and a viewer, and hides another workspace’s asset', async () => {
    const workspaceId = await workspaceOnPlan();
    const stranger = await workspaceOnPlan();
    const created = await asset(workspaceId);
    await build(created.assetId);
    await setLifecycle(created.assetId, 'published');

    for (const role of ['developer', 'viewer'] as const) {
      expect(
        await refusalOf(
          applyOwnerLifecycleAction({
            workspaceId,
            role,
            assetId: created.assetId,
            action: 'pause',
          }),
        ),
      ).toBe('access_denied');
      expect(
        await refusalOf(
          editAssetMetadata({
            workspaceId,
            role,
            assetId: created.assetId,
            title: 'Renamed by a developer',
          }),
        ),
      ).toBe('access_denied');
      expect(
        await refusalOf(
          updateParseScope({
            workspaceId,
            role,
            assetId: created.assetId,
            folders: 'docs',
          }),
        ),
      ).toBe('access_denied');
    }

    /* Another workspace's asset, and one that does not exist, answer alike. */
    const missing = crypto.randomUUID();
    for (const assetId of [created.assetId, missing, 'not-a-uuid']) {
      expect(
        await refusalOf(
          applyOwnerLifecycleAction({
            workspaceId: stranger,
            role: 'owner',
            assetId,
            action: 'pause',
          }),
        ),
      ).toBe('asset_not_found');
      expect(
        await refusalOf(
          editAssetMetadata({
            workspaceId: stranger,
            role: 'owner',
            assetId,
            title: 'Mine now',
          }),
        ),
      ).toBe('asset_not_found');
      expect(
        await refusalOf(
          updateParseScope({
            workspaceId: stranger,
            role: 'owner',
            assetId,
            folders: 'docs',
          }),
        ),
      ).toBe('asset_not_found');
    }

    /* The refused calls wrote nothing. */
    const row = await assetRow(created.assetId);
    expect(row?.title).toBe('Team handbook');
    expect(await inNoChannel(created.assetId)).toBe(true);
    expect(row?.lifecycleStatus).toBe('published');
    expect(await reviews(created.assetId)).toHaveLength(0);

    /* A platform asset is not this workspace's to manage either. */
    const platformId = uuidv7();
    assets.push(platformId);
    await db().insert(schema.asset).values({
      id: platformId,
      publicId: `/websites/platform-manage-${Date.now()}`,
      title: 'Platform asset',
      ownerWorkspaceId: workspaceId,
      isPlatformAsset: true,
      kind: 'website',
      lifecycleStatus: 'published',
      indexStatus: 'ready',
    });
    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          assetId: platformId,
          action: 'pause',
        }),
      ),
    ).toBe('asset_not_found');
  });
});

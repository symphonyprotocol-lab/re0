/**
 * The owner's management verbs over their own library -- pause, resume,
 * resubmit, edit metadata and configure the parse scope -- against a real
 * database. The rules themselves are unit tested (tests/contract/library-manage);
 * what cannot be unit tested is the part these tests exist for: that the SQL
 * behind each verb writes the rows the rules decided, that the guards read
 * ownership from the table rather than from the caller, and that a build
 * run afterwards leaves the owner's configuration alone.
 *
 * The properties under test:
 *
 * - pause moves `published` -> `suspended`, withdraws the queued fetches, and
 *   leaves a `library_review` row that says the owner stopped it; resume lifts
 *   only that, never a reviewer's suspension;
 * - a suspended library is not picked up by refresh scheduling;
 * - resubmit takes a `changes_requested` public library back to `submitted`
 *   with a new review row, refuses every other state, and does not disturb the
 *   reviewer's note;
 * - the metadata edit persists title, description and language, applies
 *   `visibilityTransition` to the lifecycle in both directions, and refuses an
 *   over-long description or language at the same limits creation enforces;
 * - the parse scope lands on `source.config` under the `re0.json` field names
 *   and survives a build of a source that declares no `re0.json` -- the
 *   regression that made the next build index everything -- while a connector
 *   that does declare a scope still stamps it when the owner has not overridden;
 * - every verb is refused for a `developer` or `viewer`, and a library another
 *   workspace owns answers `library_not_found`, as a missing one does.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const {
  applyOwnerLifecycleAction,
  createWorkspaceLibrary,
  editLibraryMetadata,
  updateParseScope,
} = await import('@/lib/application/libraries');
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
  PlatformLibraryRefused,
} = await import('@/lib/domain/library');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { verifiedDomain } = await import('@/tests/fixtures/verified-domain');
const { uuidv7 } = await import('@/lib/domain/id');

const workspaces: string[] = [];
const libraries: string[] = [];
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

async function workspaceOnPlan(libraryLimit = 10): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'manage-lib-test' });

  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'pro',
    priceMinor: 2000,
    currency: 'USD',
    monthlyCalls: 1_000,
    libraryLimit,
    librarySizeBytesLimit: 1_000_000,
    apiKeyLimit: 5,
    shareRateBps: 2000,
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

/** A website library owned by `workspaceId`, with the domain challenge it needs. */
async function library(
  workspaceId: string,
  options: { visibility?: 'public' | 'private'; description?: string; language?: string } = {},
): Promise<{ libraryId: string; publicId: string; operationId: string | null }> {
  const slug = `manage-${Date.now()}-${counter++}`;
  const location = `https://docs.example.test/${slug}`;
  const created = await createWorkspaceLibrary({
    role: 'owner',
    workspaceId,
    title: 'Team handbook',
    description: options.description,
    language: options.language,
    visibility: options.visibility ?? 'private',
    sourceType: 'website',
    location,
    domainVerificationId: await verifiedDomain(workspaceId, location),
    slug,
  });
  libraries.push(created.libraryId);
  return { libraryId: created.libraryId, publicId: created.publicId, operationId: created.operationId };
}

/** Builds and publishes, so the library has an indexed current version. */
async function build(libraryId: string, declared?: { folders?: string[]; excludeFolders?: string[] }) {
  const built = await buildVersion({
    libraryId,
    operationId: uuidv7(),
    dependencies: dependencies(declared),
  });
  expect(built.changed).toBe(true);
  if (!built.changed) throw new Error('the fixture build produced no version');
  await publishVersion({ libraryId, versionId: built.versionId });
  return built;
}

async function setLifecycle(libraryId: string, status: string): Promise<void> {
  await db()
    .update(schema.library)
    .set({ lifecycleStatus: status as never })
    .where(eq(schema.library.id, libraryId));
}

async function lifecycleOf(libraryId: string): Promise<string | undefined> {
  const [row] = await db()
    .select({ status: schema.library.lifecycleStatus })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId));
  return row?.status;
}

async function libraryRow(libraryId: string) {
  const [row] = await db().select().from(schema.library).where(eq(schema.library.id, libraryId));
  return row;
}

async function sourceConfig(libraryId: string): Promise<Record<string, unknown>> {
  const [row] = await db()
    .select({ config: schema.source.config })
    .from(schema.source)
    .where(eq(schema.source.libraryId, libraryId))
    .orderBy(asc(schema.source.id))
    .limit(1);
  return (row?.config ?? {}) as Record<string, unknown>;
}

async function reviews(libraryId: string) {
  return db()
    .select()
    .from(schema.libraryReview)
    .where(eq(schema.libraryReview.libraryId, libraryId))
    .orderBy(asc(schema.libraryReview.createdAt), asc(schema.libraryReview.id));
}

/** A reviewer's decision, written as the console writes one. */
async function reviewerDecision(
  libraryId: string,
  outcome: string,
  feedback: string[],
  createdAt: Date,
): Promise<void> {
  await db().insert(schema.libraryReview).values({
    id: uuidv7(),
    libraryId,
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
    if (error instanceof PlatformLibraryRefused) return error.code;
    if (error && typeof error === 'object' && 'code' in error) return String(error.code);
    return `unexpected:${String(error)}`;
  }
}

describeWithDb('owner library management', () => {
  afterAll(async () => {
    const database = db();
    if (libraries.length > 0) {
      await database
        .delete(schema.workflowOperation)
        .where(inArray(schema.workflowOperation.libraryId, libraries));
      await database
        .update(schema.library)
        .set({ currentVersionId: null })
        .where(inArray(schema.library.id, libraries));
      await database
        .delete(schema.usageEvent)
        .where(inArray(schema.usageEvent.libraryId, libraries));
      await database
        .delete(schema.libraryProfileVector)
        .where(inArray(schema.libraryProfileVector.libraryId, libraries));
      await database
        .delete(schema.libraryProfile)
        .where(inArray(schema.libraryProfile.libraryId, libraries));
      await database.delete(schema.chunk).where(inArray(schema.chunk.libraryId, libraries));
      await database.delete(schema.document).where(inArray(schema.document.libraryId, libraries));
      await database
        .delete(schema.libraryReview)
        .where(inArray(schema.libraryReview.libraryId, libraries));
      await database
        .delete(schema.libraryVersion)
        .where(inArray(schema.libraryVersion.libraryId, libraries));
      await database
        .delete(schema.libraryScore)
        .where(inArray(schema.libraryScore.libraryId, libraries));
      await database
        .delete(schema.libraryAlias)
        .where(inArray(schema.libraryAlias.libraryId, libraries));
      await database
        .delete(schema.libraryClaim)
        .where(inArray(schema.libraryClaim.libraryId, libraries));
      await database.delete(schema.source).where(inArray(schema.source.libraryId, libraries));
      await database.delete(schema.library).where(inArray(schema.library.id, libraries));
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

  it('pauses a published library, withdraws its queued fetches, and resumes it', async () => {
    const database = db();
    const workspaceId = await workspaceOnPlan();
    const created = await library(workspaceId);
    await build(created.libraryId);
    await setLifecycle(created.libraryId, 'published');

    /* A refresh waiting in the queue: the pause is meant to withdraw it. */
    const queued = uuidv7();
    await database.insert(schema.workflowOperation).values({
      id: queued,
      libraryId: created.libraryId,
      operationType: 'refresh',
      sourceDigest: null,
      status: 'pending',
    });

    const paused = await applyOwnerLifecycleAction({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      action: 'pause',
    });
    expect(paused.lifecycleStatus).toBe('suspended');
    expect(paused.publicId).toBe(created.publicId);
    expect(paused.cancelledOperations).toBeGreaterThanOrEqual(1);
    expect(await lifecycleOf(created.libraryId)).toBe('suspended');

    const [withdrawn] = await database
      .select({ status: schema.workflowOperation.status })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, queued));
    expect(withdrawn?.status).toBe('cancelled');

    /* The review row is what tells an owner's pause from a reviewer's. */
    const afterPause = await reviews(created.libraryId);
    expect(afterPause).toHaveLength(1);
    expect(afterPause[0]?.stage).toBe(OWNER_REVIEW_STAGE);
    expect(afterPause[0]?.outcome).toBe('pause');
    expect(afterPause[0]?.decidedAt).not.toBeNull();
    expect(isOwnerPause(afterPause[0]!)).toBe(true);

    /*
     * Nothing schedules a refresh of it while it is stopped. A workspace
     * library is out of `refreshSchedule` altogether (it filters on
     * `is_platform_library`), which is the strongest form of the property:
     * asserted here so a later change that starts scheduling owned libraries
     * has to decide what a paused one does.
     */
    const scheduled = await scheduleDueRefreshes(new Date(Date.now() + 30 * 86_400_000));
    expect(scheduled.some((row) => row.libraryId === created.libraryId)).toBe(false);
    const schedule = await refreshSchedule(new Date(), { libraryId: created.libraryId });
    expect(schedule).toHaveLength(0);

    /* A second pause has nothing to stop. */
    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          libraryId: created.libraryId,
          action: 'pause',
        }),
      ),
    ).toBe('invalid_request');

    const resumed = await applyOwnerLifecycleAction({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      action: 'resume',
    });
    expect(resumed.lifecycleStatus).toBe('published');
    expect(resumed.cancelledOperations).toBe(0);
    expect(await lifecycleOf(created.libraryId)).toBe('published');
    const afterResume = await reviews(created.libraryId);
    expect(afterResume).toHaveLength(2);
    expect(afterResume[1]?.outcome).toBe('resume');
    expect(isOwnerPause(afterResume[1]!)).toBe(false);
  });

  it('does not let the owner resume a reviewer’s suspension', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await library(workspaceId, { visibility: 'public' });
    await build(created.libraryId);
    await setLifecycle(created.libraryId, 'published');

    /* The owner pauses, then a reviewer suspends on top of it. The newest
       row is the reviewer's, so the owner's earlier pause is not a licence. */
    await applyOwnerLifecycleAction({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      action: 'pause',
    });
    await reviewerDecision(created.libraryId, 'reject', ['unlicensed content'], new Date(Date.now() + 1000));

    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          libraryId: created.libraryId,
          action: 'resume',
        }),
      ),
    ).toBe('invalid_request');
    expect(await lifecycleOf(created.libraryId)).toBe('suspended');

    /* A library the reviewer suspended without any owner pause behind it is
       refused the same way. */
    const other = await library(workspaceId, { visibility: 'public' });
    await build(other.libraryId);
    await setLifecycle(other.libraryId, 'suspended');
    await reviewerDecision(other.libraryId, 'reject', ['policy'], new Date());
    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          libraryId: other.libraryId,
          action: 'resume',
        }),
      ),
    ).toBe('invalid_request');
    expect(await lifecycleOf(other.libraryId)).toBe('suspended');
  });

  it('reads the newest review row deterministically when two share a timestamp', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await library(workspaceId, { visibility: 'public' });
    await build(created.libraryId);
    await setLifecycle(created.libraryId, 'published');

    await applyOwnerLifecycleAction({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      action: 'pause',
    });
    const [owned] = await reviews(created.libraryId);
    /* The reviewer decides in the same millisecond the owner paused. `created_at`
       alone cannot order these two, so the row that decides whether the owner
       may resume must not depend on which one the planner returns first. */
    await reviewerDecision(created.libraryId, 'reject', ['same instant'], owned!.createdAt);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await refusalOf(
          applyOwnerLifecycleAction({
            workspaceId,
            role: 'owner',
            libraryId: created.libraryId,
            action: 'resume',
          }),
        ),
      ).toBe('invalid_request');
    }
    expect(await lifecycleOf(created.libraryId)).toBe('suspended');
  });

  /* -------------------------------------------------------------- resubmit */

  it('resubmits a returned public library and refuses every other state', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await library(workspaceId, { visibility: 'public' });
    await build(created.libraryId);

    const note = 'Please remove the vendored third-party manuals.';
    await reviewerDecision(created.libraryId, 'request_changes', [note], new Date(Date.now() - 60_000));
    await setLifecycle(created.libraryId, 'changes_requested');

    const resubmitted = await applyOwnerLifecycleAction({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      action: 'resubmit',
    });
    expect(resubmitted.lifecycleStatus).toBe('submitted');
    expect(await lifecycleOf(created.libraryId)).toBe('submitted');

    const rows = await reviews(created.libraryId);
    expect(rows).toHaveLength(2);
    /* The reviewer's note stays readable beside the new submission. */
    expect(rows[0]?.stage).toBe('review');
    expect(rows[0]?.feedback).toEqual([note]);
    const fresh = rows[1]!;
    expect(fresh.stage).toBe(OWNER_REVIEW_STAGE);
    expect(fresh.outcome).toBe('resubmit');
    /* Undecided until a reviewer answers. */
    expect(fresh.decidedAt).toBeNull();
    expect(fresh.versionId).toBe((await libraryRow(created.libraryId))?.currentVersionId);

    /* Now that it is `submitted`, resubmitting again is refused. */
    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          libraryId: created.libraryId,
          action: 'resubmit',
        }),
      ),
    ).toBe('invalid_request');

    /* A private library the reviewer never saw, and a published one. */
    for (const state of ['draft', 'published', 'suspended', 'reviewing'] as const) {
      await setLifecycle(created.libraryId, state);
      expect(
        await refusalOf(
          applyOwnerLifecycleAction({
            workspaceId,
            role: 'owner',
            libraryId: created.libraryId,
            action: 'resubmit',
          }),
        ),
      ).toBe('invalid_request');
    }

    /* `changes_requested` is not enough on its own: a private library is not
       in the review queue, and one with no indexed version has nothing to
       hand a reviewer. */
    const priv = await library(workspaceId, { visibility: 'private' });
    await build(priv.libraryId);
    await setLifecycle(priv.libraryId, 'changes_requested');
    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          libraryId: priv.libraryId,
          action: 'resubmit',
        }),
      ),
    ).toBe('invalid_request');

    const unbuilt = await library(workspaceId, { visibility: 'public' });
    await setLifecycle(unbuilt.libraryId, 'changes_requested');
    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          libraryId: unbuilt.libraryId,
          action: 'resubmit',
        }),
      ),
    ).toBe('invalid_request');
    /* Nothing was written for a refused verb. */
    expect(await reviews(unbuilt.libraryId)).toHaveLength(0);
    expect(await lifecycleOf(unbuilt.libraryId)).toBe('changes_requested');
  });

  /* -------------------------------------------------------------- metadata */

  it('persists title, description and language, and refuses over-long fields', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await library(workspaceId);

    const edited = await editLibraryMetadata({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      title: '  Quartzloft handbook  ',
      description: '  The onboarding checklist.  ',
      language: 'en',
      visibility: 'private',
    });
    expect(edited.visibility).toBe('private');
    expect(edited.queuedForReview).toBe(false);

    const row = await libraryRow(created.libraryId);
    expect(row?.title).toBe('Quartzloft handbook');
    expect(row?.description).toBe('The onboarding checklist.');
    expect(row?.language).toBe('en');

    /* An empty description and language clear the columns rather than store ''. */
    await editLibraryMetadata({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      title: 'Quartzloft handbook',
      description: '   ',
      language: '',
      visibility: 'private',
    });
    const cleared = await libraryRow(created.libraryId);
    expect(cleared?.description).toBeNull();
    expect(cleared?.language).toBeNull();

    /* The same limits the create path enforces, and refused, never truncated. */
    expect(
      await refusalOf(
        editLibraryMetadata({
          workspaceId,
          role: 'owner',
          libraryId: created.libraryId,
          title: 'Quartzloft handbook',
          description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1),
          visibility: 'private',
        }),
      ),
    ).toBe('invalid_metadata');
    expect(
      await refusalOf(
        editLibraryMetadata({
          workspaceId,
          role: 'owner',
          libraryId: created.libraryId,
          title: 'Quartzloft handbook',
          language: 'x'.repeat(LANGUAGE_MAX_LENGTH + 1),
          visibility: 'private',
        }),
      ),
    ).toBe('invalid_metadata');
    expect(
      await refusalOf(
        editLibraryMetadata({
          workspaceId,
          role: 'owner',
          libraryId: created.libraryId,
          title: '   ',
          visibility: 'private',
        }),
      ),
    ).toBe('invalid_title');
    expect(
      await refusalOf(
        editLibraryMetadata({
          workspaceId,
          role: 'owner',
          libraryId: created.libraryId,
          title: 'Quartzloft handbook',
          visibility: 'unlisted',
        }),
      ),
    ).toBe('invalid_metadata');

    /* Creation refuses exactly the same lengths, so a value the form cannot
       save can never be stored in the first place. */
    const location = `https://docs.example.test/too-long-${Date.now()}`;
    expect(
      await refusalOf(
        createWorkspaceLibrary({
          role: 'owner',
          workspaceId,
          title: 'Too long',
          description: 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1),
          visibility: 'private',
          sourceType: 'website',
          location,
          domainVerificationId: await verifiedDomain(workspaceId, location),
          slug: `too-long-${Date.now()}`,
        }),
      ),
    ).toBe('invalid_request');

    /* Nothing above changed the row. */
    const after = await libraryRow(created.libraryId);
    expect(after?.title).toBe('Quartzloft handbook');
    expect(after?.description).toBeNull();
  });

  it('applies the visibility transition rules in both directions', async () => {
    const workspaceId = await workspaceOnPlan();

    /* private -> public, published: queues for review. */
    const live = await library(workspaceId, { visibility: 'private' });
    await build(live.libraryId);
    await setLifecycle(live.libraryId, 'published');
    const toPublic = await editLibraryMetadata({
      workspaceId,
      role: 'owner',
      libraryId: live.libraryId,
      title: 'Team handbook',
      visibility: 'public',
    });
    expect(toPublic.visibility).toBe('public');
    expect(toPublic.lifecycleStatus).toBe('submitted');
    expect(toPublic.queuedForReview).toBe(true);
    expect(await lifecycleOf(live.libraryId)).toBe('submitted');

    /* public -> private while waiting on a reviewer: with an indexed version
       it goes live, and no review is required again. */
    const back = await editLibraryMetadata({
      workspaceId,
      role: 'owner',
      libraryId: live.libraryId,
      title: 'Team handbook',
      visibility: 'private',
    });
    expect(back.lifecycleStatus).toBe('published');
    expect(back.queuedForReview).toBe(false);
    expect((await libraryRow(live.libraryId))?.visibility).toBe('private');

    /* private -> public on a draft: the build queues it, not this edit. */
    const draft = await library(workspaceId, { visibility: 'private' });
    const draftPublic = await editLibraryMetadata({
      workspaceId,
      role: 'owner',
      libraryId: draft.libraryId,
      title: 'Team handbook',
      visibility: 'public',
    });
    expect(draftPublic.lifecycleStatus).toBe('draft');
    expect(draftPublic.queuedForReview).toBe(false);

    /* public -> private with no indexed version goes back to draft. */
    await setLifecycle(draft.libraryId, 'submitted');
    const draftPrivate = await editLibraryMetadata({
      workspaceId,
      role: 'owner',
      libraryId: draft.libraryId,
      title: 'Team handbook',
      visibility: 'private',
    });
    expect(draftPrivate.lifecycleStatus).toBe('draft');

    /* A suspension is not lifted by going private. */
    const stopped = await library(workspaceId, { visibility: 'public' });
    await build(stopped.libraryId);
    await setLifecycle(stopped.libraryId, 'suspended');
    const stillStopped = await editLibraryMetadata({
      workspaceId,
      role: 'owner',
      libraryId: stopped.libraryId,
      title: 'Team handbook',
      visibility: 'private',
    });
    expect(stillStopped.lifecycleStatus).toBe('suspended');
    expect(await lifecycleOf(stopped.libraryId)).toBe('suspended');

    /* An archived library is refused, not moved. */
    await setLifecycle(stopped.libraryId, 'archived');
    expect(
      await refusalOf(
        editLibraryMetadata({
          workspaceId,
          role: 'owner',
          libraryId: stopped.libraryId,
          title: 'Team handbook',
          visibility: 'public',
        }),
      ),
    ).toBe('archived');
    expect((await libraryRow(stopped.libraryId))?.visibility).toBe('private');
  });

  /* ----------------------------------------------------------- parse scope */

  it('stores the parse scope under the re0.json field names', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await library(workspaceId);

    const saved = await updateParseScope({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
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

    const config = await sourceConfig(created.libraryId);
    expect(config.folders).toEqual(['docs', 'guides']);
    expect(config.excludeFolders).toEqual(['vendor', 'node_modules']);
    expect(config.excludeFiles).toEqual(['**/*.test.md']);
    expect(config.ownerScoped).toBe(true);

    const [source] = await db()
      .select({ refreshPolicy: schema.source.refreshPolicy })
      .from(schema.source)
      .where(eq(schema.source.libraryId, created.libraryId));
    expect(source?.refreshPolicy).toEqual({ cadence: 'weekly' });

    /* Clearing every field hands the source back to its own re0.json. */
    const cleared = await updateParseScope({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      folders: '',
      excludeFolders: '',
      excludeFiles: '',
    });
    expect(cleared.scope.folders).toEqual([]);
    const clearedConfig = await sourceConfig(created.libraryId);
    expect(clearedConfig.folders).toEqual([]);
    expect(clearedConfig.ownerScoped).toBe(false);

    /* A path that is not usable is refused, not dropped. */
    expect(
      await refusalOf(
        updateParseScope({
          workspaceId,
          role: 'owner',
          libraryId: created.libraryId,
          folders: '../secrets',
        }),
      ),
    ).toBe('invalid_metadata');
    expect(
      await refusalOf(
        updateParseScope({
          workspaceId,
          role: 'owner',
          libraryId: created.libraryId,
          folders: 'docs',
          refreshPolicy: 'hourly',
        }),
      ),
    ).toBe('invalid_refresh_policy');
    /* The refused saves left the cleared config alone. */
    expect((await sourceConfig(created.libraryId)).folders).toEqual([]);

    /* Once there is a version, the form says a rebuild would apply the scope. */
    await build(created.libraryId);
    const advised = await updateParseScope({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      folders: 'docs',
    });
    expect(advised.rebuildAdvised).toBe(true);

    /* An archived library is not configured. */
    await setLifecycle(created.libraryId, 'archived');
    expect(
      await refusalOf(
        updateParseScope({
          workspaceId,
          role: 'owner',
          libraryId: created.libraryId,
          folders: 'guides',
        }),
      ),
    ).toBe('invalid_request');
    expect((await sourceConfig(created.libraryId)).folders).toEqual(['docs']);
  });

  it('keeps the owner’s scope across a build of a source that declares none', async () => {
    const workspaceId = await workspaceOnPlan();
    const created = await library(workspaceId);

    await updateParseScope({
      workspaceId,
      role: 'owner',
      libraryId: created.libraryId,
      folders: 'docs',
    });
    expect((await sourceConfig(created.libraryId)).folders).toEqual(['docs']);

    /*
     * The regression: the connector declares no re0.json, so its snapshot
     * config carries empty lists. A build that stamped those unconditionally
     * wrote `[]` over the owner's save, and the next build indexed everything.
     */
    await build(created.libraryId);
    const afterFirst = await sourceConfig(created.libraryId);
    expect(afterFirst.folders).toEqual(['docs']);
    expect(afterFirst.ownerScoped).toBe(true);

    /* And it is still there a build later, which is where it used to show. */
    await build(created.libraryId);
    const afterSecond = await sourceConfig(created.libraryId);
    expect(afterSecond.folders).toEqual(['docs']);
    expect(afterSecond.ownerScoped).toBe(true);
  });

  it('still stamps a connector’s own declaration when the owner has not overridden', async () => {
    const workspaceId = await workspaceOnPlan();
    const declaring = await library(workspaceId);
    expect((await sourceConfig(declaring.libraryId)).folders).toBeUndefined();

    await build(declaring.libraryId, { folders: ['guides'], excludeFolders: ['vendor'] });
    const stamped = await sourceConfig(declaring.libraryId);
    expect(stamped.folders).toEqual(['guides']);
    expect(stamped.excludeFolders).toEqual(['vendor']);
    expect(stamped.ownerScoped).toBeUndefined();

    /* Once the owner overrides, the declaration no longer wins. */
    await updateParseScope({
      workspaceId,
      role: 'owner',
      libraryId: declaring.libraryId,
      folders: 'docs',
    });
    await build(declaring.libraryId, { folders: ['guides'], excludeFolders: ['vendor'] });
    const overridden = await sourceConfig(declaring.libraryId);
    expect(overridden.folders).toEqual(['docs']);
    expect(overridden.ownerScoped).toBe(true);
  });

  /* ----------------------------------------------------------------- guards */

  it('refuses a developer and a viewer, and hides another workspace’s library', async () => {
    const workspaceId = await workspaceOnPlan();
    const stranger = await workspaceOnPlan();
    const created = await library(workspaceId);
    await build(created.libraryId);
    await setLifecycle(created.libraryId, 'published');

    for (const role of ['developer', 'viewer'] as const) {
      expect(
        await refusalOf(
          applyOwnerLifecycleAction({
            workspaceId,
            role,
            libraryId: created.libraryId,
            action: 'pause',
          }),
        ),
      ).toBe('access_denied');
      expect(
        await refusalOf(
          editLibraryMetadata({
            workspaceId,
            role,
            libraryId: created.libraryId,
            title: 'Renamed by a developer',
            visibility: 'public',
          }),
        ),
      ).toBe('access_denied');
      expect(
        await refusalOf(
          updateParseScope({
            workspaceId,
            role,
            libraryId: created.libraryId,
            folders: 'docs',
          }),
        ),
      ).toBe('access_denied');
    }

    /* Another workspace's library, and one that does not exist, answer alike. */
    const missing = crypto.randomUUID();
    for (const libraryId of [created.libraryId, missing, 'not-a-uuid']) {
      expect(
        await refusalOf(
          applyOwnerLifecycleAction({
            workspaceId: stranger,
            role: 'owner',
            libraryId,
            action: 'pause',
          }),
        ),
      ).toBe('library_not_found');
      expect(
        await refusalOf(
          editLibraryMetadata({
            workspaceId: stranger,
            role: 'owner',
            libraryId,
            title: 'Mine now',
            visibility: 'public',
          }),
        ),
      ).toBe('library_not_found');
      expect(
        await refusalOf(
          updateParseScope({
            workspaceId: stranger,
            role: 'owner',
            libraryId,
            folders: 'docs',
          }),
        ),
      ).toBe('library_not_found');
    }

    /* The refused calls wrote nothing. */
    const row = await libraryRow(created.libraryId);
    expect(row?.title).toBe('Team handbook');
    expect(row?.visibility).toBe('private');
    expect(row?.lifecycleStatus).toBe('published');
    expect(await reviews(created.libraryId)).toHaveLength(0);

    /* A platform library is not this workspace's to manage either. */
    const platformId = uuidv7();
    libraries.push(platformId);
    await db().insert(schema.library).values({
      id: platformId,
      publicId: `/websites/platform-manage-${Date.now()}`,
      title: 'Platform library',
      ownerWorkspaceId: workspaceId,
      isPlatformLibrary: true,
      visibility: 'public',
      lifecycleStatus: 'published',
      indexStatus: 'ready',
    });
    expect(
      await refusalOf(
        applyOwnerLifecycleAction({
          workspaceId,
          role: 'owner',
          libraryId: platformId,
          action: 'pause',
        }),
      ),
    ).toBe('library_not_found');
  });
});

/**
 * The expert tag end to end, against a real database. expert-library-prd.md
 * 9: an owner applies, an administrator decides, and the earning gate obeys
 * -- an untagged library earns nothing, a tagged one earns, a tagged one
 * whose owner is not on a paid plan earns nothing, and a revocation voids the
 * open period's events while leaving a locked one alone.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { buildVersion, memoryObjectStore, publishVersion } = await import(
  '@/lib/application/ingestion'
);
const { queryDocs } = await import('@/lib/application/retrieval/query-docs');
const {
  applyForExpertTag,
  decideExpertApplication,
  expertApplicationDetail,
  expertPanel,
  listExpertApplications,
  pendingExpertApplications,
  revokeExpertTag,
  withdrawExpertApplication,
} = await import('@/lib/application/expert-libraries');
const { ExpertLibraryRefused } = await import('@/lib/domain/expert-library');
const { revenuePeriodId } = await import('@/lib/domain');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { uuidv7 } = await import('@/lib/domain/id');

const created: string[] = [];
const workspaces: string[] = [];
const planVersions: string[] = [];
const periods: string[] = [];
const store = memoryObjectStore();
const actor = { administratorId: null as unknown as string, email: 'reviewer@example.test' };

const nullCache = { get: async () => null, set: async () => {}, invalidateTag: async () => {} };
const noEmbeddings = {
  embeddings: () => {
    throw new Error('not configured');
  },
  rerank: () => {
    throw new Error('not configured');
  },
  cache: () => nullCache,
  configured: () => ({ embeddings: false, rerank: false }),
};

function caller(workspaceId: string | null, requestId = `req_${crypto.randomUUID()}`) {
  return { workspaceId, apiKeyId: null, requestId, anonymous: workspaceId === null };
}

function dependencies() {
  return {
    async fetchSnapshot() {
      return {
        files: [
          {
            path: 'docs/guide.md',
            url: 'https://example.test/guide',
            content: '# Field Guide\n\nMigration corridors follow the coastline every autumn season.',
          },
        ],
        config: {
          projectTitle: null,
          description: null,
          branch: null,
          folders: [],
          excludeFolders: [],
          excludeFiles: [],
          rules: [],
        },
        revision: 'fixture-revision',
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

async function workspace(name: string): Promise<string> {
  const id = crypto.randomUUID();
  workspaces.push(id);
  await db().insert(schema.workspace).values({ id, name });
  return id;
}

async function subscribed(workspaceId: string, planId: 'pro' | 'free' = 'pro'): Promise<string> {
  const database = db();
  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId,
    priceMinor: planId === 'pro' ? 2000 : 0,
    currency: 'USD',
    monthlyCalls: 100_000,
    libraryLimit: 10,
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
  return planVersionId;
}

/** A claimed, published public user library with no expert tag. */
async function userLibrary(slug: string, ownerWorkspaceId: string): Promise<string> {
  const database = db();
  const libraryId = crypto.randomUUID();
  created.push(libraryId);
  await database.insert(schema.library).values({
    id: libraryId,
    publicId: `/websites/${slug}`,
    title: `Expert fixture ${slug}`,
    ownerWorkspaceId,
    isPlatformLibrary: false,
    visibility: 'public',
    lifecycleStatus: 'draft',
    indexStatus: 'pending',
    language: 'en',
  });
  await database.insert(schema.source).values({
    id: uuidv7(),
    libraryId,
    type: 'openapi',
    location: `https://example.test/${slug}`,
  });
  const built = await buildVersion({ libraryId, operationId: uuidv7(), dependencies: dependencies() });
  if (!built.changed) throw new Error('fixture build produced no version');
  await publishVersion({ libraryId, versionId: built.versionId });
  await database
    .update(schema.library)
    .set({ lifecycleStatus: 'published' })
    .where(eq(schema.library.id, libraryId));
  return libraryId;
}

const input = (slug: string) => ({
  libraryId: `/websites/${slug}`,
  query: 'migration corridors in autumn',
  maxTokens: 4000,
  format: 'json' as const,
});

async function earningEventsOf(requestId: string) {
  return db().select().from(schema.earningEvent).where(eq(schema.earningEvent.requestId, requestId));
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    if (error instanceof ExpertLibraryRefused) return error.code;
    return `unexpected:${String(error)}`;
  }
}

describeWithDb('expert libraries', () => {
  afterAll(async () => {
    const database = db();
    if (created.length > 0) {
      await database
        .delete(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.targetType, 'expert_application'),
            inArray(
              schema.auditLog.targetId,
              database
                .select({ id: sql<string>`${schema.expertApplication.id}::text` })
                .from(schema.expertApplication)
                .where(inArray(schema.expertApplication.libraryId, created)),
            ),
          ),
        );
      await database
        .delete(schema.expertApplication)
        .where(inArray(schema.expertApplication.libraryId, created));
      await database.delete(schema.earningEvent).where(inArray(schema.earningEvent.libraryId, created));
      await database
        .update(schema.library)
        .set({ currentVersionId: null, ownerWorkspaceId: null })
        .where(inArray(schema.library.id, created));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.libraryId, created));
      await database
        .delete(schema.libraryProfileVector)
        .where(inArray(schema.libraryProfileVector.libraryId, created));
      await database.delete(schema.libraryProfile).where(inArray(schema.libraryProfile.libraryId, created));
      await database.delete(schema.chunk).where(inArray(schema.chunk.libraryId, created));
      await database.delete(schema.document).where(inArray(schema.document.libraryId, created));
      await database.delete(schema.libraryVersion).where(inArray(schema.libraryVersion.libraryId, created));
      await database.delete(schema.libraryScore).where(inArray(schema.libraryScore.libraryId, created));
      await database.delete(schema.source).where(inArray(schema.source.libraryId, created));
      await database.delete(schema.library).where(inArray(schema.library.id, created));
    }
    if (periods.length > 0) {
      await database.delete(schema.revenuePeriod).where(inArray(schema.revenuePeriod.id, periods));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.requestLog).where(inArray(schema.requestLog.workspaceId, workspaces));
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.workspaceId, workspaces));
      await database
        .delete(schema.usageReservation)
        .where(inArray(schema.usageReservation.workspaceId, workspaces));
      await database.delete(schema.subscription).where(inArray(schema.subscription.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
  });

  /* Acceptance 1, 2: the tag is what turns a served call into an earning one. */
  it('earns nothing until approved, then earns', async () => {
    const stamp = Date.now();
    const owner = await workspace('expert-owner');
    await subscribed(owner);
    const libraryId = await userLibrary(`expert-basic-${stamp}`, owner);
    const reader = await workspace('expert-reader');
    await subscribed(reader);

    const before = caller(reader);
    await queryDocs(before, input(`expert-basic-${stamp}`), noEmbeddings);
    expect(await earningEventsOf(before.requestId)).toHaveLength(0);

    const panel = await expertPanel({ workspaceId: owner, libraryId });
    expect(panel?.taggedAt).toBeNull();
    expect(panel?.blocker).toBeNull();
    expect(panel?.checks).toEqual({ public: true, published: true, subscribed: true });

    const { applicationId } = await applyForExpertTag({
      workspaceId: owner,
      role: 'owner',
      libraryId,
      note: '  Official field guide, maintained weekly.  ',
    });
    expect(await pendingExpertApplications()).toBeGreaterThanOrEqual(1);
    /* Still not earning while the application waits. */
    const waiting = caller(reader);
    await queryDocs(waiting, input(`expert-basic-${stamp}`), noEmbeddings);
    expect(await earningEventsOf(waiting.requestId)).toHaveLength(0);

    const detail = await expertApplicationDetail(applicationId);
    expect(detail?.status).toBe('pending');
    expect(detail?.note).toBe('Official field guide, maintained weekly.');
    expect(detail?.approvable).toBe(true);
    const queue = await listExpertApplications({ query: `expert-basic-${stamp}`, status: 'pending' });
    expect(queue.rows.find((row) => row.id === applicationId)?.approvable).toBe(true);

    const decided = await decideExpertApplication({
      actor,
      applicationId,
      decision: 'approve',
      reason: 'source verified, complete',
    });
    expect(decided.status).toBe('approved');
    expect(decided.expertTaggedAt).not.toBeNull();

    const after = caller(reader);
    await queryDocs(after, input(`expert-basic-${stamp}`), noEmbeddings);
    const [event] = await earningEventsOf(after.requestId);
    expect(event).toBeDefined();
    expect(event!.libraryId).toBe(libraryId);
    expect(event!.ownerWorkspaceId).toBe(owner);

    const tagged = await expertPanel({ workspaceId: owner, libraryId });
    expect(tagged?.taggedAt).not.toBeNull();
    expect(tagged?.earning).toBe(true);
    expect(tagged?.blocker).toBe('already_tagged');
    expect(tagged?.latest?.status).toBe('approved');

    const audit = await db()
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.targetType, 'expert_application'), eq(schema.auditLog.targetId, applicationId)),
      );
    expect(audit.map((row) => row.action).sort()).toEqual([
      'expert_library.apply',
      'expert_library.approve',
    ]);
  });

  /* Acceptance 3: the tag alone is not enough; the owner's plan is read per call. */
  it('does not earn for a tagged library whose owner is not on a paid plan', async () => {
    const stamp = Date.now();
    const owner = await workspace('expert-free-owner');
    const libraryId = await userLibrary(`expert-free-${stamp}`, owner);
    await db()
      .update(schema.library)
      .set({ expertTaggedAt: new Date() })
      .where(eq(schema.library.id, libraryId));
    const reader = await workspace('expert-free-reader');
    await subscribed(reader);

    const call = caller(reader);
    await queryDocs(call, input(`expert-free-${stamp}`), noEmbeddings);
    const [usage] = await db()
      .select()
      .from(schema.usageEvent)
      .where(eq(schema.usageEvent.requestId, call.requestId));
    expect(usage).toBeDefined(); // billed as normal...
    expect(await earningEventsOf(call.requestId)).toHaveLength(0); // ...earns nothing

    /* A Free subscription row is not a paid plan either. */
    await subscribed(owner, 'free');
    const stillFree = caller(reader);
    await queryDocs(stillFree, input(`expert-free-${stamp}`), noEmbeddings);
    expect(await earningEventsOf(stillFree.requestId)).toHaveLength(0);

    const panel = await expertPanel({ workspaceId: owner, libraryId });
    expect(panel?.earning).toBe(false);
    expect(panel?.checks.subscribed).toBe(false);
  });

  /* Acceptance 5: each missing precondition has its own refusal. */
  it('refuses applications that do not meet the preconditions', async () => {
    const stamp = Date.now();
    const owner = await workspace('expert-refuse-owner');
    const libraryId = await userLibrary(`expert-refuse-${stamp}`, owner);

    expect(await refusalOf(applyForExpertTag({ workspaceId: owner, role: 'viewer', libraryId }))).toBe(
      'access_denied',
    );
    expect(await refusalOf(applyForExpertTag({ workspaceId: owner, role: 'owner', libraryId }))).toBe(
      'not_subscribed',
    );
    await subscribed(owner);
    expect(
      await refusalOf(
        applyForExpertTag({ workspaceId: owner, role: 'owner', libraryId, note: 'x'.repeat(501) }),
      ),
    ).toBe('invalid_note');

    const stranger = await workspace('expert-refuse-stranger');
    expect(await refusalOf(applyForExpertTag({ workspaceId: stranger, role: 'owner', libraryId }))).toBe(
      'not_found',
    );

    await db().update(schema.library).set({ visibility: 'private' }).where(eq(schema.library.id, libraryId));
    expect(await refusalOf(applyForExpertTag({ workspaceId: owner, role: 'owner', libraryId }))).toBe(
      'not_public',
    );
    await db()
      .update(schema.library)
      .set({ visibility: 'public', lifecycleStatus: 'submitted' })
      .where(eq(schema.library.id, libraryId));
    expect(await refusalOf(applyForExpertTag({ workspaceId: owner, role: 'owner', libraryId }))).toBe(
      'not_published',
    );
    await db().update(schema.library).set({ lifecycleStatus: 'published' }).where(eq(schema.library.id, libraryId));

    await applyForExpertTag({ workspaceId: owner, role: 'owner', libraryId });
    expect(await refusalOf(applyForExpertTag({ workspaceId: owner, role: 'owner', libraryId }))).toBe(
      'already_pending',
    );

    /* Withdraw, and the queue is open again. */
    await withdrawExpertApplication({ workspaceId: owner, role: 'owner', libraryId });
    expect(await refusalOf(withdrawExpertApplication({ workspaceId: owner, role: 'owner', libraryId }))).toBe(
      'not_pending',
    );
    const panel = await expertPanel({ workspaceId: owner, libraryId });
    expect(panel?.pending).toBeNull();
    expect(panel?.latest?.status).toBe('withdrawn');
    expect(panel?.blocker).toBeNull();
  });

  /* Acceptance 6: approval re-checks the library at decision time. */
  it('refuses to approve a library that stopped qualifying, and holds a rejection to the cooldown', async () => {
    const stamp = Date.now();
    const owner = await workspace('expert-stale-owner');
    await subscribed(owner);
    const libraryId = await userLibrary(`expert-stale-${stamp}`, owner);
    const { applicationId } = await applyForExpertTag({ workspaceId: owner, role: 'owner', libraryId });

    await db().update(schema.library).set({ visibility: 'private' }).where(eq(schema.library.id, libraryId));
    const detail = await expertApplicationDetail(applicationId);
    expect(detail?.approvable).toBe(false);
    expect(detail?.checks.public).toBe(false);
    expect(
      await refusalOf(decideExpertApplication({ actor, applicationId, decision: 'approve', reason: 'ok' })),
    ).toBe('library_ineligible');
    expect(
      await refusalOf(decideExpertApplication({ actor, applicationId, decision: 'reject', reason: '' })),
    ).toBe('reason_required');

    const rejected = await decideExpertApplication({
      actor,
      applicationId,
      decision: 'reject',
      reason: 'went private during review',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.expertTaggedAt).toBeNull();
    expect(
      await refusalOf(decideExpertApplication({ actor, applicationId, decision: 'approve', reason: 'again' })),
    ).toBe('not_pending');

    await db().update(schema.library).set({ visibility: 'public' }).where(eq(schema.library.id, libraryId));
    expect(await refusalOf(applyForExpertTag({ workspaceId: owner, role: 'owner', libraryId }))).toBe(
      'cooldown',
    );
    const panel = await expertPanel({ workspaceId: owner, libraryId });
    expect(panel?.blocker).toBe('cooldown');
    expect(panel?.reapplyAllowedAt).not.toBeNull();
    expect(panel?.latest?.decisionReason).toBe('went private during review');

    const { rows } = await listExpertApplications({ query: `expert-stale-${stamp}`, status: 'rejected' });
    expect(rows.map((row) => row.id)).toContain(applicationId);
    expect(rows.find((row) => row.id === applicationId)?.approvable).toBe(false);
  });

  /* Acceptance 4: a revocation voids the open period and leaves a locked one alone. */
  it('revoking the tag voids open-period earnings, keeps locked ones, and stops earning', async () => {
    const stamp = Date.now();
    const owner = await workspace('expert-revoke-owner');
    await subscribed(owner);
    const libraryId = await userLibrary(`expert-revoke-${stamp}`, owner);
    const reader = await workspace('expert-revoke-reader');
    const planVersionId = await subscribed(reader);

    const { applicationId } = await applyForExpertTag({ workspaceId: owner, role: 'owner', libraryId });
    await decideExpertApplication({ actor, applicationId, decision: 'approve', reason: 'fine' });

    /* One real earning event this period, plus a seeded one in a locked period. */
    const open = caller(reader);
    await queryDocs(open, input(`expert-revoke-${stamp}`), noEmbeddings);
    expect(await earningEventsOf(open.requestId)).toHaveLength(1);

    const lockedPeriod = `1999-${String((stamp % 12) + 1).padStart(2, '0')}`;
    periods.push(lockedPeriod);
    await db()
      .insert(schema.revenuePeriod)
      .values({
        id: lockedPeriod,
        netRevenueMinor: 0,
        poolMinor: 0,
        totalAttributableCalls: 0,
        totalBilledCalls: 0,
        shareRateBps: 2000,
        lockedAt: new Date(),
      })
      .onConflictDoNothing();
    const lockedRequest = `req_locked_${uuidv7()}`;
    const [version] = await db()
      .select({ id: schema.libraryVersion.id })
      .from(schema.libraryVersion)
      .where(eq(schema.libraryVersion.libraryId, libraryId));
    await db().insert(schema.usageEvent).values({
      id: uuidv7(),
      workspaceId: reader,
      requestId: lockedRequest,
      libraryId,
      versionId: version!.id,
      operation: 'context',
      entrypoint: 'rest',
      debitSource: 'plan',
      statusCode: 200,
    });
    await db().insert(schema.earningEvent).values({
      id: uuidv7(),
      requestId: lockedRequest,
      libraryId,
      versionId: version!.id,
      ownerWorkspaceId: owner,
      planVersionId,
      shareRateBps: 2000,
      periodId: lockedPeriod,
    });

    const revoked = await revokeExpertTag({ actor, applicationId, reason: 'stale content' });
    expect(revoked.voidedEvents).toBe(1);

    const [openEvent] = await earningEventsOf(open.requestId);
    expect(openEvent!.flagged).toBe(true);
    expect(openEvent!.periodId).toBe(revenuePeriodId(new Date()));
    const [lockedEvent] = await earningEventsOf(lockedRequest);
    expect(lockedEvent!.flagged).toBe(false);

    const [library] = await db()
      .select({ expertTaggedAt: schema.library.expertTaggedAt })
      .from(schema.library)
      .where(eq(schema.library.id, libraryId));
    expect(library!.expertTaggedAt).toBeNull();

    const afterRevoke = caller(reader);
    await queryDocs(afterRevoke, input(`expert-revoke-${stamp}`), noEmbeddings);
    expect(await earningEventsOf(afterRevoke.requestId)).toHaveLength(0);

    expect(await refusalOf(revokeExpertTag({ actor, applicationId, reason: 'twice' }))).toBe('not_approved');
    const detail = await expertApplicationDetail(applicationId);
    expect(detail?.status).toBe('revoked');
    expect(detail?.audit.map((row) => row.action)).toContain('expert_library.revoke');
  });
});

/**
 * A user library from build to review, against a real database.
 *
 * What is under test is the hand-off between two flows that never see each
 * other: the build advances the lifecycle (private publishes, public waits),
 * and the reviewer's verbs move it from there -- each one writing the review
 * row the owner reads and the audit entry requirement.md 7.4 demands.
 *
 * Runs only when TEST_DATABASE_URL points at a disposable database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.SESSION_SIGNING_SECRET ??= 'test-secret-that-is-long-enough-000000';

const { addOwnerEvalQuestion, applyOwnerLifecycleAction, createWorkspaceLibrary, listWorkspaceLibraries } = await import(
  '@/lib/application/libraries'
);
const { getUserLibrary, reviewUserLibrary, listUserLibraries } = await import(
  '@/lib/application/administration'
);
const { runOperation, memoryObjectStore } = await import('@/lib/application/ingestion');
const { runModelReview } = await import('@/lib/application/review');
const { PlatformLibraryRefused } = await import('@/lib/domain/library');
const { AdminChangeRefused } = await import('@/lib/domain/admin');
const { AppError } = await import('@/contracts/errors');
const { EMBEDDING_COLUMN_DIMENSIONS } = await import('@/lib/infrastructure/ai/providers');
const { db, schema } = await import('@/lib/infrastructure/postgres/client');
const { verifiedDomain } = await import('@/tests/fixtures/verified-domain');
const { uuidv7 } = await import('@/lib/domain/id');
const { REVIEW_CHECKS } = await import('@/lib/domain/review');

/* The 7.4 checklist a public library's decision carries (lib/domain/review.ts), as a form posts it. */
const allPassing = Object.fromEntries(REVIEW_CHECKS.map((check) => [`check.${check}`, 'pass']));
const sourceFailing = { ...allPassing, 'check.source_firsthand': 'fail', 'note.source_firsthand': 'no licence statement' };

const workspaces: string[] = [];
const libraries: string[] = [];
const planVersions: string[] = [];
const store = memoryObjectStore();
const actor = { administratorId: null as unknown as string, email: 'reviewer@example.test' };

function dependencies(content: string) {
  return {
    async fetchSnapshot() {
      return {
        files: [{ path: 'docs/guide.md', url: 'https://docs.example.test/guide', content }],
        config: {
          projectTitle: null,
          description: null,
          branch: null,
          folders: [],
          excludeFolders: [],
          excludeFiles: [],
          rules: [],
        },
        revision: null,
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

async function workspace(): Promise<string> {
  const database = db();
  const workspaceId = crypto.randomUUID();
  workspaces.push(workspaceId);
  await database.insert(schema.workspace).values({ id: workspaceId, name: 'review-test' });
  const planVersionId = uuidv7();
  planVersions.push(planVersionId);
  await database.insert(schema.planVersion).values({
    id: planVersionId,
    planId: 'pro',
    priceMinor: 2000,
    currency: 'USD',
    monthlyCalls: 1_000,
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
  return workspaceId;
}

async function lifecycleOf(libraryId: string): Promise<string | undefined> {
  const [row] = await db()
    .select({ lifecycleStatus: schema.library.lifecycleStatus })
    .from(schema.library)
    .where(eq(schema.library.id, libraryId));
  return row?.lifecycleStatus;
}

async function queueRefresh(libraryId: string): Promise<string> {
  const operationId = uuidv7();
  await db().insert(schema.workflowOperation).values({
    id: operationId,
    libraryId,
    operationType: 'refresh',
    sourceDigest: null,
    status: 'pending',
  });
  return operationId;
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'accepted';
  } catch (error) {
    if (error instanceof PlatformLibraryRefused) return error.code;
    if (error instanceof AdminChangeRefused) return error.code;
    if (error instanceof AppError) return error.code;
    return `unexpected:${String(error)}`;
  }
}

describeWithDb('user library review', () => {
  afterAll(async () => {
    const database = db();
    if (libraries.length > 0) {
      await database.delete(schema.workflowOperation).where(inArray(schema.workflowOperation.libraryId, libraries));
      /* A user library's build writes a usage event that points at its version. */
      await database.delete(schema.usageEvent).where(inArray(schema.usageEvent.libraryId, libraries));
      await database.delete(schema.libraryReview).where(inArray(schema.libraryReview.libraryId, libraries));
      await database.delete(schema.libraryEvalQuestion).where(inArray(schema.libraryEvalQuestion.libraryId, libraries));
      await database.update(schema.library).set({ currentVersionId: null }).where(inArray(schema.library.id, libraries));
      await database.delete(schema.libraryProfileVector).where(inArray(schema.libraryProfileVector.libraryId, libraries));
      await database.delete(schema.libraryProfile).where(inArray(schema.libraryProfile.libraryId, libraries));
      await database.delete(schema.chunk).where(inArray(schema.chunk.libraryId, libraries));
      await database.delete(schema.document).where(inArray(schema.document.libraryId, libraries));
      await database.delete(schema.libraryVersion).where(inArray(schema.libraryVersion.libraryId, libraries));
      await database.delete(schema.libraryScore).where(inArray(schema.libraryScore.libraryId, libraries));
      await database
        .delete(schema.libraryClaim)
        .where(inArray(schema.libraryClaim.libraryId, libraries));
      await database.delete(schema.source).where(inArray(schema.source.libraryId, libraries));
      await database.delete(schema.library).where(inArray(schema.library.id, libraries));
      await database
        .delete(schema.auditLog)
        .where(and(eq(schema.auditLog.targetType, 'user_library'), inArray(schema.auditLog.targetId, libraries)));
    }
    if (workspaces.length > 0) {
      await database.delete(schema.subscription).where(inArray(schema.subscription.workspaceId, workspaces));
      await database
        .delete(schema.domainVerification)
        .where(inArray(schema.domainVerification.workspaceId, workspaces));
      await database.delete(schema.workspace).where(inArray(schema.workspace.id, workspaces));
    }
    if (planVersions.length > 0) {
      await database.delete(schema.planVersion).where(inArray(schema.planVersion.id, planVersions));
    }
  });

  it('publishes a private library on its first build and offers only a pause', async () => {
    const workspaceId = await workspace();
    const created = await createWorkspaceLibrary({
      workspaceId,
      role: 'owner',
      title: 'Private Guide',
      visibility: 'private',
      sourceType: 'website',
      location: 'https://docs.example.test/private',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/private'),
      slug: `private-guide-${Date.now()}`,
    });
    libraries.push(created.libraryId);
    expect(await lifecycleOf(created.libraryId)).toBe('draft');

    const built = await runOperation({ operationId: created.operationId!, dependencies: dependencies('# Private\n\nBody one.') });
    expect(built.status).toBe('succeeded');
    expect(await lifecycleOf(created.libraryId)).toBe('published');

    expect(
      await refusalOf(reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'request_changes', reason: 'no' })),
    ).toBe('invalid_transition');
    const paused = await reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'reject', reason: 'safety pause' });
    expect(paused.status).toBe('suspended');

    /* A rebuild does not lift the pause. */
    const again = await runOperation({
      operationId: await queueRefresh(created.libraryId),
      dependencies: dependencies('# Private\n\nBody two.'),
    });
    expect(again.status).toBe('succeeded');
    expect(await lifecycleOf(created.libraryId)).toBe('suspended');

    const restored = await reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'approve', reason: 'pause lifted' });
    expect(restored.status).toBe('published');
  });

  it('queues a public library for review and walks it through the three verbs', async () => {
    const workspaceId = await workspace();
    const created = await createWorkspaceLibrary({
      workspaceId,
      role: 'owner',
      title: 'Public Guide',
      visibility: 'public',
      sourceType: 'website',
      location: 'https://docs.example.test/public',
      domainVerificationId: await verifiedDomain(workspaceId, 'https://docs.example.test/public'),
      slug: `public-guide-${Date.now()}`,
      rights: { origin: 'own', license: 'open_source', generation: 'human' },
    });
    libraries.push(created.libraryId);

    /* Nothing to decide before the first version exists. */
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'approve', reason: 'early' }))).toBe(
      'invalid_transition',
    );

    /* The build indexes it, but without the owner's questions it waits in draft
       (review-visibility-proposal.md 5.2); the owner's submit queues it once they are in. */
    const built = await runOperation({ operationId: created.operationId!, dependencies: dependencies('# Public\n\nVersion one.') });
    expect(built.status).toBe('succeeded');
    expect(await lifecycleOf(created.libraryId)).toBe('draft');
    /* Questions the library cannot answer: a verified source whose set passes
       would publish at once (the next test), and this one walks the reviewer's verbs. */
    for (let at = 1; at <= 5; at += 1) {
      await addOwnerEvalQuestion({
        workspaceId,
        role: 'owner',
        libraryId: created.libraryId,
        question: `What does part ${at} cover?`,
        expectedText: 'nothing-in-this-library',
      });
    }
    const submitted = await applyOwnerLifecycleAction({ workspaceId, role: 'owner', libraryId: created.libraryId, action: 'submit' });
    expect(submitted.lifecycleStatus).toBe('submitted');
    expect(await lifecycleOf(created.libraryId)).toBe('submitted');

    const queue = await listUserLibraries({ review: 'pending' });
    const queued = queue.rows.find((row) => row.id === created.libraryId);
    expect(queued?.hasReadyVersion).toBe(true);

    /* A public decision carries the checklist, and the verdicts have to agree with the verb. */
    expect(
      await refusalOf(reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'request_changes', reason: 'no list' })),
    ).toBe('checklist_required');
    expect(
      await refusalOf(
        reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'request_changes', reason: 'all fine', checklist: allPassing }),
      ),
    ).toBe('checklist_mismatch');

    /* Sent back: the owner sees the note, a rebuild resubmits. */
    const sentBack = await reviewUserLibrary({
      actor,
      libraryId: created.libraryId,
      action: 'request_changes',
      reason: 'add a licence statement',
      checklist: sourceFailing,
    });
    expect(sentBack.status).toBe('changes_requested');
    const mine = await listWorkspaceLibraries(workspaceId);
    expect(mine.find((row) => row.id === created.libraryId)?.reviewNote).toBe('add a licence statement');

    const rebuilt = await runOperation({
      operationId: await queueRefresh(created.libraryId),
      dependencies: dependencies('# Public\n\nVersion two, with a licence.'),
    });
    expect(rebuilt.status).toBe('succeeded');
    /* A rebuild does not resubmit by itself: the owner confirms the resubmission (review-visibility-proposal.md 5). */
    expect(await lifecycleOf(created.libraryId)).toBe('changes_requested');
    const resubmitted = await applyOwnerLifecycleAction({ workspaceId, role: 'owner', libraryId: created.libraryId, action: 'resubmit' });
    expect(resubmitted.lifecycleStatus).toBe('submitted');
    expect(await lifecycleOf(created.libraryId)).toBe('submitted');

    const rejected = await reviewUserLibrary({
      actor,
      libraryId: created.libraryId,
      action: 'reject',
      reason: 'rights unclear',
      checklist: sourceFailing,
    });
    expect(rejected.status).toBe('suspended');
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'reject', reason: 'twice' }))).toBe(
      'invalid_transition',
    );

    expect(
      await refusalOf(
        reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'approve', reason: 'despite', checklist: sourceFailing }),
      ),
    ).toBe('checklist_mismatch');
    const approved = await reviewUserLibrary({
      actor,
      libraryId: created.libraryId,
      action: 'approve',
      reason: 'rights confirmed',
      checklist: allPassing,
    });
    expect(approved.status).toBe('published');
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: created.libraryId, action: 'approve', reason: 'again' }))).toBe(
      'invalid_transition',
    );

    /* Every decision left a review row and an audit entry. */
    const detail = await getUserLibrary(created.libraryId);
    expect(detail?.lifecycleStatus).toBe('published');
    /* The rules layer looked at each submission and held it for a person: a
       first public library with no evaluated owner questions is nobody's to auto-publish. */
    const holds = detail?.reviews.filter((review) => review.stage === 'rules') ?? [];
    expect(holds.length).toBeGreaterThanOrEqual(1);
    expect(holds.every((review) => review.outcome === 'hold')).toBe(true);
    /* The model layer writes nothing until a model answers: no row of its stage here. */
    expect(detail?.reviews.filter((review) => review.stage === 'model') ?? []).toHaveLength(0);
    expect(detail?.reviews.map((review) => review.outcome).filter((outcome) => outcome !== 'hold')).toEqual([
      'approve',
      'reject',
      'resubmit',
      'request_changes',
      'submit',
    ]);
    expect(detail?.openSample).toBe(false);
    const sentBackRow = detail?.reviews.find((review) => review.outcome === 'request_changes');
    const approvedRow = detail?.reviews.find((review) => review.outcome === 'approve');
    expect(sentBackRow?.feedback).toEqual(['add a licence statement']);
    expect(detail?.materials.rights?.origin).toBe('own');
    expect(detail?.materials.ownerQuestions).toBe(5);
    /* The checklist is kept with the decision and reads back as recorded. */
    expect(sentBackRow?.checklist?.source_firsthand).toEqual({ verdict: 'fail', note: 'no licence statement' });
    expect(approvedRow?.checklist?.safety).toEqual({ verdict: 'pass', note: '' });
    expect(detail?.versions).toHaveLength(2);
    const audit = await db()
      .select({ action: schema.auditLog.action, reason: schema.auditLog.reason })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'user_library'), eq(schema.auditLog.targetId, created.libraryId)));
    const actions = audit.map((entry) => entry.action);
    expect(actions.filter((action) => action !== 'user_library.rules_hold' && action !== 'user_library.model_hold').sort()).toEqual([
      'user_library.approve',
      'user_library.reject',
      'user_library.request_changes',
    ]);
    expect(actions.filter((action) => action === 'user_library.rules_hold').length).toBe(holds.length);
  });

  it('publishes a verified source on its question set alone, evaluating it at submission', async () => {
    const workspaceId = await workspace();
    const slug = `fast-${Date.now()}`;
    const created = await createWorkspaceLibrary({
      workspaceId,
      role: 'owner',
      title: 'Fast path',
      visibility: 'public',
      sourceType: 'website',
      location: `https://docs.example.test/${slug}`,
      domainVerificationId: await verifiedDomain(workspaceId, `https://docs.example.test/${slug}`),
      slug,
      rights: { origin: 'own', license: 'open_source', generation: 'human' },
    });
    libraries.push(created.libraryId);
    await runOperation({
      operationId: created.operationId!,
      dependencies: dependencies(`# Fast path ${slug}\n\nThe handbook explains the onboarding checklist and the refund policy for ${slug}.`),
    });
    expect(await lifecycleOf(created.libraryId)).toBe('draft');
    /* Written after the build: each is tried alone as it is added, and the
       earlier ones keep their result rather than being asked again. */
    const asks = ['onboarding checklist', 'refund policy', 'handbook', 'onboarding', 'refund'];
    const added: string[] = [];
    for (const ask of asks) {
      const { questionId, evaluated } = await addOwnerEvalQuestion({
        workspaceId,
        role: 'owner',
        libraryId: created.libraryId,
        question: `Where is the ${ask}?`,
        expectedText: ask,
      });
      expect(evaluated).toBe(true);
      added.push(questionId);
    }
    const [currentVersion] = await db()
      .select({ id: schema.library.currentVersionId })
      .from(schema.library)
      .where(eq(schema.library.id, created.libraryId));
    const tried = await db()
      .select({
        id: schema.libraryEvalQuestion.id,
        lastRank: schema.libraryEvalQuestion.lastRank,
        lastVersionId: schema.libraryEvalQuestion.lastVersionId,
        lastEvaluatedAt: schema.libraryEvalQuestion.lastEvaluatedAt,
      })
      .from(schema.libraryEvalQuestion)
      .where(eq(schema.libraryEvalQuestion.libraryId, created.libraryId));
    expect(tried.map((row) => row.lastVersionId)).toEqual(asks.map(() => currentVersion?.id));
    expect(tried.every((row) => row.lastRank !== null && row.lastEvaluatedAt !== null)).toBe(true);
    const first = tried.find((row) => row.id === added[0]);
    const last = tried.find((row) => row.id === added[added.length - 1]);
    expect(first!.lastEvaluatedAt!.getTime()).toBeLessThan(last!.lastEvaluatedAt!.getTime());

    const submitted = await applyOwnerLifecycleAction({ workspaceId, role: 'owner', libraryId: created.libraryId, action: 'submit' });
    expect(submitted.lifecycleStatus).toBe('published');
    expect(submitted.modelReviewOperationId).toBeFalsy();
    expect(await lifecycleOf(created.libraryId)).toBe('published');

    const detail = await getUserLibrary(created.libraryId);
    expect(detail?.reviews[0]?.stage).toBe('rules');
    expect(detail?.reviews[0]?.outcome).toBe('approve');
    expect(detail?.reviews[0]?.feedback).toEqual(['rules:auto_approved']);
    /* The questions were asked of this version on the way. */
    const asked = await db()
      .select({ lastVersionId: schema.libraryEvalQuestion.lastVersionId, lastRank: schema.libraryEvalQuestion.lastRank })
      .from(schema.libraryEvalQuestion)
      .where(eq(schema.libraryEvalQuestion.libraryId, created.libraryId));
    expect(asked).toHaveLength(5);
    expect(asked.every((row) => row.lastVersionId !== null && row.lastRank !== null)).toBe(true);
  });

  it('lets the model layer publish or send back a held submission, and the owner appeal a send-back', async () => {
    const workspaceId = await workspace();
    const fakeConfig = {
      id: crypto.randomUUID(),
      slug: 'fake',
      label: 'Fake',
      baseUrl: 'https://llm.example.test',
      model: 'fake-1',
      hasCredential: true,
      maxInputTokens: 100_000,
      maxOutputTokens: 4_000,
      timeoutMs: 10_000,
      promptPriceMicro: 1_000_000,
      completionPriceMicro: 2_000_000,
      cachePriceMicro: 0,
      supportsTools: false,
      supportsReasoning: false,
      supportsVision: false,
      reasoningEffort: null,
      enabled: true,
      createdAt: new Date(),
      assignedTo: ['subscriber' as const],
    };
    const costs: { purpose?: string; libraryPublicId: string }[] = [];
    const fakeModel = (answer: Record<string, { verdict: string; confidence: number; note: string; evidence: string[] }>) => ({
      config: async () => fakeConfig,
      credential: async () => 'secret',
      llm: () => ({
        stream: () => ({
          textStream: (async function* () {
            yield `Sure. ${JSON.stringify({ checks: answer })}`;
          })(),
          usage: Promise.resolve({ promptTokens: 1_200, completionTokens: 300, cachedTokens: 0, reasoningTokens: 0 }),
        }),
      }),
      recordCost: async (input: { purpose?: string; libraryPublicId: string }) => {
        costs.push(input);
      },
      draw: () => 1,
    });
    const passing = Object.fromEntries(
      ['source_firsthand', 'structure', 'completeness', 'safety', 'score_threshold'].map((check) => [
        check,
        { verdict: 'pass', confidence: 0.92, note: `${check} fine`, evidence: ['d1'] },
      ]),
    );

    async function heldSubmission(slug: string): Promise<{ libraryId: string; operationId: string }> {
      const created = await createWorkspaceLibrary({
        workspaceId,
        role: 'owner',
        title: `Model ${slug}`,
        visibility: 'public',
        sourceType: 'website',
        location: `https://docs.example.test/${slug}`,
        domainVerificationId: await verifiedDomain(workspaceId, `https://docs.example.test/${slug}`),
        slug: `${slug}-${Date.now()}`,
        rights: { origin: 'own', license: 'open_source', generation: 'human' },
      });
      libraries.push(created.libraryId);
      /* Distinct content per library: the first one publishes, and a copy of it would be sent back as a duplicate. */
      await runOperation({
        operationId: created.operationId!,
        dependencies: dependencies(`# Model ${slug}\n\nA page about the model layer, written for ${slug} and nothing else.`),
      });
      for (let at = 1; at <= 5; at += 1) {
        await addOwnerEvalQuestion({ workspaceId, role: 'owner', libraryId: created.libraryId, question: `Q${at}?`, expectedText: 'nothing-in-this-library' });
      }
      const submitted = await applyOwnerLifecycleAction({ workspaceId, role: 'owner', libraryId: created.libraryId, action: 'submit' });
      expect(submitted.lifecycleStatus).toBe('submitted');
      expect(submitted.modelReviewOperationId).toBeTruthy();
      return { libraryId: created.libraryId, operationId: submitted.modelReviewOperationId! };
    }

    /* Confident passes publish, and the call is costed as a review. */
    const approved = await heldSubmission('model-pass');
    const published = await runModelReview({ operationId: approved.operationId, dependencies: fakeModel(passing) });
    expect(published).toEqual({ status: 'reviewed', decision: 'publish', lifecycleStatus: 'published' });
    expect(await lifecycleOf(approved.libraryId)).toBe('published');
    expect(costs).toHaveLength(1);
    expect(costs[0]?.purpose).toBe('review');
    const approvedDetail = await getUserLibrary(approved.libraryId);
    expect(approvedDetail?.reviews[0]?.stage).toBe('model');
    expect(approvedDetail?.reviews[0]?.outcome).toBe('approve');
    expect(approvedDetail?.reviews[0]?.checklist?.safety.verdict).toBe('pass');

    /* A confident failure sends back with the model's note; the owner appeals, and a person gets it untouched by the machines. */
    const returned = await heldSubmission('model-fail');
    const sentBack = await runModelReview({
      operationId: returned.operationId,
      dependencies: fakeModel({ ...passing, source_firsthand: { verdict: 'fail', confidence: 0.9, note: 'a mirror of vendor docs', evidence: ['d1'] } }),
    });
    expect(sentBack).toEqual({ status: 'reviewed', decision: 'send_back', lifecycleStatus: 'changes_requested' });
    const returnedDetail = await getUserLibrary(returned.libraryId);
    expect(returnedDetail?.reviews[0]?.feedback).toEqual(['rules:model_send_back', 'a mirror of vendor docs [d1]']);
    const rowsBefore = returnedDetail?.reviews.length ?? 0;

    const appealed = await applyOwnerLifecycleAction({ workspaceId, role: 'owner', libraryId: returned.libraryId, action: 'appeal' });
    expect(appealed.lifecycleStatus).toBe('submitted');
    expect(appealed.modelReviewOperationId).toBeFalsy();
    const afterAppeal = await getUserLibrary(returned.libraryId);
    expect(afterAppeal?.openAppeal).toBe(true);
    /* One row: the appeal itself. No rules row followed it. */
    expect(afterAppeal?.reviews.length).toBe(rowsBefore + 1);
    expect(afterAppeal?.reviews[0]?.stage).toBe('owner');
    expect(afterAppeal?.reviews[0]?.outcome).toBe('appeal');
    /* And only once. */
    expect(
      await refusalOf(applyOwnerLifecycleAction({ workspaceId, role: 'owner', libraryId: returned.libraryId, action: 'appeal' })),
    ).toBe('invalid_request');

    /* An item the model could not settle goes back to the owner too, named, and is appealable. No person waits. */
    const doubted = await heldSubmission('model-unsure');
    const unsure = await runModelReview({
      operationId: doubted.operationId,
      dependencies: fakeModel({ ...passing, completeness: { verdict: 'unsure', confidence: 0.9, note: 'tail of the handbook is cut', evidence: ['d1'] } }),
    });
    expect(unsure).toEqual({ status: 'reviewed', decision: 'unsure', lifecycleStatus: 'changes_requested' });
    const doubtedDetail = await getUserLibrary(doubted.libraryId);
    expect(doubtedDetail?.reviews[0]?.feedback).toEqual(['rules:model_low_confidence', 'tail of the handbook is cut [d1]']);
    expect(doubtedDetail?.reviews[0]?.checklist?.completeness.verdict).toBe('unsure');
    expect((await applyOwnerLifecycleAction({ workspaceId, role: 'owner', libraryId: doubted.libraryId, action: 'appeal' })).lifecycleStatus).toBe('submitted');

    /* No model: the operation waits in the queue, costing no attempt, and the library stays submitted with no row. */
    const waiting = await heldSubmission('model-missing');
    const deferred = await runModelReview({ operationId: waiting.operationId, dependencies: { ...fakeModel(passing), config: async () => null } });
    expect(deferred).toEqual({ status: 'deferred', reason: 'model_unavailable' });
    const [operation] = await db()
      .select({ status: schema.workflowOperation.status, attempts: schema.workflowOperation.attempts, error: schema.workflowOperation.error })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, waiting.operationId));
    expect(operation).toEqual({ status: 'pending', attempts: 0, error: 'model_unavailable' });
    expect(await lifecycleOf(waiting.libraryId)).toBe('submitted');
    expect((await getUserLibrary(waiting.libraryId))?.reviews.filter((review) => review.stage === 'model')).toHaveLength(0);
    /* Once a model is there, the same operation runs to a decision. */
    const later = await runModelReview({ operationId: waiting.operationId, dependencies: fakeModel(passing) });
    expect(later).toEqual({ status: 'reviewed', decision: 'publish', lifecycleStatus: 'published' });

    /* An answer nobody can read is retried, each try counted, and the last one sends the owner back with the reason alone. */
    const garbled = await heldSubmission('model-garbled');
    const garbage = { ...fakeModel(passing), llm: () => ({ stream: () => ({ textStream: (async function* () { yield 'no json here'; })(), usage: Promise.resolve({ promptTokens: 10, completionTokens: 2, cachedTokens: 0, reasoningTokens: 0 }) }) }) };
    expect(await runModelReview({ operationId: garbled.operationId, dependencies: garbage })).toEqual({ status: 'deferred', reason: 'model_no_answer' });
    const [retried] = await db()
      .select({ status: schema.workflowOperation.status, attempts: schema.workflowOperation.attempts })
      .from(schema.workflowOperation)
      .where(eq(schema.workflowOperation.id, garbled.operationId));
    expect(retried).toEqual({ status: 'pending', attempts: 1 });
    expect(await runModelReview({ operationId: garbled.operationId, dependencies: garbage })).toEqual({ status: 'deferred', reason: 'model_no_answer' });
    expect(await runModelReview({ operationId: garbled.operationId, dependencies: garbage })).toEqual({ status: 'reviewed', decision: 'send_back', lifecycleStatus: 'changes_requested' });
    const garbledDetail = await getUserLibrary(garbled.libraryId);
    expect(garbledDetail?.reviews[0]?.feedback).toEqual(['rules:model_no_answer']);
    expect(garbledDetail?.reviews[0]?.checklist).toBeNull();
  });

  it('requires a reason and refuses an unknown library', async () => {
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: libraries[0]!, action: 'reject', reason: '   ' }))).toBe(
      'reason_required',
    );
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: crypto.randomUUID(), action: 'approve', reason: 'x' }))).toBe(
      'not_found',
    );
    expect(await refusalOf(reviewUserLibrary({ actor, libraryId: 'junk', action: 'approve', reason: 'x' }))).toBe('not_found');
    expect(await getUserLibrary('junk')).toBeNull();
  });
});

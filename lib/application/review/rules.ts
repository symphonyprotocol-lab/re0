/**
 * The rules layer, applied: a public library that has just reached the
 * review queue is published, sent back, or held for a person, by the facts
 * the build and the owner already recorded. review-visibility-proposal.md
 * 6.1; the decision itself is `rulesVerdict` (lib/domain/auto-review.ts).
 *
 * Called wherever a library becomes `submitted`: after a build
 * (ingestion/advance-lifecycle.ts), on the owner's submit and resubmit, and
 * on a live private library going public (libraries/manage.ts). It reads
 * no content and calls no model. Each outcome writes a `library_review`
 * row under `RULES_REVIEW_STAGE` and an audit entry with no administrator
 * -- the rules decided, and the row says by which configuration.
 *
 * An auto-published library may be drawn for a later look: a `sample`
 * review row with no decision, which the console lists until a reviewer
 * closes it (administration/review-libraries.ts).
 */
import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { recordAudit } from '@/lib/application/administration/audit';
import { evaluateVersion } from '@/lib/application/ingestion/evaluate';
import { libraryMaterials } from '@/lib/application/libraries/materials';
import {
  drawnForSample,
  rulesNote,
  rulesVerdict,
  VERIFIED_SOURCE_TYPES,
  type RulesFacts,
  type RulesVerdict,
} from '@/lib/domain/auto-review';
import { sketchSimilarity } from '@/lib/domain/fingerprint';
import { uuidv7 } from '@/lib/domain/id';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { activeReviewRules } from './config';
import { queueModelReview } from './model';
import { RULES_REVIEW_STAGE, SAMPLE_REVIEW_STAGE } from './stages';

export { RULES_REVIEW_STAGE, SAMPLE_REVIEW_STAGE } from './stages';

const AUDIT_TARGET = 'user_library';

export interface RulesRun {
  verdict: RulesVerdict;
  /** Where the library is after the run. */
  lifecycleStatus: 'published' | 'changes_requested' | 'submitted';
  sampled: boolean;
  /** A held submission's model review, queued for whoever runs operations (review/model.ts). */
  modelReviewOperationId: string | null;
}

/**
 * Decide a submitted public user library. Null when the library is not
 * one, or is no longer `submitted` by the time the facts are read -- a
 * reviewer may have been faster, and their word stands.
 */
export async function runRulesLayer(libraryId: string, draw: () => number = Math.random): Promise<RulesRun | null> {
  const database = db();
  const [library] = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      visibility: schema.library.visibility,
      lifecycleStatus: schema.library.lifecycleStatus,
      isPlatformLibrary: schema.library.isPlatformLibrary,
      ownerWorkspaceId: schema.library.ownerWorkspaceId,
      currentVersionId: schema.library.currentVersionId,
    })
    .from(schema.library)
    .where(and(eq(schema.library.id, libraryId), isNull(schema.library.deletedAt)))
    .limit(1);
  if (!library || library.isPlatformLibrary || library.visibility !== 'public' || library.lifecycleStatus !== 'submitted') {
    return null;
  }

  const [gathered, rules] = await Promise.all([gatherFacts(library), activeReviewRules()]);
  const facts = await withFreshHitRate(library, gathered);
  const verdict = rulesVerdict(facts, rules);
  const now = new Date();
  const next = verdict.decision === 'publish' ? 'published' : verdict.decision === 'send_back' ? 'changes_requested' : 'submitted';
  const outcome = verdict.decision === 'publish' ? 'approve' : verdict.decision === 'send_back' ? 'request_changes' : 'hold';
  const sampled = verdict.decision === 'publish' && drawnForSample(rules, draw());

  const applied = await database.transaction(async (tx) => {
    if (next !== 'submitted') {
      const updated = await tx
        .update(schema.library)
        .set({ lifecycleStatus: next })
        .where(and(eq(schema.library.id, library.id), eq(schema.library.lifecycleStatus, 'submitted')))
        .returning({ id: schema.library.id });
      if (updated.length === 0) return false;
    }
    await tx.insert(schema.libraryReview).values({
      id: uuidv7(),
      libraryId: library.id,
      versionId: library.currentVersionId,
      stage: RULES_REVIEW_STAGE,
      outcome,
      /* The owner reads the feedback; a hold is the reviewer's business, so it says nothing to them. */
      feedback: verdict.decision === 'hold' ? [] : verdict.reasons.map(rulesNote),
      checklist: verdict.checklist,
      reviewerId: null,
      createdAt: now,
      decidedAt: now,
    });
    if (sampled) {
      await tx.insert(schema.libraryReview).values({
        id: uuidv7(),
        libraryId: library.id,
        versionId: library.currentVersionId,
        stage: SAMPLE_REVIEW_STAGE,
        outcome: null,
        feedback: [],
        reviewerId: null,
        createdAt: now,
        decidedAt: null,
      });
    }
    return true;
  });
  if (!applied) return null;

  await recordAudit({
    administratorId: null,
    action:
      verdict.decision === 'publish'
        ? 'user_library.auto_approve'
        : verdict.decision === 'send_back'
          ? 'user_library.auto_request_changes'
          : 'user_library.rules_hold',
    targetType: AUDIT_TARGET,
    targetId: library.id,
    beforeValue: { publicId: library.publicId, lifecycleStatus: 'submitted' },
    afterValue: {
      publicId: library.publicId,
      lifecycleStatus: next,
      reasons: verdict.reasons,
      configId: rules.configId,
      sampled,
      facts: {
        trustScore: facts.trustScore,
        benchmarkScore: facts.benchmarkScore,
        ownerHitRate: facts.ownerHitRate,
        duplicateSimilarity: facts.duplicateSimilarity,
        duplicateOf: facts.duplicateOf,
      },
    },
    result: 'success',
  });

  /* A hold is the model layer's to read next (review-visibility-proposal.md 6.2). */
  const modelReviewOperationId = verdict.decision === 'hold' ? await queueModelReview(library.id) : null;
  return { verdict, lifecycleStatus: next, sampled, modelReviewOperationId };
}

/* ------------------------------------------------------------------ facts */

async function gatherFacts(library: {
  id: string;
  ownerWorkspaceId: string | null;
  currentVersionId: string | null;
}): Promise<RulesFacts> {
  const database = db();
  const [version] = library.currentVersionId
    ? await database
        .select({
          indexStatus: schema.libraryVersion.indexStatus,
          totalChunks: schema.libraryVersion.totalChunks,
          sourceDigests: schema.libraryVersion.sourceDigests,
          contentSketch: schema.libraryVersion.contentSketch,
        })
        .from(schema.libraryVersion)
        .where(eq(schema.libraryVersion.id, library.currentVersionId))
        .limit(1)
    : [];

  const [[score], [source], materials, ownerHitRate, duplicate, [prior]] = await Promise.all([
    database
      .select({
        trustScore: schema.libraryScore.trustScore,
        benchmarkScore: schema.libraryScore.benchmarkScore,
        breakdown: schema.libraryScore.breakdown,
      })
      .from(schema.libraryScore)
      .where(eq(schema.libraryScore.libraryId, library.id))
      .orderBy(desc(schema.libraryScore.computedAt))
      .limit(1),
    database.select({ type: schema.source.type }).from(schema.source).where(eq(schema.source.libraryId, library.id)).limit(1),
    libraryMaterials(database, library.id),
    ownerHitRateOf(library.id, library.currentVersionId),
    nearestPublished(library, version?.contentSketch ?? null),
    library.ownerWorkspaceId
      ? database
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.library)
          .where(
            and(
              eq(schema.library.ownerWorkspaceId, library.ownerWorkspaceId),
              ne(schema.library.id, library.id),
              eq(schema.library.visibility, 'public'),
              eq(schema.library.lifecycleStatus, 'published'),
              eq(schema.library.isPlatformLibrary, false),
              isNull(schema.library.deletedAt),
            ),
          )
      : Promise.resolve([{ n: 0 }]),
  ]);

  const sourceType = source?.type ?? null;
  const hasLicense = Object.values(version?.sourceDigests ?? {}).some((record) => record.hasLicense);
  return {
    hasReadyVersion: version?.indexStatus === 'ready',
    chunks: version?.totalChunks ?? 0,
    quarantinedFiles: score?.breakdown.quarantinedFiles ?? 0,
    flaggedFiles: score?.breakdown.flaggedFiles ?? 0,
    trustScore: score?.trustScore ?? null,
    benchmarkScore: score?.benchmarkScore ?? null,
    sourceType,
    sourceVerified: sourceType !== null && (VERIFIED_SOURCE_TYPES as readonly string[]).includes(sourceType),
    hasLicense,
    rights: materials.rights,
    questions: materials.questions,
    ownerHitRate,
    duplicateSimilarity: duplicate.similarity,
    duplicateOf: duplicate.publicId,
    priorPublicLibraries: prior?.n ?? 0,
  };
}

/**
 * The owner's questions are usually written after the build that would
 * have asked them, so at submission their hit rate on this version is
 * unknown. Asking them now -- the same unmetered retrieval the build uses
 * (ingestion/evaluate.ts) -- is what lets a verified source publish on its
 * question set without waiting for a rebuild. A run that cannot complete
 * leaves the rate unknown, and the rules hold for a person as before.
 */
async function withFreshHitRate(
  library: { id: string; currentVersionId: string | null },
  facts: RulesFacts,
): Promise<RulesFacts> {
  if (facts.ownerHitRate !== null || facts.questions === 0 || !facts.hasReadyVersion || !library.currentVersionId) return facts;
  try {
    await evaluateVersion(db(), { libraryId: library.id, versionId: library.currentVersionId });
  } catch (error) {
    console.error(`evaluation at submission of ${library.id} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return facts;
  }
  return { ...facts, ownerHitRate: await ownerHitRateOf(library.id, library.currentVersionId) };
}

/** The share of the owner's questions the current version answered, 0-100; null until one was asked of it. */
async function ownerHitRateOf(libraryId: string, versionId: string | null): Promise<number | null> {
  if (!versionId) return null;
  const rows = await db()
    .select({ lastRank: schema.libraryEvalQuestion.lastRank })
    .from(schema.libraryEvalQuestion)
    .where(
      and(
        eq(schema.libraryEvalQuestion.libraryId, libraryId),
        eq(schema.libraryEvalQuestion.author, 'owner'),
        eq(schema.libraryEvalQuestion.lastVersionId, versionId),
      ),
    );
  if (rows.length === 0) return null;
  const hits = rows.filter((row) => row.lastRank !== null).length;
  return Math.round((hits / rows.length) * 100);
}

/** How many candidates the database hands back for the exact comparison. */
const DUPLICATE_CANDIDATES = 5;

/**
 * The published library this version most resembles, by sketch; nothing
 * when no sketch or no published library.
 *
 * Only what the public could already see is a duplicate's original: public
 * user libraries and platform libraries, and never the submitting
 * workspace's own (a private library of theirs made public is a move, not
 * a copy). The database does the heavy part -- counting shared hashes
 * across every candidate's sketch -- and only the few best candidates
 * come back for the exact estimate.
 */
async function nearestPublished(
  library: { id: string; ownerWorkspaceId: string | null },
  sketch: string[] | null,
): Promise<{ similarity: number; publicId: string | null }> {
  if (!sketch || sketch.length === 0) return { similarity: 0, publicId: null };
  const database = db();
  const candidates = await database
    .select({
      versionId: schema.libraryVersion.id,
      publicId: schema.library.publicId,
      shared: sql<number>`(
        select count(*)::int from jsonb_array_elements_text(${schema.libraryVersion.contentSketch}) h
        where h.value in (${sql.join(
          sketch.map((hash) => sql`${hash}`),
          sql`, `,
        )})
      )`,
    })
    .from(schema.library)
    .innerJoin(schema.libraryVersion, eq(schema.libraryVersion.id, schema.library.currentVersionId))
    .where(
      and(
        ne(schema.library.id, library.id),
        eq(schema.library.lifecycleStatus, 'published'),
        isNull(schema.library.deletedAt),
        or(eq(schema.library.visibility, 'public'), eq(schema.library.isPlatformLibrary, true)),
        library.ownerWorkspaceId
          ? or(isNull(schema.library.ownerWorkspaceId), ne(schema.library.ownerWorkspaceId, library.ownerWorkspaceId))
          : undefined,
        sql`${schema.libraryVersion.contentSketch} is not null`,
      ),
    )
    .orderBy(sql`3 desc`)
    .limit(DUPLICATE_CANDIDATES);
  const close = candidates.filter((candidate) => candidate.shared > 0);
  if (close.length === 0) return { similarity: 0, publicId: null };

  const versions = await database
    .select({ id: schema.libraryVersion.id, contentSketch: schema.libraryVersion.contentSketch })
    .from(schema.libraryVersion)
    .where(inArray(schema.libraryVersion.id, close.map((candidate) => candidate.versionId)));
  let best = { similarity: 0, publicId: null as string | null };
  for (const version of versions) {
    if (!version.contentSketch || version.contentSketch.length === 0) continue;
    const similarity = sketchSimilarity(sketch, version.contentSketch);
    if (similarity > best.similarity) {
      best = { similarity, publicId: close.find((candidate) => candidate.versionId === version.id)?.publicId ?? null };
    }
  }
  return best;
}

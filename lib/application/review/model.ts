/**
 * The model layer, applied: a submission the rules layer held is read by
 * a model, which fills the 7.4 checklist, and the rules read the filled
 * checklist. review-visibility-proposal.md 6.2; the prompt, the parser and
 * the decision are lib/domain/model-review.ts.
 *
 * Runs as a `workflow_operation` of type `model_review`, queued by the
 * rules layer and run by whoever runs operations (the drain, or a server
 * action's `after`), since a model call is seconds a request should not
 * wait on. The model is the subscriber-grade entry the console configured
 * (`llm_config`), with its credential.
 *
 * No person sits behind this layer (6.3, 2026-10-22): the owner's appeal
 * is the one way to one. So nothing here waits for a reviewer. No entry,
 * no credential or a provider failure leaves the operation pending for
 * the next drain, at no cost to the attempt count, until a model is there.
 * An answer the parser cannot read is tried `MODEL_REVIEW_LIMITS.attempts`
 * times and then sends the owner back, as an unsure checklist does, naming
 * what the model could not settle; both can be appealed once. Every
 * completed call appends one `llm_cost_event` with `purpose = 'review'`;
 * nothing of the material is logged.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '@/lib/application/administration/audit';
import {
  activeLlmConfig,
  openLlmCredential,
  recordLlmCost,
  type LlmConfigRow,
} from '@/lib/application/administration/manage-llm-config';
import { libraryMaterials } from '@/lib/application/libraries/materials';
import { drawnForSample, rulesNote } from '@/lib/domain/auto-review';
import { llmCostMicroUsd, openThinkFilter } from '@/lib/domain/generation';
import { uuidv7 } from '@/lib/domain/id';
import {
  buildModelReviewPrompt,
  MODEL_REVIEW_LIMITS,
  MODEL_REVIEW_SYSTEM_PROMPT,
  modelVerdict,
  parseModelReview,
  sampleIndexes,
  type ModelReviewDocument,
  type ModelVerdict,
} from '@/lib/domain/model-review';
import { REVIEW_CHECKS } from '@/lib/domain/review';
import { llmAdapter, type LlmAdapter } from '@/lib/infrastructure/ai/llm';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { activeReviewRules } from './config';
import { MODEL_REVIEW_OPERATION, MODEL_REVIEW_STAGE, SAMPLE_REVIEW_STAGE } from './stages';

export { MODEL_REVIEW_OPERATION, MODEL_REVIEW_STAGE } from './stages';

const AUDIT_TARGET = 'user_library';

export interface ModelReviewDependencies {
  /** The entry that reviews; the subscriber-grade assignment by default. */
  config: () => Promise<LlmConfigRow | null>;
  credential: (configId: string) => Promise<string | null>;
  llm: typeof llmAdapter;
  recordCost: typeof recordLlmCost;
  /** The sample draw, in [0, 1). */
  draw: () => number;
}

const defaultDependencies: ModelReviewDependencies = {
  config: () => activeLlmConfig(null, 'subscriber'),
  credential: openLlmCredential,
  llm: llmAdapter,
  recordCost: recordLlmCost,
  draw: Math.random,
};

/** Queue a model review of the library, unless one is already waiting. Returns the operation to run. */
export async function queueModelReview(libraryId: string): Promise<string> {
  const database = db();
  const [open] = await database
    .select({ id: schema.workflowOperation.id })
    .from(schema.workflowOperation)
    .where(
      and(
        eq(schema.workflowOperation.libraryId, libraryId),
        eq(schema.workflowOperation.operationType, MODEL_REVIEW_OPERATION),
        inArray(schema.workflowOperation.status, ['pending', 'running']),
      ),
    )
    .limit(1);
  if (open) return open.id;
  const operationId = uuidv7();
  await database.insert(schema.workflowOperation).values({
    id: operationId,
    libraryId,
    operationType: MODEL_REVIEW_OPERATION,
    sourceDigest: null,
    status: 'pending',
    trigger: 'review',
  });
  return operationId;
}

export type ModelReviewOutcome =
  | { status: 'reviewed'; decision: ModelVerdict['decision']; lifecycleStatus: 'published' | 'changes_requested' }
  /** Nothing decided: the operation goes back to pending for the next drain. */
  | { status: 'deferred'; reason: 'model_unavailable' | 'model_no_answer' }
  | { status: 'lost' }
  | { status: 'skipped' };

/**
 * Run one queued model review to completion. Claims the operation like
 * the build runner does, so a drain and an `after` that overlap do one
 * review between them. A deferral hands the claim back: the operation is
 * pending again with the reason as its error, and an unavailable model
 * does not use up an attempt, since nothing was asked.
 */
export async function runModelReview(input: {
  operationId: string;
  dependencies?: Partial<ModelReviewDependencies>;
}): Promise<ModelReviewOutcome> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const database = db();
  const [claimed] = await database
    .update(schema.workflowOperation)
    .set({ status: 'running', attempts: sql`${schema.workflowOperation.attempts} + 1`, error: null, updatedAt: new Date() })
    .where(and(eq(schema.workflowOperation.id, input.operationId), eq(schema.workflowOperation.status, 'pending')))
    .returning({ id: schema.workflowOperation.id, libraryId: schema.workflowOperation.libraryId, attempts: schema.workflowOperation.attempts });
  if (!claimed) return { status: 'lost' };
  const finish = (status: 'succeeded' | 'skipped' | 'failed', error: string | null = null) =>
    database.update(schema.workflowOperation).set({ status, error, updatedAt: new Date() }).where(eq(schema.workflowOperation.id, claimed.id));

  try {
    const outcome = claimed.libraryId ? await review(claimed.libraryId, claimed.attempts, dependencies) : { status: 'skipped' as const };
    if (outcome.status === 'deferred') {
      await database
        .update(schema.workflowOperation)
        .set({
          status: 'pending',
          error: outcome.reason,
          attempts: outcome.reason === 'model_unavailable' ? sql`${schema.workflowOperation.attempts} - 1` : claimed.attempts,
          updatedAt: new Date(),
        })
        .where(eq(schema.workflowOperation.id, claimed.id));
      return outcome;
    }
    await finish(outcome.status === 'skipped' ? 'skipped' : 'succeeded');
    return outcome;
  } catch (error) {
    await finish('failed', 'internal_error');
    throw error;
  }
}

async function review(libraryId: string, attempt: number, dependencies: ModelReviewDependencies): Promise<ModelReviewOutcome> {
  const database = db();
  const [library] = await database
    .select({
      id: schema.library.id,
      publicId: schema.library.publicId,
      ownerWorkspaceId: schema.library.ownerWorkspaceId,
      visibility: schema.library.visibility,
      lifecycleStatus: schema.library.lifecycleStatus,
      isPlatformLibrary: schema.library.isPlatformLibrary,
      currentVersionId: schema.library.currentVersionId,
    })
    .from(schema.library)
    .where(and(eq(schema.library.id, libraryId), isNull(schema.library.deletedAt)))
    .limit(1);
  /* Decided already -- by a person, or sent back again -- or not a review's business. */
  if (!library || library.isPlatformLibrary || library.visibility !== 'public' || library.lifecycleStatus !== 'submitted' || !library.currentVersionId) {
    return { status: 'skipped' };
  }

  const config = await dependencies.config();
  const apiKey = config ? await dependencies.credential(config.id) : null;
  if (!config || !apiKey) return { status: 'deferred', reason: 'model_unavailable' };

  /* A version with nothing readable cannot be judged; it is treated as an answer that never came. */
  const material = await gatherMaterial(library.id, library.currentVersionId);
  if (material.documents.length === 0) return noAnswer(library, attempt, config);

  const startedAt = Date.now();
  let text = '';
  let usage: { promptTokens: number; completionTokens: number; cachedTokens: number; reasoningTokens: number } | null = null;
  try {
    const stream = dependencies.llm({ baseUrl: config.baseUrl, model: config.model, apiKey }).stream({
      systemPrompt: MODEL_REVIEW_SYSTEM_PROMPT,
      userMessage: buildModelReviewPrompt(material),
      maxOutputTokens: MODEL_REVIEW_LIMITS.maxOutputTokens,
      timeoutMs: config.timeoutMs,
      reasoningEffort: config.reasoningEffort ? 'low' : null,
    });
    const think = openThinkFilter();
    for await (const delta of stream.textStream) {
      text += think.push(delta);
      if (text.length > MODEL_REVIEW_LIMITS.maxChars) break;
    }
    text += think.flush();
    usage = await stream.usage;
  } catch (error) {
    console.error(`model review of ${library.publicId} failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { status: 'deferred', reason: 'model_unavailable' };
  }

  await dependencies
    .recordCost({
      configId: config.id,
      libraryPublicId: library.publicId,
      workspaceId: library.ownerWorkspaceId,
      model: config.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cachedTokens: usage.cachedTokens,
      reasoningTokens: usage.reasoningTokens,
      costMicroUsd: llmCostMicroUsd({
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        cachedTokens: usage.cachedTokens,
        promptPriceMicro: config.promptPriceMicro,
        completionPriceMicro: config.completionPriceMicro,
        cachePriceMicro: config.cachePriceMicro,
      }),
      latencyMs: Date.now() - startedAt,
      purpose: 'review',
    })
    .catch((error) => {
      console.error(`llm cost event failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });

  const answer = parseModelReview(text, material.documents.map((document) => document.id));
  if (!answer) return noAnswer(library, attempt, config);
  return decide(library, config, modelVerdict(answer), dependencies);
}

type ReviewedLibrary = { id: string; publicId: string; currentVersionId: string | null };

/**
 * An answer the parser could not read. Tried again by a later drain while
 * attempts remain; after the last, the owner gets the submission back with
 * no checklist and the reason, and may appeal.
 */
async function noAnswer(library: ReviewedLibrary, attempt: number, config: LlmConfigRow): Promise<ModelReviewOutcome> {
  if (attempt < MODEL_REVIEW_LIMITS.attempts) return { status: 'deferred', reason: 'model_no_answer' };
  return apply(library, config, { next: 'changes_requested', feedback: [rulesNote('model_no_answer')], checklist: null, confidence: null, decision: 'send_back', sampled: false });
}

/** What the filled checklist means for the owner, in the words they read (lib/i18n `rulesReasons` and the model's own notes). */
async function decide(library: ReviewedLibrary, config: LlmConfigRow, verdict: ModelVerdict, dependencies: ModelReviewDependencies): Promise<ModelReviewOutcome> {
  const notesOf = (state: 'fail' | 'unsure') =>
    REVIEW_CHECKS.filter((check) => verdict.checklist[check].verdict === state).map((check) => verdict.checklist[check].note).filter(Boolean);
  const feedback =
    verdict.decision === 'publish'
      ? [rulesNote('model_approved')]
      : verdict.decision === 'send_back'
        ? [rulesNote('model_send_back'), ...notesOf('fail')]
        : [rulesNote('model_low_confidence'), ...notesOf('unsure')];
  const sampled = verdict.decision === 'publish' && drawnForSample(await activeReviewRules(), dependencies.draw());
  return apply(library, config, {
    next: verdict.decision === 'publish' ? 'published' : 'changes_requested',
    feedback,
    checklist: verdict.checklist,
    confidence: verdict.confidence,
    decision: verdict.decision,
    sampled,
  });
}

async function apply(
  library: ReviewedLibrary,
  config: LlmConfigRow,
  decision: {
    next: 'published' | 'changes_requested';
    feedback: string[];
    checklist: ModelVerdict['checklist'] | null;
    confidence: number | null;
    decision: ModelVerdict['decision'];
    sampled: boolean;
  },
): Promise<ModelReviewOutcome> {
  const database = db();
  const { next, sampled } = decision;
  const now = new Date();
  const applied = await database.transaction(async (tx) => {
    const updated = await tx
      .update(schema.library)
      .set({ lifecycleStatus: next })
      .where(and(eq(schema.library.id, library.id), eq(schema.library.lifecycleStatus, 'submitted')))
      .returning({ id: schema.library.id });
    if (updated.length === 0) return false;
    await tx.insert(schema.libraryReview).values({
      id: uuidv7(),
      libraryId: library.id,
      versionId: library.currentVersionId,
      stage: MODEL_REVIEW_STAGE,
      outcome: next === 'published' ? 'approve' : 'request_changes',
      feedback: decision.feedback,
      checklist: decision.checklist,
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
  if (!applied) return { status: 'skipped' };

  await recordAudit({
    administratorId: null,
    action: next === 'published' ? 'user_library.model_approve' : 'user_library.model_request_changes',
    targetType: AUDIT_TARGET,
    targetId: library.id,
    beforeValue: { publicId: library.publicId, lifecycleStatus: 'submitted' },
    afterValue: {
      publicId: library.publicId,
      lifecycleStatus: next,
      decision: decision.decision,
      configId: config.id,
      model: config.model,
      confidence: decision.confidence,
      sampled,
    },
    result: 'success',
  });
  return { status: 'reviewed', decision: decision.decision, lifecycleStatus: next };
}

/* --------------------------------------------------------------- material */

async function gatherMaterial(libraryId: string, versionId: string) {
  const database = db();
  const [documents, materials, [source]] = await Promise.all([
    database
      .select({ id: schema.document.id, title: schema.document.title, sourceUrl: schema.document.sourceUrl })
      .from(schema.document)
      .where(and(eq(schema.document.libraryId, libraryId), eq(schema.document.versionId, versionId)))
      .orderBy(asc(schema.document.sourceUrl), asc(schema.document.id)),
    libraryMaterials(database, libraryId),
    database.select({ type: schema.source.type }).from(schema.source).where(eq(schema.source.libraryId, libraryId)).limit(1),
  ]);
  const picked = sampleIndexes(documents.length).map((at) => documents[at]!);
  const chunks = picked.length
    ? await database
        .select({ documentId: schema.chunk.documentId, ordinal: schema.chunk.ordinal, body: schema.chunk.body })
        .from(schema.chunk)
        .where(inArray(schema.chunk.documentId, picked.map((document) => document.id)))
        .orderBy(asc(schema.chunk.documentId), asc(schema.chunk.ordinal))
    : [];
  const bodies = new Map<string, string>();
  for (const chunk of chunks) {
    const current = bodies.get(chunk.documentId) ?? '';
    if (current.length < MODEL_REVIEW_LIMITS.charsPerDocument) bodies.set(chunk.documentId, `${current}\n${chunk.body}`.trim());
  }
  /* Short ids: the model names evidence by them, and a uuid is noise to it. */
  const sampled: ModelReviewDocument[] = picked.map((document, at) => ({
    id: `d${at + 1}`,
    title: document.title,
    sourceUrl: document.sourceUrl,
    text: bodies.get(document.id) ?? '',
  }));
  const questions = await database
    .select({ question: schema.libraryEvalQuestion.question })
    .from(schema.libraryEvalQuestion)
    .where(eq(schema.libraryEvalQuestion.libraryId, libraryId))
    .orderBy(asc(schema.libraryEvalQuestion.createdAt))
    .limit(MODEL_REVIEW_LIMITS.questions);
  return {
    rights: materials.rights,
    sourceType: source?.type ?? null,
    questions: questions.map((row) => row.question),
    documents: sampled.filter((document) => document.text.length > 0),
  };
}

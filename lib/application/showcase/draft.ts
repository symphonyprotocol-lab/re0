/**
 * Drafting the top of a showcase page from the asset itself.
 *
 * Five retrievals -- one per probe question of the page's kind
 * (lib/domain/showcase.ts `SHOWCASE_DRAFT_PROBES`), each a Call as any
 * retrieval is -- gather the passages that describe the company or the
 * product; the configured model is then asked, once, for the page's fields
 * as JSON, with every field tied to the excerpt it came from. The rules of
 * the playground hold: the passages are untrusted data under a separate
 * system prompt, nothing is generated without them, and a model that fails
 * leaves the owner with the fields they already had rather than an error.
 *
 * The model answers as the workspace's plan buys (subscriber or trial), the
 * same entry that would answer a visitor's question, and its tokens land in
 * the same cost ledger.
 */
import { AppError } from '@/contracts/errors';
import {
  activeLlmConfig,
  activeRetrievalSettings,
  openLlmCredential,
  recordLlmCost,
} from '@/lib/application/administration';
import { canManageAssets, type WorkspaceRole } from '@/lib/application/assets/delete';
import { gatherAcrossAssets, type GatheredChunk, type GatherResult } from '@/lib/application/retrieval/gather';
import { defaultRetrievalDependencies } from '@/lib/application/retrieval/query-docs';
import type { CallerContext } from '@/lib/application/retrieval';
import { llmCostMicroUsd, type LlmAudience } from '@/lib/domain/generation';
import { retrievalBudgetFor } from '@/lib/domain/retrieval-config';
import {
  applyShowcaseDraft,
  buildShowcaseDraftPrompt,
  parseShowcaseDraft,
  parseStarterQuestions,
  readShowcaseDocument,
  SHOWCASE_DRAFT_PROBES,
  SHOWCASE_DRAFT_SYSTEM_PROMPT,
  SHOWCASE_LIMITS,
  showcaseFieldsFor,
  validateShowcaseContent,
  type ShowcaseDraftExcerpt,
  type ShowcaseField,
} from '@/lib/domain/showcase';
import { llmAdapter, type LlmStream } from '@/lib/infrastructure/ai/llm';
import { strictRateLimit } from '@/lib/infrastructure/cache/strict-rate-limit';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { isLocale } from '@/lib/i18n/locale';
import { assetShowcase, ShowcaseInvalid, type ShowcaseView } from './manage';

/** How many passages the model is shown, and how much of each. */
export const DRAFT_EXCERPTS = { max: 24, chars: 1_200 } as const;

/** A Free workspace may redraft a page this many times a day; Pro has no cap. */
export const DRAFT_FREE_DAILY_LIMIT = 5;

/** The idle clock for the one model call, within the entry's own. */
const DRAFT_TIMEOUT_MS = 20_000;

export type ShowcaseDraftOutcome = 'drafted' | 'no_context' | 'no_model' | 'model_failed';

export interface GenerateShowcaseDraftInput {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
  /** Rewrite hand-edited fields and the starter questions too; by default only generated fields are refreshed. */
  overwrite?: boolean;
  requestId: string;
}

export interface GenerateShowcaseDraftResult {
  outcome: ShowcaseDraftOutcome;
  showcase: ShowcaseView;
}

export async function generateShowcaseDraft(input: GenerateShowcaseDraftInput): Promise<GenerateShowcaseDraftResult> {
  if (!canManageAssets(input.role)) throw new AppError('access_denied', 'only an asset manager can draft a showcase page');
  const current = await assetShowcase({ workspaceId: input.workspaceId, assetId: input.assetId });
  if (!current) throw new AppError('library_not_found', 'this asset has no showcase page');
  if (current.status === 'taken_down') throw new ShowcaseInvalid('status');

  const [asset] = await db()
    .select({
      publicId: schema.asset.publicId,
      title: schema.asset.title,
      description: schema.asset.description,
      currentVersionId: schema.asset.currentVersionId,
      lifecycleStatus: schema.asset.lifecycleStatus,
    })
    .from(schema.asset)
    .where(and(eq(schema.asset.id, input.assetId), isNull(schema.asset.deletedAt)))
    .limit(1);
  if (!asset) throw new AppError('library_not_found', 'no such asset');
  if (!asset.currentVersionId) throw new AppError('library_not_ready', 'the asset has no indexed version yet');

  const paid = current.entitlement.paid;
  if (!paid) {
    const verdict = await strictRateLimit(`showcase:draft:${input.assetId}`, {
      limit: DRAFT_FREE_DAILY_LIMIT,
      windowSeconds: 86_400,
    });
    if (!verdict.allowed) throw new AppError('rate_limited', 'this page has been drafted enough for today');
  }

  const audience: LlmAudience = paid ? 'subscriber' : 'trial';
  const config = await activeLlmConfig(null, audience).catch(() => null);
  const usable = config && config.enabled && config.hasCredential ? config : null;

  const caller: CallerContext = {
    workspaceId: input.workspaceId,
    apiKeyId: null,
    requestId: input.requestId,
    anonymous: false,
    entrypoint: 'web',
  };
  const retrieval = defaultRetrievalDependencies();
  const settings = await (retrieval.settings ?? activeRetrievalSettings)();
  const maxTokens = retrievalBudgetFor(usable?.maxInputTokens, settings);
  const retrievalDependencies = { ...retrieval, settings: async () => settings };
  const locale = isLocale(current.locale) ? current.locale : 'en';
  const probes = SHOWCASE_DRAFT_PROBES[current.kind][locale];

  /*
   * Every probe is its own metered retrieval, and they run together. One
   * that is refused (the quota running out mid-way, a policy) does not
   * throw the others away: what was charged for is used, and the draft is
   * written from the probes that answered. Only when none did is the
   * refusal raised, so an owner is never charged for nothing.
   */
  const settled = await Promise.allSettled(
    probes.map((probe) =>
      gatherAcrossAssets(
        caller,
        { assets: [{ assetId: asset.publicId, title: asset.title }], query: probe, maxTokens },
        retrievalDependencies,
      ),
    ),
  );
  const gathered: GatherResult[] = [];
  for (const result of settled) if (result.status === 'fulfilled') gathered.push(result.value);
  if (gathered.length === 0) {
    const first = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw first?.reason ?? new AppError('internal_error', 'no retrieval ran');
  }

  const seen = new Set<string>();
  const chunks: GatheredChunk[] = [];
  for (const result of gathered) {
    for (const chunk of result.chunks) {
      if (seen.has(chunk.chunkId)) continue;
      seen.add(chunk.chunkId);
      chunks.push(chunk);
    }
  }
  if (chunks.length === 0) return { outcome: 'no_context', showcase: current };
  if (!usable) return { outcome: 'no_model', showcase: current };

  const excerpts: ShowcaseDraftExcerpt[] = chunks.slice(0, DRAFT_EXCERPTS.max).map((chunk, at) => ({
    id: String(at + 1),
    title: chunk.citation.documentTitle,
    url: chunk.citation.sourceUrl,
    text: chunk.text.slice(0, DRAFT_EXCERPTS.chars),
  }));

  const startedAt = Date.now();
  let text = '';
  let usage: LlmStream['usage'] | null = null;
  try {
    const apiKey = (await openLlmCredential(usable.id)) ?? '';
    const stream = llmAdapter({ baseUrl: usable.baseUrl, model: usable.model, apiKey }).stream({
      systemPrompt: SHOWCASE_DRAFT_SYSTEM_PROMPT,
      userMessage: buildShowcaseDraftPrompt({
        kind: current.kind,
        locale,
        assetTitle: asset.title,
        assetDescription: asset.description,
        excerpts,
      }),
      maxOutputTokens: Math.min(usable.maxOutputTokens, 4_000),
      timeoutMs: Math.min(usable.timeoutMs, DRAFT_TIMEOUT_MS),
      reasoningEffort: usable.reasoningEffort ? 'low' : null,
    });
    for await (const delta of stream.textStream) text += delta;
    usage = stream.usage;
  } catch (error) {
    console.warn(`showcase draft: model failed (${error instanceof Error ? error.message : 'unknown'})`);
    return { outcome: 'model_failed', showcase: current };
  }

  if (usage) {
    const counts = await usage;
    await recordLlmCost({
      configId: usable.id,
      assetPublicId: asset.publicId,
      workspaceId: input.workspaceId,
      model: usable.model,
      promptTokens: counts.promptTokens,
      completionTokens: counts.completionTokens,
      cachedTokens: counts.cachedTokens,
      reasoningTokens: counts.reasoningTokens,
      costMicroUsd: llmCostMicroUsd({
        promptTokens: counts.promptTokens,
        completionTokens: counts.completionTokens,
        cachedTokens: counts.cachedTokens,
        promptPriceMicro: usable.promptPriceMicro,
        completionPriceMicro: usable.completionPriceMicro,
        cachePriceMicro: usable.cachePriceMicro,
      }),
      latencyMs: Date.now() - startedAt,
    }).catch(() => {});
  }

  const draft = parseShowcaseDraft(text, { kind: current.kind, excerpts });
  if (!draft) return { outcome: 'model_failed', showcase: current };

  /* Hand-written fields stay unless the owner asked to overwrite them. */
  const shown = showcaseFieldsFor(current.kind);
  const fields: readonly ShowcaseField[] = input.overwrite
    ? shown
    : shown.filter((field) => current.document.origin[field] !== 'manual');
  const applied = applyShowcaseDraft(current.document, draft, fields);
  /* Stored in the form's own normalisation, so an untouched save later compares equal and stays `generated`. */
  const normalised = validateShowcaseContent(applied.content);
  const next = normalised.ok ? { ...applied, content: normalised.content } : applied;

  /* Starter questions: the owner's FAQ first, the draft's to fill up to the limit. */
  const faq = await db()
    .select({ question: schema.assetFaq.question })
    .from(schema.assetFaq)
    .where(eq(schema.assetFaq.assetId, input.assetId))
    .orderBy(asc(schema.assetFaq.createdAt), asc(schema.assetFaq.id))
    .limit(SHOWCASE_LIMITS.starterQuestions.count);
  const starter = parseStarterQuestions([
    ...faq.map((entry) => entry.question.slice(0, SHOWCASE_LIMITS.starterQuestions.chars)),
    ...draft.starterQuestions,
  ].slice(0, SHOWCASE_LIMITS.starterQuestions.count));
  const starterQuestions = starter.ok ? starter.questions : current.starterQuestions;

  const now = new Date();
  await db()
    .update(schema.assetShowcase)
    .set({
      content: { content: next.content, origin: next.origin, evidence: next.evidence },
      starterQuestions: current.starterQuestions.length > 0 && !input.overwrite ? current.starterQuestions : starterQuestions,
      generatedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.assetShowcase.id, current.id));

  const showcase = await assetShowcase({ workspaceId: input.workspaceId, assetId: input.assetId });
  return { outcome: 'drafted', showcase: showcase ?? current };
}

/**
 * Console management of the playground's models, and what they spend.
 * architecture.md 9.5, requirement.md 5.3 (high-risk actions take a reason
 * and land in the audit chain).
 *
 * An entry is identified by its `slug` and is immutable, like a Plan Version:
 * "edit" mints a successor row sharing the slug, the newest row of a slug is
 * that entry's configuration, and the unit prices frozen on each row keep
 * historical cost events meaning what they meant. The provider credential is
 * part of an entry and sealed at rest (15.3); it is opened only on the way to
 * the adapter, and never returned to anything that renders.
 *
 * The registry says what models exist. Which of them answers whom is a
 * separate, append-only assignment (`llm_audience_assignment`): one entry for
 * trial callers -- visitors and free workspaces -- and one a paid
 * subscription buys. Resolution for a caller reads both.
 */
import { desc, eq, gte, sql } from 'drizzle-orm';
import { normalizeReason } from '@/lib/domain/admin';
import {
  MAX_INPUT_TOKENS,
  MAX_OUTPUT_TOKENS,
  REASONING_EFFORTS,
  TIMEOUT_MS,
  type LlmAudience,
  type ReasoningEffort,
} from '@/lib/domain/generation';
import { uuidv7 } from '@/lib/domain/id';
import { API_KEY_MAX_LENGTH, mayCarryCredential } from '@/lib/domain/model-config';
import { openCredential, sealCredential } from '@/lib/infrastructure/crypto/credentials';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { recordAudit } from './audit';

export interface LlmConfigRow {
  id: string;
  slug: string;
  label: string;
  baseUrl: string;
  model: string;
  /** Whether a credential is stored. Never the key, which stays sealed. */
  hasCredential: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  promptPriceMicro: number;
  completionPriceMicro: number;
  cachePriceMicro: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  reasoningEffort: ReasoningEffort | null;
  enabled: boolean;
  createdAt: Date;
  /** Which audiences the assignment in force points at this entry. Derived, never stored. */
  assignedTo: LlmAudience[];
}

/** The assignment in force. Nulls carry the meanings documented on the table. */
export interface LlmAssignment {
  trialSlug: string | null;
  subscriberSlug: string | null;
  /** Null when nothing was ever assigned. */
  createdAt: Date | null;
}

export interface LlmUsageStats {
  monthCalls: number;
  monthPromptTokens: number;
  monthCompletionTokens: number;
  /** Of the prompt tokens, the share the provider served from cache. */
  monthCachedTokens: number;
  /** Of the completion tokens, the share spent thinking. */
  monthReasoningTokens: number;
  monthCostMicroUsd: number;
  totalCalls: number;
  totalCostMicroUsd: number;
}

export interface LlmConfiguration {
  /** The registry in force, newest entry first. */
  entries: LlmConfigRow[];
  assignment: LlmAssignment;
  /** What a request that names no model resolves to, for each audience. */
  resolved: Record<LlmAudience, LlmConfigRow | null>;
  history: Omit<LlmConfigRow, 'assignedTo'>[];
  stats: LlmUsageStats;
}

/** The newest assignment row, or the empty assignment. */
export async function readLlmAssignment(): Promise<LlmAssignment> {
  const [row] = await db()
    .select()
    .from(schema.llmAudienceAssignment)
    .orderBy(desc(schema.llmAudienceAssignment.createdAt))
    .limit(1);
  if (!row) return { trialSlug: null, subscriberSlug: null, createdAt: null };
  return { trialSlug: row.trialSlug, subscriberSlug: row.subscriberSlug, createdAt: row.createdAt };
}

/**
 * A stored row as the rest of the application may see it: the cipher is
 * replaced by whether there is one. Written as an explicit projection rather
 * than a spread, so a column added to the table later cannot reach a page by
 * accident -- which is exactly how a sealed credential would get rendered.
 */
function shown(
  row: typeof schema.llmConfig.$inferSelect,
  audiences: LlmAudience[],
): LlmConfigRow {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    baseUrl: row.baseUrl,
    model: row.model,
    hasCredential: Boolean(row.apiKeyCipher),
    maxInputTokens: row.maxInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    timeoutMs: row.timeoutMs,
    promptPriceMicro: row.promptPriceMicro,
    completionPriceMicro: row.completionPriceMicro,
    cachePriceMicro: row.cachePriceMicro,
    supportsTools: row.supportsTools,
    supportsReasoning: row.supportsReasoning,
    supportsVision: row.supportsVision,
    reasoningEffort: row.reasoningEffort,
    enabled: row.enabled,
    createdAt: row.createdAt,
    assignedTo: audiences,
  };
}

function assignedTo(slug: string, assignment: LlmAssignment): LlmAudience[] {
  const audiences: LlmAudience[] = [];
  if (assignment.trialSlug === slug) audiences.push('trial');
  if (assignment.subscriberSlug === slug) audiences.push('subscriber');
  return audiences;
}

/**
 * The configuration in force for every entry: the newest row of each slug,
 * marked with what the assignment in force points at it.
 *
 * Done as one `distinct on` rather than a query per slug -- the playground
 * resolves this on the request path, and the set is small but the history
 * behind it is not.
 */
export async function llmConfigEntries(): Promise<LlmConfigRow[]> {
  const [rows, assignment] = await Promise.all([
    db()
      .selectDistinctOn([schema.llmConfig.slug])
      .from(schema.llmConfig)
      .orderBy(schema.llmConfig.slug, desc(schema.llmConfig.createdAt)),
    readLlmAssignment(),
  ]);
  return rows.map((row) => shown(row, assignedTo(row.slug, assignment)));
}

/**
 * The entry a request that named no model gets, for one audience.
 *
 * Trial: the assigned entry, if it is still enabled; otherwise the newest
 * enabled entry, so a one-model installation and an installation whose
 * assigned model was switched off both keep answering. Subscriber: the
 * assigned entry, if enabled; otherwise whatever trial resolves to -- a paid
 * plan is never answered by nothing because the console has not named what
 * it buys.
 */
function resolveFor(entries: LlmConfigRow[], audience: LlmAudience): LlmConfigRow | null {
  const enabled = entries
    .filter((entry) => entry.enabled)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const assigned = enabled.find((entry) => entry.assignedTo.includes(audience)) ?? null;
  if (assigned) return assigned;
  if (audience === 'subscriber') return resolveFor(entries, 'trial');
  return enabled[0] ?? null;
}

/**
 * The entries an audience may use: in force, switched on, and -- for a trial
 * caller -- not the one a subscription buys. A paid plan buys more, never
 * less, so a subscriber may call anything a visitor can.
 */
function usableBy(entries: LlmConfigRow[], audience: LlmAudience): LlmConfigRow[] {
  return entries.filter(
    (entry) =>
      entry.enabled &&
      (audience === 'subscriber' ||
        !entry.assignedTo.includes('subscriber') ||
        entry.assignedTo.includes('trial')),
  );
}

/**
 * The entries a caller may pick from: in force, switched on, and open to its
 * audience. Ordered with that audience's resolution first and the rest
 * newest-first, which is the order a picker should offer them.
 */
export async function selectableLlmModels(audience: LlmAudience): Promise<LlmConfigRow[]> {
  const entries = await llmConfigEntries();
  const usable = usableBy(entries, audience);
  const first = resolveFor(entries, audience);
  return [
    ...usable.filter((entry) => entry.slug === first?.slug),
    ...usable
      .filter((entry) => entry.slug !== first?.slug)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  ];
}

/**
 * Resolve what the playground should call for a caller of this audience.
 *
 * A `slug` that is unknown, switched off, or closed to the audience resolves
 * to null rather than to the fallback: a caller naming a model it may not
 * use is a rejected request, not a silently substituted one -- and a visitor
 * naming the subscriber model is exactly the request this exists to refuse.
 */
export async function activeLlmConfig(
  slug: string | null | undefined,
  audience: LlmAudience,
): Promise<LlmConfigRow | null> {
  const entries = await llmConfigEntries();
  if (slug) return usableBy(entries, audience).find((entry) => entry.slug === slug) ?? null;
  return resolveFor(entries, audience);
}

export async function readLlmConfiguration(): Promise<LlmConfiguration> {
  const database = db();
  const rows = await database
    .select()
    .from(schema.llmConfig)
    .orderBy(desc(schema.llmConfig.createdAt))
    .limit(40);
  const history = rows.map((row) => {
    const { assignedTo: _unused, ...rest } = shown(row, []);
    return rest;
  });

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const aggregate = {
    calls: sql<number>`count(*)::int`,
    promptTokens: sql<number>`coalesce(sum(${schema.llmCostEvent.promptTokens}), 0)::int`,
    completionTokens: sql<number>`coalesce(sum(${schema.llmCostEvent.completionTokens}), 0)::int`,
    cachedTokens: sql<number>`coalesce(sum(${schema.llmCostEvent.cachedTokens}), 0)::int`,
    reasoningTokens: sql<number>`coalesce(sum(${schema.llmCostEvent.reasoningTokens}), 0)::int`,
    costMicroUsd: sql<number>`coalesce(sum(${schema.llmCostEvent.costMicroUsd}), 0)::bigint`,
  };
  const [month] = await database
    .select(aggregate)
    .from(schema.llmCostEvent)
    .where(gte(schema.llmCostEvent.createdAt, monthStart));
  const [total] = await database.select(aggregate).from(schema.llmCostEvent);

  const [entries, assignment] = await Promise.all([llmConfigEntries(), readLlmAssignment()]);

  return {
    entries: [...entries].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    assignment,
    resolved: {
      trial: resolveFor(entries, 'trial'),
      subscriber: resolveFor(entries, 'subscriber'),
    },
    history,
    stats: {
      monthCalls: month?.calls ?? 0,
      monthPromptTokens: month?.promptTokens ?? 0,
      monthCompletionTokens: month?.completionTokens ?? 0,
      monthCachedTokens: month?.cachedTokens ?? 0,
      monthReasoningTokens: month?.reasoningTokens ?? 0,
      monthCostMicroUsd: Number(month?.costMicroUsd ?? 0),
      totalCalls: total?.calls ?? 0,
      totalCostMicroUsd: Number(total?.costMicroUsd ?? 0),
    },
  };
}

export class LlmConfigRefused extends Error {
  constructor(
    readonly code:
      | 'invalid_base_url'
      | 'invalid_model'
      | 'invalid_max_input'
      | 'invalid_max_output'
      | 'invalid_timeout'
      | 'invalid_price'
      | 'invalid_slug'
      | 'invalid_effort'
      | 'invalid_api_key'
      | 'api_key_required'
      | 'unknown_model',
  ) {
    super(code);
    this.name = 'LlmConfigRefused';
  }
}

export interface UpdateLlmConfigInput {
  actor: { administratorId: string; email: string; clientAddress?: string | null };
  /** Omitted for a new entry; supplied to append to an existing one. */
  slug?: string | null;
  label: string;
  baseUrl: string;
  model: string;
  /**
   * Blank carries the entry's stored credential forward. An edit re-mints the
   * row, and making an operator re-type a provider key to change a price is
   * how keys end up somewhere they can be copied from.
   */
  apiKey?: string | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  promptPriceMicro: number;
  completionPriceMicro: number;
  cachePriceMicro: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
  /** Ignored unless `supportsReasoning`; sending both is refused, not coerced. */
  reasoningEffort: string | null;
  enabled: boolean;
  reason: string;
}

/** Slugs are typed into a URL-shaped identifier, so hold them to one. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function slugFromLabel(label: string): string {
  const derived = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return derived.length > 0 ? derived : `model-${uuidv7().slice(0, 8)}`;
}

export async function updateLlmConfig(input: UpdateLlmConfigInput): Promise<{ configId: string }> {
  const reason = normalizeReason(input.reason);

  let baseUrl: URL;
  try {
    baseUrl = new URL(input.baseUrl);
  } catch {
    throw new LlmConfigRefused('invalid_base_url');
  }
  if (baseUrl.protocol !== 'https:') throw new LlmConfigRefused('invalid_base_url');
  const model = input.model.trim();
  if (model.length === 0 || model.length > 120) throw new LlmConfigRefused('invalid_model');

  const label = input.label.trim().slice(0, 120) || model;
  const slug = input.slug?.trim() ? input.slug.trim() : slugFromLabel(label);
  if (!SLUG.test(slug)) throw new LlmConfigRefused('invalid_slug');

  /*
   * One refusal per field, not one for all six.
   *
   * They used to share `invalid_number`, which told an operator that something
   * among the budgets and the prices was wrong but not which -- and the
   * budgets are exactly where a plausible value gets refused, so the message
   * had to be guessed at. A limit worth enforcing is worth naming.
   */
  const wholeAndPositive = (value: number) => Number.isSafeInteger(value) && value >= 0;

  /* The floor is the retrieval budget's own minimum plus the prompt around it:
     below that there is no window left to put excerpts in. The ceiling is the
     largest context a current model offers. */
  if (
    !wholeAndPositive(input.maxInputTokens) ||
    input.maxInputTokens < MAX_INPUT_TOKENS.min ||
    input.maxInputTokens > MAX_INPUT_TOKENS.max
  ) {
    throw new LlmConfigRefused('invalid_max_input');
  }

  /*
   * Floor only. The old ceiling was 8,192, which every model released since
   * can exceed -- so an operator entering their model's real output budget was
   * refused for entering the truth, and any replacement ceiling would just be
   * the same refusal waiting for the next model.
   */
  if (!wholeAndPositive(input.maxOutputTokens) || input.maxOutputTokens < MAX_OUTPUT_TOKENS.min) {
    throw new LlmConfigRefused('invalid_max_output');
  }

  /*
   * Likewise 60s, which predates reasoning models: one at high effort can
   * think for longer than that before its first token. The hosting platform's
   * own function limit is the real ceiling; this one only has to stop being
   * lower than it.
   */
  if (
    !wholeAndPositive(input.timeoutMs) ||
    input.timeoutMs < TIMEOUT_MS.min ||
    input.timeoutMs > TIMEOUT_MS.max
  ) {
    throw new LlmConfigRefused('invalid_timeout');
  }

  if (
    ![input.promptPriceMicro, input.completionPriceMicro, input.cachePriceMicro].every(
      wholeAndPositive,
    )
  ) {
    throw new LlmConfigRefused('invalid_price');
  }

  /*
   * An effort on a model that does not reason would be ignored at call time,
   * leaving a row that describes a model which does not exist. Refused rather
   * than quietly dropped: this arrives through a server action, which is a
   * public endpoint, and silently discarding a field a caller set is how a
   * setting comes to look applied when it never was. The console cannot
   * produce the pair anyway -- its select is disabled, so it posts nothing.
   */
  const effort = input.reasoningEffort?.trim() ? input.reasoningEffort.trim() : null;
  if (effort !== null) {
    if (!input.supportsReasoning) throw new LlmConfigRefused('invalid_effort');
    if (!REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
      throw new LlmConfigRefused('invalid_effort');
    }
  }

  const [before] = await db()
    .select()
    .from(schema.llmConfig)
    .where(eq(schema.llmConfig.slug, slug))
    .orderBy(desc(schema.llmConfig.createdAt))
    .limit(1);

  const normalizedBaseUrl = baseUrl.toString().replace(/\/+$/, '');
  const typedKey = input.apiKey?.trim() ?? '';
  if (typedKey.length > API_KEY_MAX_LENGTH) throw new LlmConfigRefused('invalid_api_key');
  /* An entry with no credential is a model that cannot answer, shown on the
     page as enabled. Refused rather than saved, since there is nothing to
     carry forward on a new entry -- nor on one whose host changed, since a
     stored key only follows its own origin (`mayCarryCredential`). */
  const carried =
    before?.apiKeyCipher && mayCarryCredential(before.baseUrl, normalizedBaseUrl)
      ? before.apiKeyCipher
      : null;
  if (typedKey.length === 0 && !carried) throw new LlmConfigRefused('api_key_required');
  const apiKeyCipher = typedKey.length > 0 ? await sealCredential(typedKey) : carried;

  const written = {
    slug,
    label,
    baseUrl: normalizedBaseUrl,
    model,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    timeoutMs: input.timeoutMs,
    promptPriceMicro: input.promptPriceMicro,
    completionPriceMicro: input.completionPriceMicro,
    cachePriceMicro: input.cachePriceMicro,
    supportsTools: input.supportsTools,
    supportsReasoning: input.supportsReasoning,
    supportsVision: input.supportsVision,
    reasoningEffort: effort as ReasoningEffort | null,
    enabled: input.enabled,
  };

  const configId = uuidv7();
  await db().insert(schema.llmConfig).values({ id: configId, ...written, apiKeyCipher });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'llm_config.update',
    targetType: 'llm_config',
    targetId: configId,
    reason,
    beforeValue: before
      ? {
          slug: before.slug,
          label: before.label,
          baseUrl: before.baseUrl,
          model: before.model,
          hasCredential: Boolean(before.apiKeyCipher),
          maxInputTokens: before.maxInputTokens,
          maxOutputTokens: before.maxOutputTokens,
          timeoutMs: before.timeoutMs,
          promptPriceMicro: before.promptPriceMicro,
          completionPriceMicro: before.completionPriceMicro,
          cachePriceMicro: before.cachePriceMicro,
          supportsTools: before.supportsTools,
          supportsReasoning: before.supportsReasoning,
          supportsVision: before.supportsVision,
          reasoningEffort: before.reasoningEffort,
          enabled: before.enabled,
        }
      : null,
    /* The key itself never reaches the chain: the audit log is exported and
       anchored, and a secret in it cannot be un-leaked. That one was rotated
       is the part worth recording. */
    afterValue: { ...written, hasCredential: true, credentialRotated: typedKey.length > 0 },
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });

  return { configId };
}

/**
 * The credential of one entry, opened for the adapter.
 *
 * By id rather than by slug: the playground resolves an entry first and then
 * calls it, and reading the key off the very row it resolved is what stops a
 * concurrent edit from having the call made with one row's endpoint and
 * another's key. Null when the entry has no credential, or when the one it
 * has was sealed under a secret that has since been rotated.
 */
export async function openLlmCredential(configId: string): Promise<string | null> {
  const [row] = await db()
    .select({ apiKeyCipher: schema.llmConfig.apiKeyCipher })
    .from(schema.llmConfig)
    .where(eq(schema.llmConfig.id, configId))
    .limit(1);
  return openCredential(row?.apiKeyCipher);
}

export interface UpdateLlmAssignmentInput {
  actor: { administratorId: string; email: string; clientAddress?: string | null };
  /** Null: the newest enabled entry. */
  trialSlug: string | null;
  /** Null: the trial model. */
  subscriberSlug: string | null;
  reason: string;
}

/**
 * Point the two audiences at registry entries. Append-only, like the
 * registry: the newest row is in force, and the audit chain keeps the rest.
 * A slug must name an entry that exists and is switched on -- assigning a
 * model that cannot answer is a configuration that lies.
 */
export async function updateLlmAssignment(
  input: UpdateLlmAssignmentInput,
): Promise<{ assignmentId: string }> {
  const reason = normalizeReason(input.reason);
  const entries = await llmConfigEntries();
  const clean = (slug: string | null) => (slug?.trim() ? slug.trim() : null);
  const trialSlug = clean(input.trialSlug);
  const subscriberSlug = clean(input.subscriberSlug);
  for (const slug of [trialSlug, subscriberSlug]) {
    if (slug && !entries.some((entry) => entry.slug === slug && entry.enabled)) {
      throw new LlmConfigRefused('unknown_model');
    }
  }

  const before = await readLlmAssignment();
  const assignmentId = uuidv7();
  await db()
    .insert(schema.llmAudienceAssignment)
    .values({ id: assignmentId, trialSlug, subscriberSlug });

  await recordAudit({
    administratorId: input.actor.administratorId,
    action: 'llm_assignment.update',
    targetType: 'llm_audience_assignment',
    targetId: assignmentId,
    reason,
    beforeValue: before.createdAt
      ? { trialSlug: before.trialSlug, subscriberSlug: before.subscriberSlug }
      : null,
    afterValue: { trialSlug, subscriberSlug },
    clientAddress: input.actor.clientAddress,
    result: 'success',
  });

  return { assignmentId };
}

/** The playground's spend recorder -- append-only, never the text. */
export async function recordLlmCost(input: {
  configId: string;
  libraryPublicId: string;
  workspaceId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costMicroUsd: number;
  latencyMs: number | null;
}): Promise<void> {
  await db().insert(schema.llmCostEvent).values({ id: uuidv7(), ...input });
}

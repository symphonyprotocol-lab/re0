/**
 * The knobs of retrieval, and the spans they may be turned within.
 * architecture.md 9.2, 9.3, 9.5, 9.6.
 *
 * These were constants inside the two retrieval use cases. They are settings
 * now because turning them is an operator's job, not a deploy: how wide each
 * recall leg is, how much the reranker sees, how long a public result is
 * cached, and how much of a model's window the playground spends on excerpts
 * all trade quality against cost, and the right trade changes with the corpus
 * and the provider. What does not change is the span each may occupy -- a
 * recall width of zero is a retrieval that returns nothing, and one of ten
 * thousand is the full scan 9.3 forbids -- so the bounds live here, as domain
 * rules, and both the console form and the use case hold to the same ones.
 *
 * Pure TypeScript, no imports -- domain layer rules apply.
 */

export const RETRIEVAL_SETTING_KEYS = [
  'recallLimit',
  'rrfK',
  'rerankWindow',
  'rerankDocumentChars',
  'cacheTtlSeconds',
  'playgroundTokensDefault',
  'playgroundTokensMax',
  'routingRecallLimit',
  'routingRareSampleCap',
  'routingResultLimit',
  'playgroundAgent',
  'playgroundAgentSteps',
  'playgroundAgentQueries',
  'playgroundAgentResolves',
  'channelActivityBps',
  'channelFreshnessBps',
  'channelQualityBps',
  'channelHalfLifeDays',
] as const;

export type RetrievalSettingKey = (typeof RETRIEVAL_SETTING_KEYS)[number];

export type RetrievalSettings = Record<RetrievalSettingKey, number>;

export interface RetrievalSettingBounds {
  min: number;
  max: number;
  default: number;
}

/**
 * The floor and ceiling of the retrieval contract's own `maxTokens`
 * (contracts/schemas.ts): the playground's budgets are that value, so they
 * cannot leave its range.
 */
export const RETRIEVAL_TOKENS_MIN = 256;
export const RETRIEVAL_TOKENS_MAX_ALLOWED = 64_000;

/**
 * Every default but one is the constant the code used before this existed,
 * so an installation that never saves a configuration behaves as it did;
 * the playground cap is the exception, and says why.
 */
export const RETRIEVAL_SETTING_BOUNDS: Record<RetrievalSettingKey, RetrievalSettingBounds> = {
  /** Per-leg recall width in query-docs. §9.3: bounded, never a full scan. */
  recallLimit: { min: 5, max: 500, default: 50 },
  /** Reciprocal-rank-fusion constant; larger flattens the fused ranking. */
  rrfK: { min: 1, max: 1_000, default: 60 },
  /** How much of the fused head the reranker sees. Below 2 there is nothing to reorder. */
  rerankWindow: { min: 2, max: 200, default: 30 },
  /** Characters of each chunk handed to the reranker; the rest is cost. */
  rerankDocumentChars: { min: 200, max: 20_000, default: 1_500 },
  /** Public-library result cache. Zero switches the cache off. */
  cacheTtlSeconds: { min: 0, max: 7 * 24 * 3_600, default: 21_600 },
  /** The playground's excerpt budget when no model is configured. */
  playgroundTokensDefault: {
    min: RETRIEVAL_TOKENS_MIN,
    max: RETRIEVAL_TOKENS_MAX_ALLOWED,
    default: 4_000,
  },
  /**
   * The most the playground spends on excerpts, whatever the model's window.
   * Lowered from 16k: at that size a large-window model was handed some
   * eighty excerpts, most of them keyword noise, and the transcript listed
   * every one as a source. Six thousand tokens is roughly thirty excerpts --
   * the reranker's window -- so nothing past the reranked head is spent.
   */
  playgroundTokensMax: {
    min: RETRIEVAL_TOKENS_MIN,
    max: RETRIEVAL_TOKENS_MAX_ALLOWED,
    default: 6_000,
  },
  /** Per-path recall width in resolve-library-id. */
  routingRecallLimit: { min: 5, max: 200, default: 24 },
  /** Chunk rows the rare-term path may read; the whole cost model of 9.6. */
  routingRareSampleCap: { min: 50, max: 5_000, default: 400 },
  /** Candidates resolve-library-id returns. */
  routingResultLimit: { min: 1, max: 50, default: 10 },
  /**
   * 1 lets a model that declares tool calling plan the playground's searches
   * itself (playground/agent.ts); 0 keeps every exchange on the fixed
   * route-then-gather path. Off by default: the agent costs a few model
   * calls per question where the fixed path costs one.
   */
  playgroundAgent: { min: 0, max: 1, default: 0 },
  /** Model steps the planner may take, its closing `answer` call included. */
  playgroundAgentSteps: { min: 2, max: 6, default: 4 },
  /** `query_docs` calls one exchange may make: each is a read of one library. */
  playgroundAgentQueries: { min: 1, max: 6, default: 3 },
  /** `resolve_library_id` calls one exchange may make; 0 leaves the planner to the libraries the turns name. */
  playgroundAgentResolves: { min: 0, max: 4, default: 2 },
  /**
   * The channel directory's 热门 score (agent-first-proposal.md 6.4):
   * `activity * wa + freshness * wf + quality * wq`, weights in basis points.
   * Defaults are the proposal's 0.5 / 0.25 / 0.25; they need not sum to
   * 10,000 -- only their ratio orders the directory.
   */
  channelActivityBps: { min: 0, max: 10_000, default: 5_000 },
  channelFreshnessBps: { min: 0, max: 10_000, default: 2_500 },
  channelQualityBps: { min: 0, max: 10_000, default: 2_500 },
  /** Days for the freshness term to halve; the proposal's 14. */
  channelHalfLifeDays: { min: 1, max: 365, default: 14 },
};

export const DEFAULT_RETRIEVAL_SETTINGS: RetrievalSettings = Object.fromEntries(
  RETRIEVAL_SETTING_KEYS.map((key) => [key, RETRIEVAL_SETTING_BOUNDS[key].default]),
) as RetrievalSettings;

/**
 * Why a configuration was refused, naming the field.
 *
 * `out_of_range` is the field's own span; `inconsistent` is a rule between
 * two fields, reported on the one an operator would change.
 */
export class RetrievalConfigRefused extends Error {
  constructor(
    readonly field: RetrievalSettingKey,
    readonly code: 'out_of_range' | 'inconsistent',
  ) {
    super(`${code}: ${field}`);
    this.name = 'RetrievalConfigRefused';
  }
}

/**
 * A complete, legal configuration from operator input, or a refusal.
 *
 * Every key must be present: a partial save would silently fall back to a
 * default for the missing knob, which is how a setting comes to look applied
 * when it never was. Anything not a safe integer -- a blank field arrives as
 * NaN -- is out of range.
 */
export function validateRetrievalSettings(
  input: Partial<Record<RetrievalSettingKey, number>>,
): RetrievalSettings {
  const settings = {} as RetrievalSettings;
  for (const key of RETRIEVAL_SETTING_KEYS) {
    const value = input[key];
    const bounds = RETRIEVAL_SETTING_BOUNDS[key];
    if (
      value === undefined ||
      !Number.isSafeInteger(value) ||
      value < bounds.min ||
      value > bounds.max
    ) {
      throw new RetrievalConfigRefused(key, 'out_of_range');
    }
    settings[key] = value;
  }

  /* A default above the cap would be clamped on every request; refuse the
     pair instead of saving a number that never applies. */
  if (settings.playgroundTokensDefault > settings.playgroundTokensMax) {
    throw new RetrievalConfigRefused('playgroundTokensDefault', 'inconsistent');
  }
  /* Returning more candidates than any path recalled is asking for rows that
     were never fetched. */
  if (settings.routingResultLimit > settings.routingRecallLimit) {
    throw new RetrievalConfigRefused('routingResultLimit', 'inconsistent');
  }
  /* All three weights at zero would order the directory by nothing. */
  if (settings.channelActivityBps + settings.channelFreshnessBps + settings.channelQualityBps === 0) {
    throw new RetrievalConfigRefused('channelActivityBps', 'inconsistent');
  }
  return settings;
}

/**
 * How many tokens of a model's context window the playground may spend on
 * excerpts.
 *
 * The reserve covers everything in the prompt that is not an excerpt: the
 * system prompt, the question (the route caps it at 2000 characters) and the
 * `<excerpt>` framing around each chunk. Deliberately generous, because the
 * two errors are not symmetric -- overshooting the window costs the whole
 * request, undershooting costs one chunk.
 *
 * The cap is a lot lower than the contract's 64k. The window says what the
 * model *can* hold, not what one question needs, and with a 128k model the
 * derived budget was 64k -- so the prompt's size was whatever recall happened
 * to produce. The cap makes the budget the binding limit instead. The floor
 * keeps a window smaller than the reserve asking for a legal budget rather
 * than a negative one.
 */
const PROMPT_RESERVE_TOKENS = 1_200;

export function retrievalBudgetFor(
  maxInputTokens: number | undefined,
  settings: Pick<RetrievalSettings, 'playgroundTokensDefault' | 'playgroundTokensMax'>,
): number {
  if (maxInputTokens === undefined) return settings.playgroundTokensDefault;
  const room = maxInputTokens - PROMPT_RESERVE_TOKENS;
  return Math.min(Math.max(room, RETRIEVAL_TOKENS_MIN), settings.playgroundTokensMax);
}

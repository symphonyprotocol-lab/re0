/**
 * Every price, rate, limit and threshold of the product, in one place
 * (rebuild-proposal.md 8.3). Each block names the section it comes from;
 * changing a number here is changing the proposal.
 */

/* ------------------------------------------------------------ credits, 2.3 */

/** 1 credit = 0.0001 USD. */
export const CREDIT_USD = 0.0001;

/** Granted once, at sign-up. */
export const WELCOME_CREDITS = 2_000;

/**
 * The order credits are spent in; refunds walk it backwards. Only `welcome`
 * exists in step 1, but holds and the ledger are built for all four.
 */
export const GRANT_SPEND_ORDER = ['plan', 'welcome', 'pack', 'earned'] as const;
export type GrantSource = (typeof GRANT_SPEND_ORDER)[number];

/** Platform base fee per answered question, charged on your own Ree too. */
export const QUERY_BASE_FEE = 20;
/** The owner's query fee range (credits per answered question). */
export const QUERY_FEE = { min: 0, max: 10_000, default: 0 } as const;

/** Knowledge processing: 1 credit per started 1,000 extracted characters. */
export const KNOWLEDGE_CHARS_PER_CREDIT = 1_000;
/**
 * What processing reserves before it knows the real size (8.2, "知识处理费"):
 * documents and single pages hold a flat cap, pasted text holds its own
 * price. Settled to the real figure afterwards; more is released, a shortfall
 * is not charged.
 */
export const KNOWLEDGE_HOLD = {
  document: 20,
  page: 20,
  github: 120,
  site: 500,
} as const;

/* --------------------------------------------------------------- Ree, 8.2 */

export const REE_LIMITS = {
  name: 40,
  description: 240,
  systemPrompt: 4_000,
  tags: 3,
  tag: 20,
  sampleQuestions: 3,
  sampleQuestion: 160,
} as const;

export const REE_CATEGORIES = [
  'technology',
  'design',
  'business',
  'learning',
  'professional',
  'life',
  'other',
] as const;
export type ReeCategory = (typeof REE_CATEGORIES)[number];

export const REE_COLORS = ['default', 'lilac', 'sand', 'sage', 'rose', 'slate'] as const;
export type ReeColor = (typeof REE_COLORS)[number];

/** Avatars are cropped in the browser and stored at this size. */
export const AVATAR_SIZE = 512;
/** What the cropper accepts before cropping (prototype profile.js). */
export const AVATAR_SOURCE_MAX_BYTES = 5 * 1024 * 1024;

/* --------------------------------------------------------- knowledge, 2.1 */

export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_EXTENSIONS = ['pdf', 'docx', 'md', 'txt'] as const;
export const TEXT_SOURCE_LIMITS = { title: 100, content: 30_000 } as const;
export const KNOWLEDGE_TITLE_MAX = 200;

/* ---------------------------------------------------------- retrieval, 5 */

/** Passages handed to the model per answer. */
export const RETRIEVAL_TOP_K = 8;
/** Candidates each recall leg returns before fusion. */
export const RETRIEVAL_RECALL = 24;
/** Reciprocal-rank-fusion constant (from the old rank.ts). */
export const RETRIEVAL_RRF_K = 60;
/**
 * Below this cosine similarity the nearest passage is not evidence: the Ree
 * does not answer and nothing is charged.
 */
export const RETRIEVAL_MIN_SIMILARITY = 0.3;
/** Characters of a passage kept in a citation's snapshot. */
export const CITATION_EXCERPT_CHARS = 600;
/** Characters a question may have. */
export const QUESTION_MAX_CHARS = 4_000;
/** Earlier turns of this Ree sent along with a question. */
export const HISTORY_TURNS = 6;

/* ------------------------------------------------------------- lists, 8.1 */

export const LIST_PAGE_SIZES = [20, 50, 100] as const;
export const REE_PAGE_SIZES = [12, 24, 48] as const;
export const EXPLORE_PAGE_SIZES = [24, 48, 96] as const;

/* ------------------------------------------------------------ models, 2.5 */

export const MODEL_KINDS = ['generation', 'embedding', 'transcription'] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/** Width of every stored vector column. */
export const EMBEDDING_DIMENSIONS = 1536;
/** `modelFor(kind)` re-reads `model_config` at most this often. */
export const MODEL_CACHE_MS = 60_000;
export const MODEL_TIMEOUT_MS = { min: 1_000, max: 300_000, default: 60_000 } as const;
/**
 * Used only when neither the console nor the environment names a model, so a
 * first deployment answers through the AI Gateway out of the box.
 */
export const DEFAULT_MODELS: Record<ModelKind, string> = {
  generation: 'openai/gpt-5-mini',
  embedding: 'openai/text-embedding-3-small',
  transcription: 'openai/whisper-1',
};

/* ------------------------------------------------------------- admin, 2.5 */

export const ADMIN_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
export const ADMIN_MAX_FAILED_ATTEMPTS = 5;
export const ADMIN_LOCKOUT_MS = 15 * 60 * 1000;
export const ADMIN_PASSWORD_MIN = 12;

/* -------------------------------------------------------------- user auth */

export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const DISPLAY_NAME_MAX = 40;

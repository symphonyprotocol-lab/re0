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
 * The order credits are spent in; refunds walk it backwards (8.2, "扣费顺序").
 * `earned` arrives with step 4's query fees.
 */
export const GRANT_SPEND_ORDER = ['plan', 'welcome', 'pack', 'earned'] as const;
export type GrantSource = (typeof GRANT_SPEND_ORDER)[number];

/**
 * The Plan: a monthly Paddle subscription whose credits are good for the
 * billing period they arrive in and expire at its end. Cancelling keeps them
 * to the end of the period.
 */
export const PLAN = { priceMinor: 1_000, currency: 'USD', credits: 100_000, interval: 'month' } as const;
/**
 * A Pack: one-off, never expires, sold only to a user whose Plan is active,
 * 1 to 10 in one checkout (8.2, "Pack 数量").
 */
export const PACK = { priceMinor: 1_000, currency: 'USD', credits: 100_000, minQuantity: 1, maxQuantity: 10 } as const;
/** The sidebar's Plan meter turns red from this share of the period's credits used. */
export const PLAN_USAGE_WARN_PERCENT = 90;
/** The pricing page's estimator: successful answers on your own Ree (prototype `#/pricing`). */
export const ESTIMATOR = { min: 10, max: 1_000, step: 10, default: 100 } as const;
/**
 * How far a `Paddle-Signature` timestamp may sit from our clock. A replay is
 * stopped by the event-id check, not by this; it only makes a leaked signed
 * body go stale.
 */
export const PADDLE_SIGNATURE_TOLERANCE_SECONDS = 300;
/** A Plan checkout opened within this long is reopened rather than created again. */
export const CHECKOUT_REUSE_MS = 60 * 60 * 1000;
/** Plan grants the expiry cron settles per batch. */
export const PLAN_EXPIRY_BATCH = 200;

/** Platform base fee per answered question, charged on your own Ree too. */
export const QUERY_BASE_FEE = 20;
/** The owner's query fee range (credits per answered question). */
export const QUERY_FEE = { min: 0, max: 10_000, default: 0 } as const;

/** Knowledge processing: 1 credit per started 1,000 extracted characters. */
export const KNOWLEDGE_CHARS_PER_CREDIT = 1_000;
/**
 * What processing reserves before it knows the real size (8.2, "知识处理费"):
 * documents and single pages hold a flat cap, repositories and websites a
 * larger one, pasted text holds its own price, audio an estimate from its
 * size. Settled to the real figure afterwards; more is released, a shortfall
 * is not charged.
 */
export const KNOWLEDGE_HOLD = {
  document: 20,
  page: 20,
  github: 120,
  site: 500,
} as const;
/** Transcription, on top of the text price: per started minute of audio. */
export const AUDIO_CREDITS_PER_MINUTE = 100;
/** The hold's duration estimate: about a minute of audio per MB (8.2). */
export const AUDIO_MINUTES_PER_MB = 1;
/** And about this much transcript per minute, for the text part of the hold. */
export const AUDIO_CHARS_PER_MINUTE = 1_000;

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
export const AUDIO_MAX_BYTES = 100 * 1024 * 1024;
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav'] as const;
/**
 * The largest piece sent to the transcription endpoint in one call (OpenAI's
 * `audio/transcriptions` takes 25 MB); bigger MP3 and WAV files are cut into
 * pieces this size and the timestamps stitched back together.
 */
export const TRANSCRIPTION_PIECE_BYTES = 24 * 1024 * 1024;
export const TEXT_SOURCE_LIMITS = { title: 100, content: 30_000 } as const;
export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_URL_MAX = 2_048;
export const KNOWLEDGE_FOLDER_NAME_MAX = 40;
/** A website crawl stops at this many pages (2.1). */
export const SITE_MAX_PAGES = 500;
/** One fetched page, before conversion. */
export const PAGE_MAX_BYTES = 5 * 1024 * 1024;
/** A repository: files read per snapshot, the size of one file, and of all of them. */
export const GITHUB_LIMITS = { files: 1_000, fileBytes: 512 * 1024, totalBytes: 40 * 1024 * 1024 } as const;
/** Trashed knowledge is purged, passages and files with it, after this long (8.2). */
export const TRASH_RETENTION_DAYS = 30;
/** Rows one batch request may touch ("选择全部 N 个筛选结果" included). */
export const KNOWLEDGE_BATCH_MAX = 5_000;
/** The preview's page and file directory (prototype knowledge.js). */
export const PREVIEW_CHILDREN_PAGE_SIZE = 30;
/** Passages the preview's "检索片段" tab loads at once. */
export const PREVIEW_CHUNKS_MAX = 500;

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

/* ------------------------------------------- conversations and explore, 2.4, 5 */

/** Rees one conversation may hold (5). */
export const CONVERSATION_MAX_REES = 5;
/** A conversation title (8.2, "重命名 ≤ 120"). */
export const CONVERSATION_TITLE_MAX = 120;
/** A new conversation is named after its first question, cut to this. */
export const CONVERSATION_AUTO_TITLE = 80;
/** Trashed conversations are purged with their messages after this long (8.2). */
export const CONVERSATION_TRASH_DAYS = 30;
/** The `/chats` search page's "updated within" choices, in days. */
export const CONVERSATION_PERIODS = [7, 30, 90] as const;
/** Conversations one batch request may touch. */
export const CONVERSATION_BATCH_MAX = 1_000;
/** The sidebar's history: every pinned conversation, and this many of the most recent others. */
export const SIDEBAR_HISTORY_MAX = 200;
/** Days are grouped and "updated within" counted in UTC+8, as the rest of the product (prototype). */
export const LOCAL_UTC_OFFSET_HOURS = 8;
/** "这些公开 Ree 可能知道": public Rees suggested when every asked Ree had nothing. */
export const NO_ANSWER_SUGGESTIONS = 3;
/** Candidates the participant picker lists per search. */
export const PICKER_RESULTS = 30;

/** A knowledge profile (2.4): one introduction vector, the example questions, centroids for the rest. */
export const PROFILE_MAX_VECTORS = 16;
export const PROFILE_SAMPLE_QUESTIONS = 3;
/** Below this many passages the passages themselves stand in for centroids. */
export const PROFILE_CENTROIDS = PROFILE_MAX_VECTORS - 1 - PROFILE_SAMPLE_QUESTIONS;
/** Lloyd iterations of the in-database k-means, and the passages each one samples. */
export const PROFILE_KMEANS_ITERATIONS = 6;
export const PROFILE_KMEANS_SAMPLE = 5_000;

/** Explore's two levels (2.4): Rees from the profiles, then passages inside only those Rees. */
export const EXPLORE_PROFILE_REES = 20;
export const EXPLORE_PASSAGES = 50;
export const EXPLORE_RESULTS = 10;
/** HNSW candidate list for the profile search; the default 40 would cap the vectors returned. */
export const EXPLORE_EF_SEARCH = 400;
/** Characters of the matched passage on a result card. */
export const EXPLORE_EXCERPT_CHARS = 160;
/** Free searches per minute (2.4, "按 IP 和账号限频"). */
export const EXPLORE_RATE_LIMIT = { windowSeconds: 60, perIp: 30, perUser: 30 } as const;
/** Quality signals look back this far (2.4). */
export const QUALITY_WINDOW_DAYS = 30;
/**
 * The quality multiplier on relevance: a floor so relevance still decides,
 * plus answer rate, share of helpful votes and how often other people pull
 * the Ree into a conversation. Answer and vote rates are smoothed so a new
 * Ree starts near neutral rather than at the extremes.
 */
export const QUALITY_WEIGHTS = { floor: 0.6, answerRate: 0.2, upRate: 0.15, pulls: 0.05 } as const;
export const QUALITY_PRIORS = { answers: 3, votes: 2 } as const;
/** Pulls into conversations that saturate the pull signal. */
export const QUALITY_PULLS_FULL = 100;
/** A public page's "相关 Rees" keeps this many, and both of its lists page by four. */
export const PUBLIC_RELATED_MAX = 10;
export const PUBLIC_LIST_PAGE_SIZE = 4;
/** Candidates scored for "相关 Rees" (same category or a shared tag). */
export const PUBLIC_RELATED_CANDIDATES = 300;
/** Home page: public Rees shown as examples. */
export const HOME_EXAMPLE_REES = 3;

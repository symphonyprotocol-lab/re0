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

/* ------------------------------------------------------ roles, 2.7 (step 5) */

/**
 * The verification threshold (2.7, prototype user-role-domain.js): all five
 * must hold to apply. Code constants, not console settings.
 */
export const ROLE_REQUIREMENTS = {
  registeredDays: 14,
  publicRees: 1,
  readySources: 5,
  externalQuestions: 100,
  helpfulRate: 0.8,
} as const;
/** After a rejection the user waits this long to apply again. */
export const VERIFICATION_COOLDOWN_DAYS = 30;
export const VERIFICATION_STATEMENT_MAX = 500;
export const VERIFICATION_LINKS_MAX = 3;
export const VERIFICATION_LINK_MAX = 2_048;
/** Role changes and review notes (prototype role-pages.js: 1–500, visible to the user). */
export const ROLE_REASON_MAX = 500;

/* ------------------------------------------------- statistics, 8.2 (step 5) */

/** Reporting days run on UTC+8 and weeks start on Monday (prototype statistics-time.js). */
export const REPORT_UTC_OFFSET_HOURS = 8;
export const REPORT_TIME_ZONE = 'Asia/Shanghai';
export const RECENT_RANGES = [7, 30, 90] as const;
/** A custom range's trend is grouped so it never has more than this many bars. */
export const TREND_MAX_BARS = 31;

/* ----------------------------------------------------- console, 2.5 (step 5) */

/** Manual credit adjustments: Pack or Plan bucket, whole credits in this range. */
export const CREDIT_ADJUSTMENT = { min: 1, max: 10_000_000 } as const;
/** Reasons for credit adjustments and Ree takedowns / restores. */
export const ADMIN_REASON = { min: 3, max: 300 } as const;
/** A Ree's sources in the console's detail tab, per page. */
export const ADMIN_SOURCE_PAGE_SIZE = 20;
/** An administrator's enrolment link stays good this long. */
export const ADMIN_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Chunks one re-embed step embeds before it saves its progress. */
export const REEMBED_BATCH = 96;
/** A re-embed request works this long, then hands over to the next call or cron run. */
export const REEMBED_STEP_BUDGET_MS = 240_000;
/** Notices per page in the settings list. */
export const NOTICE_PAGE_SIZE = 20;
/**
 * Prices for the overview's estimated model cost (USD per million tokens, or
 * per minute for transcription). Operational estimates only: users pay fixed
 * credits (7). A model missing here shows its calls with the cost unknown.
 */
export const MODEL_PRICES: Record<string, { input?: number; output?: number; perMinute?: number }> = {
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'text-embedding-3-small': { input: 0.02 },
  'text-embedding-3-large': { input: 0.13 },
  'whisper-1': { perMinute: 0.006 },
  'gpt-4o-mini-transcribe': { perMinute: 0.003 },
  'gpt-4o-transcribe': { perMinute: 0.006 },
};
/** Earned credits needed before a payout can be requested (2.3: USD 50); the dashboard's payout guide reads it. */
export const PAYOUT_MIN_CREDITS = 500_000;

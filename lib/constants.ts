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
/** Prototype limits (suite.js model form) except the ceiling: 300 s is the Vercel function limit, not the prototype's 600. */
export const MODEL_TIMEOUT_MS = { min: 5_000, max: 300_000, default: 60_000 } as const;
export const MODEL_NAME_MAX_LENGTH = 50;
export const MODEL_ID_MAX_LENGTH = 120;
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

/* ------------------------------------------------------ payouts, 2.3 (step 6) */

/** Identity fields (8.4 step 6, prototype manual-kyc.js). */
export const KYC_LIMITS = { legalName: 100, country: 80, last4: 4 } as const;
export const KYC_DOCUMENT_KINDS = ['passport', 'id', 'residence'] as const;
/** W-8BEN for non-US persons, W-9 for US taxpayers. */
export const TAX_FORMS = ['W-8BEN', 'W-9'] as const;
/** The document photo and the selfie: JPG / PNG / WebP, each up to 10 MB, straight to private Blob. */
export const KYC_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const KYC_IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
/** An administrator's look at the images: signed links good for this long, each issue audited. */
export const KYC_FILE_URL_TTL_SECONDS = 60;
/** Originals are deleted this long after approval, rejection or a re-verification request; metadata stays. */
export const KYC_FILE_RETENTION_DAYS = 30;
/** Images uploaded but never submitted are removed after this long. */
export const KYC_ORPHAN_HOURS = 24;
/** Records and orphan blobs one purge run handles; the rest go next run. */
export const KYC_PURGE_BATCH = 200;
/** The PayPal personal account's e-mail. */
export const PAYPAL_EMAIL_MAX = 254;
/** After the e-mail changes, payouts wait this long (account-takeover protection, 2.3). */
export const PAYPAL_CHANGE_HOLD_DAYS = 7;
/** The PayPal transfer id an administrator records. */
export const PAYOUT_TRANSFER_ID_MAX = 100;

/* ------------------------------------------------------- video, 2.6 (step 7) */

/** A Ree's introduction: fixed 15 seconds at 24 fps, 720p (2.6 "规格与缓存"). Users cannot change the length. */
export const VIDEO_FPS = 24;
export const VIDEO_SECONDS = 15;
export const VIDEO_FRAMES = VIDEO_FPS * VIDEO_SECONDS;
/** The short side of either aspect: 1280×720 landscape, 720×1280 portrait. */
export const VIDEO_SHORT_SIDE = 720;
export const VIDEO_LONG_SIDE = 1280;
/** The four shots' lengths in seconds (opening, its knowledge, a real answer, the close); they add up to 15. */
export const VIDEO_SHOT_SECONDS = [3, 4, 5, 3] as const;
/** Each cut is a 0.4-second crossfade, inside the shots' lengths (10 frames at 24 fps). */
export const VIDEO_TRANSITION_FRAMES = 10;
/**
 * Text limits per shot, counted in characters (code points) for Chinese and
 * English alike. The generator rewrites anything longer; the editor refuses it.
 */
export const VIDEO_LIMITS = { name: 20, position: 24, sources: 4, source: 20, question: 30, answer: 50, cta: 16 } as const;
export const VIDEO_TEMPLATES = ['editorial', 'blueprint', 'spotlight'] as const;
export type VideoTemplate = (typeof VIDEO_TEMPLATES)[number];
export const VIDEO_ASPECTS = ['16:9', '9:16'] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];
export const VIDEO_DEFAULT_ACCENT = '#127ee3';
/** Generating or regenerating a script costs one question's worth (2.6 "收费"). */
export const VIDEO_SCRIPT_CREDITS = 20;
/** An MP4 export: each Ree's first is free, then this much; a cache hit is free and does not use up the free one. */
export const VIDEO_EXPORT_CREDITS = 50;
/** Times the generator is asked to rewrite fields over their limits before the script fails and is refunded. */
export const VIDEO_SCRIPT_REWRITES = 2;
/** An exported 15-second 720p MP4 is a few MB; the upload token allows up to this. */
export const VIDEO_EXPORT_MAX_BYTES = 60 * 1024 * 1024;
/** A started export older than this (the tab was closed) is released by `/api/cron/abandon-exports`. */
export const VIDEO_EXPORT_ABANDON_MINUTES = 30;
/** Videos per page on `/videos` (the My Rees sizes). */
export const VIDEO_PAGE_SIZES = [12, 24, 48] as const;
/**
 * Bumped whenever the composition in `video/` draws differently, so an
 * export cached under the old drawing is not handed out for the new one.
 */
export const VIDEO_COMPOSITION_VERSION = 1;

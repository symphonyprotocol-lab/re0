/**
 * Every price, rate, limit and threshold of the product, in one place
 * (rebuild-proposal.md 8.3). Each block names the section it comes from;
 * changing a number here is changing the proposal.
 */

/* ------------------------------------------------------------ credits, 2.3 */

/** 1 credit = 0.0001 USD. */
export const CREDIT_USD = 0.0001;

/** Default registration gift; /admin/pricing overrides it for future sign-ups. */
export const WELCOME_CREDITS = 100_000;

/**
 * The order credits are spent in; refunds walk it backwards (8.2, "扣费顺序").
 * `earned` arrives with step 4's query fees.
 */
export const GRANT_SPEND_ORDER = ['plan', 'welcome', 'pack', 'earned'] as const;
export type GrantSource = (typeof GRANT_SPEND_ORDER)[number];

/**
 * The grant sources that carry money someone paid (review H2). A query fee
 * is credited to the owner as withdrawable earned credits only for the part
 * the asker paid from these; the rest (welcome credits, redeemed codes,
 * console grants) still reaches the owner as earned credits they can spend
 * but never withdraw. Within a source, only grants that are themselves
 * paid count: a Plan or Pack grant bought through Paddle (it has a
 * purchase), an earned grant that is withdrawable.
 */
export const PAYING_GRANT_SOURCES = ['plan', 'pack', 'earned'] as const satisfies readonly GrantSource[];
/**
 * Days withdrawable earned credits wait before a payout may draw on them
 * (review H2): the window in which a refund or chargeback of what paid for
 * them usually arrives.
 */
export const EARNED_MATURITY_DAYS = 30;

/**
 * The Plan: a monthly Paddle subscription whose credits are good for the
 * billing period they arrive in and expire at its end. Cancelling keeps them
 * to the end of the period.
 */
export const PLAN = { priceMinor: 1_000, currency: 'USD', credits: 50_000, interval: 'month' } as const;
/**
 * A Pack: one-off, never expires, sold only to a user whose Plan is active,
 * 1 to 10 in one checkout (8.2, "Pack 数量").
 */
export const PACK = { priceMinor: 1_000, currency: 'USD', credits: 100_000, minQuantity: 1, maxQuantity: 10 } as const;
/**
 * Redeem codes (docs/design/redeem-codes.md). The alphabet leaves out
 * 0 O 1 I L U; 12 random characters are about 59 bits. A batch of one code
 * may carry an administrator's own text instead (a public campaign code).
 */
export const REDEEM = {
  alphabet: 'ABCDEFGHJKMNPQRSTVWXYZ23456789',
  randomLength: 12,
  groupLength: 4,
  maxCodes: 10_000,
  insertChunk: 500,
  defaultValidDays: 90,
  planMonths: { min: 1, max: 12 },
  packQuantity: { min: 1, max: 10 },
  prefix: { min: 2, max: 8 },
  custom: { min: 6, max: 32 },
  /** A typed code, normalised, outside this length is refused without a lookup. */
  input: { min: 6, max: 40 },
  name: 80,
  note: 500,
} as const;
/**
 * Failed guesses (`code_not_found`) a user and an IP may make per window
 * before redeeming answers 429 without a lookup. Windows stay within the
 * hour `clearRateBuckets` keeps.
 */
export const REDEEM_RATE_LIMIT = [
  { scope: 'user', windowSeconds: 900, limit: 5 },
  { scope: 'ip', windowSeconds: 900, limit: 20 },
  { scope: 'user', windowSeconds: 3_600, limit: 20 },
] as const;
/** Redeemed Plan months the hourly cron issues per run. */
export const REDEEM_PLAN_BATCH = 200;
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
/**
 * A reply that ends on the no-answer sentinel is no answer only while what
 * was shown before it is at most this many characters -- a short refusal.
 * Past that the reader has had an answer and it is settled as one (review H3).
 */
export const NO_ANSWER_REFUSAL_CHARS = 120;
/**
 * Upper bounds on one answer's model calls, so the stream and its check end
 * inside the route's 300-second `maxDuration` (review H5).
 */
export const ANSWER_STREAM_TIMEOUT_MAX_MS = 180_000;
export const ANSWER_CHECK_TIMEOUT_MAX_MS = 90_000;
/**
 * A chat hold still open after this long belongs to a stream that died (the
 * function was killed or redeployed); the reaper cron releases it.
 */
export const CHAT_HOLD_STALE_MS = 10 * 60 * 1000;
/** Chat holds the reaper releases per run. */
export const CHAT_HOLD_REAP_BATCH = 200;
/**
 * 回答核验: checking one Ree's answer against the passages it cited, per
 * answering Ree, all to the platform (ree-council-proposal.md 3.3). Held with
 * the question; given back when the Ree does not answer or the check fails.
 */
export const VERIFY_FEE = 10;
/** The rollout switch for answer checking; off, the toggle is gone and nothing is checked or held. */
export const VERIFY_ENABLED = true;
/** The longest reason a check gives for one sentence. */
export const VERIFY_REASON_CHARS = 80;
/** Sentences one check sends to the model at most; longer answers are checked from the start. */
export const VERIFY_MAX_SENTENCES = 40;
/**
 * Ree 圆桌: one synthesis of the answers several Rees gave to one question,
 * charged once, all to the platform -- the owners already earned their
 * query fees answering (ree-council-proposal.md 4.3).
 */
export const SYNTHESIS_FEE = 30;
/** The rollout switch for the synthesis and the explore entry that leads to it. */
export const SYNTHESIS_ENABLED = true;
/** Answers a synthesis needs at least. */
export const SYNTHESIS_MIN_ANSWERS = 2;
/** A synthesis still marked running after this long is taken to have died and may be started again. */
export const SYNTHESIS_STALE_MS = 10 * 60 * 1000;
/** "一起问前 3 个 Ree" on explore. */
export const ROUNDTABLE_REES = 3;
/** The owner's query fee range (credits per answered question). */
export const QUERY_FEE = { min: 0, max: 10_000, default: 0 } as const;

/** Refundable balance check for knowledge processing; actual supplier USD costs determine the bill. */
export const KNOWLEDGE_INITIAL_HOLD = 1;

/**
 * Our own infrastructure costs billed with knowledge (docs/audit/credit-import-audit.md,
 * P4), in USD. Editable in the console (价格与促销 → 基础设施成本, stored in
 * `infra_cost_rates`); these are the seeded defaults, used whenever nothing
 * is configured -- never 0. None is reported per call, so each is a
 * published list price rounded up to the dearest meter it can fall under.
 *
 *   - `blobStoragePerGbMonth`: Vercel Blob storage, $0.023 / GB-month
 *     (vercel.com/docs/vercel-blob/usage-and-pricing), plus $0.005 for the
 *     upload's advanced operation and list / head calls spread over the file.
 *   - `databaseStoragePerGbMonth`: Neon storage $0.35 + instant-restore history
 *     $0.20 / GB-month (neon.com/pricing).
 *   - `databaseIndexFactor`: stored database bytes are counted this many
 *     times over for indexes (the vector index the size of the vectors again).
 *   - `transferPerGb`: bytes our functions fetch or send while processing a
 *     source (web pages, GitHub files, the stored upload read back from Blob,
 *     the file sent to Firecrawl or the transcription endpoint). Vercel bills
 *     Blob data transfer $0.05 + Fast Origin Transfer $0.06 / GB on a cache
 *     miss and Fast Data Transfer from $0.15 / GB; the dearest, $0.15, applies
 *     to all of it -- no meter of ours is published for outbound fetches, so
 *     this is the conservative choice the audit calls out.
 *   - `chunkRowBytes`: per stored passage beyond its text and vector (row,
 *     locator, ids).
 */
export const DEFAULT_INFRA_COST_RATES = {
  transferPerGb: '0.15',
  blobStoragePerGbMonth: '0.028',
  databaseStoragePerGbMonth: '0.55',
  databaseIndexFactor: '2',
  chunkRowBytes: 200,
} as const;

/** The units the infrastructure rates are in; not configurable. */
export const INFRA_COST_UNITS = {
  /** Bytes per GB: decimal, the smaller unit, so more GBs are counted. */
  bytesPerGb: 1_000_000_000,
  /** Milliseconds in the shortest month (28 days): the per-second storage price is never below any month's. */
  monthMs: 28 * 24 * 60 * 60 * 1000,
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
export const REE_COVER_MAX_BYTES = 5 * 1024 * 1024;
export const REE_IMAGE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

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
/**
 * The longest piece, too: Whisper takes about 4.5 s per minute of audio and a
 * call is given 120 s, so ten minutes answers in under a minute. Without it a
 * 24 MB piece of 64 kbps audio (52 minutes) always ran out of time.
 */
export const TRANSCRIPTION_PIECE_SECONDS = 10 * 60;
/**
 * M4A cannot be cut without a demuxer, so it is one call: the endpoint's size
 * and a length that still answers inside the call's 120 s. Longer recordings
 * are asked for as MP3 or WAV.
 */
export const M4A_MAX_BYTES = TRANSCRIPTION_PIECE_BYTES;
export const M4A_MAX_SECONDS = 20 * 60;
/**
 * The longest audio source: eighteen ten-minute pieces, three rounds of six
 * calls of about 50 s, so transcription, embedding and storing finish inside
 * the function's 300 s. A 100 MB file at a low bitrate (32 kbps is seven
 * hours) would not.
 */
export const AUDIO_MAX_SECONDS = 3 * 60 * 60;
/**
 * A transcription call's time: at least 120 s, and twice what Whisper
 * usually takes for the audio (about 4.5 s a minute), so a twenty-minute M4A
 * gets 180 s rather than running close to the edge.
 */
export const TRANSCRIPTION_CALL_MIN_MS = 120_000;
export const TRANSCRIPTION_MS_PER_AUDIO_SECOND = 150;
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
/**
 * Questions about the sources themselves ("list every recording", "每份文档
 * 讲什么") get a generated overview of each source -- kind, length,
 * beginning and end -- on top of the passages: at most this many sources,
 * with this much of their beginning and end.
 */
export const RETRIEVAL_OVERVIEWS_MAX = 10;
export const OVERVIEW_HEAD_TOKENS = 120;
export const OVERVIEW_TAIL_TOKENS = 250;
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

export const OPENAI_SPEECH_BASE = 'https://api.openai.com/v1';
export const MODEL_KINDS = ['generation', 'embedding', 'transcription', 'speech'] as const;
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
  speech: 'openai/tts-1',
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
/**
 * Per-account request limits on the routes that cost us or move a public
 * signal (lib/http/rate-limit.ts): asking (an unanswered question is free but
 * still embeds and calls the model), new conversations (each one is a pull in
 * the explore ranking), comments, upload tokens (each up to 100 MB of Blob)
 * and domain checks (a DNS and an HTTPS request each). Every rule is a fixed
 * window within the hour `clearRateBuckets` keeps; a signed-out caller is
 * keyed by client address instead.
 */
export const USER_RATE_LIMITS = {
  ask: [{ windowSeconds: 60, limit: 20 }, { windowSeconds: 3_600, limit: 300 }],
  conversation: [{ windowSeconds: 60, limit: 10 }, { windowSeconds: 3_600, limit: 60 }],
  /* Adding a Ree to a conversation is a pull too. */
  participants: [{ windowSeconds: 60, limit: 30 }, { windowSeconds: 3_600, limit: 300 }],
  comment: [{ windowSeconds: 60, limit: 5 }, { windowSeconds: 3_600, limit: 30 }],
  uploadToken: [{ windowSeconds: 60, limit: 30 }, { windowSeconds: 3_600, limit: 200 }],
  domainVerify: [{ windowSeconds: 60, limit: 5 }, { windowSeconds: 3_600, limit: 30 }],
  /* `/api/explore` without a question; a question has its own EXPLORE_RATE_LIMIT. */
  browse: [{ windowSeconds: 60, limit: 120 }, { windowSeconds: 3_600, limit: 2_000 }],
} as const satisfies Record<string, readonly { windowSeconds: number; limit: number }[]>;
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
 * per minute for transcription). Operational overview estimates only; knowledge billing uses actual supplier costs
 * and versioned provider pricing instead of this legacy lookup. A model missing here shows its calls with the cost unknown.
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
/**
 * Uploads (knowledge files, avatars, Ree covers) never registered are
 * deleted this long after upload: every upload token expires within an hour,
 * so a file still unclaimed after a day never will be. Each daily run deletes
 * at most UPLOAD_REAP_BATCH and lists at most UPLOAD_REAP_SCAN per prefix.
 */
export const UPLOAD_ORPHAN_HOURS = 24;
export const UPLOAD_REAP_BATCH = 1_000;
export const UPLOAD_REAP_SCAN = 20_000;
/** The PayPal personal account's e-mail. */
export const PAYPAL_EMAIL_MAX = 254;
/** After the e-mail changes, payouts wait this long (account-takeover protection, 2.3). */
export const PAYPAL_CHANGE_HOLD_DAYS = 7;
/** The PayPal transfer id an administrator records. */
export const PAYOUT_TRANSFER_ID_MAX = 100;
/**
 * Where a payout's money came from (review H2): the signals the review page
 * and the queue show beside a request. Each is a flag for a second look,
 * never a refusal; shares are of the credits the payout draws on.
 * - `topPayerShare`: one asker paid at least this share.
 * - `freshPayerDays` / `freshPayerShare`: askers whose account was at most
 *   this many days old at their first question here paid at least this share.
 * - `exclusivePayerShare`: askers who own no Ree and asked no other owner's
 *   Rees paid at least this share.
 * - `sharedIdentityPayers`: at least this many askers share the owner's
 *   sign-in e-mail or PayPal e-mail (lower-cased, `+tag` dropped).
 * - `maxFeeShare`: at least this share of the questions paid the highest
 *   query fee an owner can set (`QUERY_FEE.max`).
 * - `refundedShare`: at least this share was paid from purchases later
 *   refunded or charged back (any amount at all is listed; this raises it).
 */
export const PAYOUT_REVIEW_SIGNALS = {
  topPayerShare: 0.5,
  freshPayerDays: 7,
  freshPayerShare: 0.3,
  exclusivePayerShare: 0.5,
  sharedIdentityPayers: 1,
  maxFeeShare: 0.5,
  refundedShare: 0,
} as const;
/** Askers per page on the payout review page. */
export const PAYOUT_PAYERS_PAGE_SIZE = 20;
/** Upcoming maturity dates listed on the payout review page. */
export const PAYOUT_MATURITY_DATES = 6;

/* ------------------------------------------------------- video, 2.6 (step 7) */

/** A Ree's introduction: fixed 15 seconds at 24 fps, 720p (2.6 "规格与缓存"). Users cannot change the length. */
export const VIDEO_FPS = 24;
export const VIDEO_SECONDS = 15;
export const VIDEO_FRAMES = VIDEO_FPS * VIDEO_SECONDS;
/** The short side of either aspect: 1280×720 landscape, 720×1280 portrait. */
export const VIDEO_SHORT_SIDE = 720;
export const VIDEO_LONG_SIDE = 1280;
/**
 * Limits of the script's poster text (the name, positioning, titles and
 * closing line cards and link previews show), counted in characters.
 */
export const VIDEO_LIMITS = { name: 20, position: 24, sources: 4, source: 20, question: 30, answer: 50, cta: 16 } as const;
/**
 * The narrated video types: each tells a different 15-second story from the
 * Ree's knowledge (a product demo, a manual's quick start, a course
 * introduction, an article summary) with an AI voiceover.
 */
export const VIDEO_TEMPLATES = ['product-demo', 'user-manual', 'course-intro', 'article-summary'] as const;
export type VideoTemplate = (typeof VIDEO_TEMPLATES)[number];
/** What an export row may name: the current types and the retired four-shot templates, kept for past exports. */
export const VIDEO_EXPORT_TEMPLATES = [...VIDEO_TEMPLATES, 'editorial', 'blueprint', 'spotlight'] as const;
export const VIDEO_ASPECTS = ['16:9', '9:16'] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];
export const VIDEO_DEFAULT_ACCENT = '#127ee3';
/** Default script price, covering observed development model costs with room for rewrites. */
export const DEFAULT_VIDEO_SCRIPT_CREDITS = 5;
/** An MP4 export: each Ree's first is free, then this much; a cache hit is free and does not use up the free one. */
export const DEFAULT_VIDEO_EXPORT_CREDITS = 50;
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

/* ------------------------------------------------------------------ MCP */

/** API keys for `/api/mcp`: `re0_sk_` and 64 hex characters. */
export const API_KEY_PREFIX = 're0_sk_';
export const API_KEY_NAME_MAX = 60;
/** Live (not revoked, not expired) keys per account. */
export const API_KEY_MAX_ACTIVE = 10;
/** The longest expiry a key can be given; no expiry is also allowed. */
export const API_KEY_MAX_DAYS = 365;
/** `last_used_at` is written at most this often per key. */
export const API_KEY_LAST_USED_RESOLUTION_MS = 60_000;
/** MCP tool calls per minute, per key and per account (every key of it together). */
export const MCP_RATE_LIMIT = { windowSeconds: 60, perKey: 30, perUser: 60 } as const;
/** `search_rees` returns at most this many Rees (explore's question search gives 10). */
export const MCP_SEARCH_MAX = 10;
/** Ready sources listed by title in `get_ree` for the caller's own Ree. */
export const MCP_SOURCE_TITLES = 30;

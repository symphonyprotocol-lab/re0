/**
 * The tables of rebuild-proposal.md 4 delivered so far: the 15 of step 1, the
 * 3 of step 2 (knowledge_folder, github_connection, domain_claim) and step 3's
 * purchase and subscription, with three of its own (billing_event, credit_debt, paddle_checkout). Enumerations are
 * text columns with check constraints, so a later step widens one with a
 * plain constraint swap instead of `ALTER TYPE`.
 *
 * Columns beyond 4 are marked; each is called out in the step-1 PR.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bit,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import type { ReeDraft } from '@/lib/domain/ree';
import type { SocialContact } from '@/lib/domain/account';
import type { CitationSnapshot, Locator } from '@/lib/domain/answer';
import type { SynthesisSource } from '@/lib/domain/synthesis';
import type { Allocation } from '@/lib/domain/credits';
import type { ProviderCharge, ProviderRate } from '@/lib/domain/provider-cost';
import type { CallPurpose, CallStatus, CostBasis } from '@/lib/domain/model-calls';
import type { KnowledgeActivity, KnowledgeChild } from '@/lib/domain/knowledge';
import type { RoleMetrics } from '@/lib/domain/roles';
import type { ReeRank } from '@/lib/domain/explore';
import { REE_COMMENT_MAX_LENGTH } from '@/lib/domain/ree-comment';
import { VISITOR_ASK_PER_DAY, VISITOR_ASK_PER_VISITOR } from '@/lib/domain/visitor-ask';
import { TASK_KINDS, type TaskKind } from '@/lib/domain/invites';
import { PAGE_KINDS, type PageKind } from '@/lib/domain/traffic';
import { CRAWLER_FAMILIES, type ChargeScope, type CrawlerFamily } from '@/lib/domain/crawler-traffic';
import {
  AI_ANSWER_STATES,
  ANSWER_HIDERS,
  ANSWER_STATES,
  FOLLOWUP_STATUSES,
  POST_ANSWER_STATES,
  POST_DETAIL_MAX,
  POST_SOURCES,
  POST_STATUSES,
  POST_TITLE_MAX,
  POST_VISIBILITIES,
  type AiAnswerReview,
  type AiAnswerState,
  type AnswerHider,
  type AnswerState,
  type FollowupStatus,
  type PostAnswerState,
  type PostSource,
  type PostStatus,
  type PostVisibility,
} from '@/lib/domain/post';
import { PUBLIC_QA_ANSWER_MAX_CHARS, PUBLIC_QA_HIDERS, PUBLIC_QA_SOURCES, PUBLIC_QA_STATUSES, type PublicQaHider, type PublicQaSource, type PublicQaStatus } from '@/lib/domain/public-qa';
import { CHAIN_AUDIENCES, COOLING_REASONS, type ChainAudience, type SwitchingClass } from '@/lib/domain/model-failover';
import { MODEL_KINDS, VIDEO_EXPORT_TEMPLATES, VIDEO_TEMPLATES, type ModelKind } from '@/lib/constants';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const timestampTz = (name: string) => timestamp(name, { withTimezone: true });

function oneOf(column: string, values: readonly string[]) {
  return sql.raw(`${column} in (${values.map((value) => `'${value}'`).join(', ')})`);
}

export const user = pgTable(
  'user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    website: text('website').notNull().default(''),
    socialContacts: jsonb('social_contacts').$type<SocialContact[]>().notNull().default([]),
    /** A Blob pathname once uploaded; the provider's avatar URL until then. */
    avatarBlob: text('avatar_blob'),
    lang: text('lang').$type<'zh' | 'en'>().notNull().default('zh'),
    provider: text('provider').$type<'google' | 'github'>().notNull(),
    /** Beyond 4: the provider's stable account id, which sign-in matches on. */
    providerSubject: text('provider_subject').notNull(),
    providerHandle: text('provider_handle'),
    lastLoginAt: timestampTz('last_login_at'),
    role: text('role').$type<'normal' | 'verified' | 'official'>().notNull().default('normal'),
    roleChangedAt: timestampTz('role_changed_at'),
    disabledAt: timestampTz('disabled_at'),
    paypalEmail: text('paypal_email'),
    paypalEmailChangedAt: timestampTz('paypal_email_changed_at'),
    reeDraft: jsonb('ree_draft').$type<ReeDraft>(),
    /** Unused: the dismissable task guide on `/rees` gave way to the permanent Activities page. Kept until a migration drops it. */
    taskGuideDismissedAt: timestampTz('task_guide_dismissed_at'),
    /** Beyond 4: this account's payout minimum, set by an administrator; null, the site-wide one (`payout_settings`). */
    payoutMinCredits: integer('payout_min_credits'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('user_provider_subject_key').on(t.provider, t.providerSubject),
    check('user_lang_check', oneOf('lang', ['zh', 'en'])),
    check('user_provider_check', oneOf('provider', ['google', 'github'])),
    check('user_role_check', oneOf('role', ['normal', 'verified', 'official'])),
    check('user_payout_min_check', sql`payout_min_credits is null or payout_min_credits between 1 and 100000000`),
  ],
);

/** `id` is the keyed digest of the cookie's token, never the token itself. */
export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: timestampTz('expires_at').notNull(),
  },
  (t) => [index('session_user_idx').on(t.userId)],
);

export const ree = pgTable(
  'ree',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => user.id),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    avatarBlob: text('avatar_blob'),
    coverBlob: text('cover_blob'),
    color: text('color').notNull().default('default'),
    category: text('category').notNull().default('other'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    systemPrompt: text('system_prompt').notNull().default(''),
    sampleQuestions: jsonb('sample_questions').$type<string[]>().notNull().default([]),
    isPublic: boolean('is_public').notNull().default(false),
    /** Publication is a separate owner action; new Rees start unpublished. */
    isPublished: boolean('is_published').notNull().default(false),
    queryFee: integer('query_fee').notNull().default(0),
    /** Taken down by an administrator (2.5): hidden from discovery and other people's conversations, and not republishable by its owner, until restored. */
    moderatedAt: timestampTz('moderated_at'),
    moderatedBy: uuid('moderated_by'),
    moderatedReason: text('moderated_reason'),
    /** Pinned by an administrator to the top of Discover's default order and the home page, lower first; null when not pinned. Only shown while the Ree is public. */
    pinOrder: integer('pin_order'),
    pinnedAt: timestampTz('pinned_at'),
    pinnedBy: uuid('pinned_by'),
    /** The explore ranking, materialised hourly by `/api/cron/rank` (4). */
    rank: jsonb('rank').$type<ReeRank>().notNull().default({}),
    /** Beyond 4: three example questions the system wrote after the first ready source, shown only once the owner adopts them (8.2). */
    suggestedQuestions: jsonb('suggested_questions').$type<string[]>().notNull().default([]),
    /** Beyond 4: the owner lets askers publish their questions and answers on the Ree page (问答). Off hides every published one; on shows them again. */
    publicQaEnabled: boolean('public_qa_enabled').notNull().default(true),
    /** Beyond 4 (v5): the owner's choice to answer public posts; null follows the default -- a free Ree answers, a paid one does not (P3). */
    answersPosts: boolean('answers_posts'),
    /**
     * Visitor asks on the share page (lib/domain/visitor-ask.ts): off by
     * default; on, signed-out visitors may ask it there, the owner paying
     * each answer's base fee. Questions per visitor a day, and the owner's
     * optional total a day.
     */
    visitorAsks: boolean('visitor_asks').notNull().default(false),
    visitorAsksPerVisitor: integer('visitor_asks_per_visitor').notNull().default(VISITOR_ASK_PER_VISITOR.default),
    visitorAsksPerDay: integer('visitor_asks_per_day'),
    deletedAt: timestampTz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ree_slug_key').on(t.slug),
    index('ree_public_idx').on(t.category, t.createdAt).where(sql`is_public and is_published and moderated_at is null and deleted_at is null`),
    index('ree_owner_idx').on(t.ownerId, t.createdAt),
    check(
      'ree_color_check',
      oneOf('color', ['default', 'lilac', 'sand', 'sage', 'rose', 'slate']),
    ),
    check(
      'ree_category_check',
      oneOf('category', ['technology', 'design', 'business', 'learning', 'professional', 'life', 'travel', 'literature', 'other']),
    ),
    check('ree_query_fee_check', sql`query_fee between 0 and 10000`),
    check('ree_tags_check', sql`cardinality(tags) <= 3`),
    /* A taken-down Ree is private until an administrator restores it, whoever writes the row (step 5). */
    check('ree_moderated_private_check', sql`moderated_at is null or not is_public`),
    check('ree_pin_order_check', sql`pin_order is null or pin_order between 1 and 999`),
    check('ree_published_public_check', sql`not is_published or (is_public and moderated_at is null and deleted_at is null)`),
    check('ree_visitor_asks_check', sql`visitor_asks_per_visitor between ${sql.raw(String(VISITOR_ASK_PER_VISITOR.min))} and ${sql.raw(String(VISITOR_ASK_PER_VISITOR.max))} and (visitor_asks_per_day is null or visitor_asks_per_day between ${sql.raw(String(VISITOR_ASK_PER_DAY.min))} and ${sql.raw(String(VISITOR_ASK_PER_DAY.max))})`),
  ],
);

export const reeFavorite = pgTable(
  'ree_favorite',
  {
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    reeId: uuid('ree_id').notNull().references(() => ree.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.reeId] }),
    index('ree_favorite_recent_idx').on(t.userId, t.createdAt.desc(), t.reeId.desc()),
    index('ree_favorite_ree_idx').on(t.reeId),
  ],
);

export const reeComment = pgTable(
  'ree_comment',
  {
    id: uuid('id').primaryKey(),
    reeId: uuid('ree_id').notNull().references(() => ree.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ree_comment_recent_idx').on(t.reeId, t.createdAt.desc(), t.id.desc()),
    index('ree_comment_user_idx').on(t.userId),
    check('ree_comment_content_check', sql`char_length(content) between 1 and ${sql.raw(String(REE_COMMENT_MAX_LENGTH))}`),
  ],
);

/** Folders group a Ree's knowledge (8.2); names are unique per Ree, ignoring case. */
export const knowledgeFolder = pgTable(
  'knowledge_folder',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reeId: uuid('ree_id')
      .notNull()
      .references(() => ree.id),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('knowledge_folder_name_key').on(t.reeId, sql`lower(${t.name})`),
    check('knowledge_folder_name_check', sql`char_length(name) between 1 and 40`),
  ],
);

export const knowledge = pgTable(
  'knowledge',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reeId: uuid('ree_id')
      .notNull()
      .references(() => ree.id),
    /** Null is "未分组"; deleting a folder sends its rows back there, trash included. */
    folderId: uuid('folder_id').references(() => knowledgeFolder.id, { onDelete: 'set null' }),
    kind: text('kind').$type<'document' | 'audio' | 'github' | 'page' | 'site' | 'text'>().notNull(),
    title: text('title').notNull(),
    originalTitle: text('original_title').notNull(),
    /** Blob pathname for an upload, the URL for a fetched source, null for text. */
    source: text('source'),
    fileName: text('file_name'),
    fileSize: bigint('file_size', { mode: 'number' }),
    status: text('status')
      .$type<'pending' | 'processing' | 'ready' | 'failed'>()
      .notNull()
      .default('pending'),
    error: text('error'),
    /** "参与回答": a paused source keeps its passages but is not searched. */
    enabled: boolean('enabled').notNull().default(true),
    content: text('content'),
    /** A website's pages, a repository's files, an audio file's transcript segments: slices of `content`. */
    children: jsonb('children').$type<KnowledgeChild[]>().notNull().default([]),
    activity: jsonb('activity').$type<KnowledgeActivity[]>().notNull().default([]),
    /** When the owner agreed to send this audio to the transcription service (2.1). */
    consentAt: timestampTz('consent_at'),
    /** In the trash since; purged with its passages 30 days later. */
    deletedAt: timestampTz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
    /** Storage is billed up to here (null: from `created_at`), see `lib/services/storage-billing.ts`. */
    storageBilledAt: timestampTz('storage_billed_at'),
  },
  (t) => [
    index('knowledge_ree_idx').on(t.reeId, t.updatedAt),
    index('knowledge_folder_idx').on(t.folderId),
    index('knowledge_trash_idx').on(t.deletedAt).where(sql`deleted_at is not null`),
    check('knowledge_kind_check', oneOf('kind', ['document', 'audio', 'github', 'page', 'site', 'text'])),
    check('knowledge_status_check', oneOf('status', ['pending', 'processing', 'ready', 'failed'])),
  ],
);

/**
 * Passages of a source being processed, embedded but not yet stored
 * (`lib/services/knowledge.ts`, "staging"). A run writes them slice by slice
 * as the embeddings come back; a run that is killed leaves them here, and the
 * next attempt embeds only what is missing -- a passage is reused when its
 * text and locator (`digest`) and the model entry that embedded it
 * (`config_id`, '' for the environment's model) are unchanged. The final
 * step copies them into `chunk` and clears them. Nothing reads them for
 * answers. No vector index: they are copied, never searched.
 */
export const knowledgeStage = pgTable(
  'knowledge_stage',
  {
    knowledgeId: uuid('knowledge_id')
      .notNull()
      .references(() => knowledge.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    digest: text('digest').notNull(),
    configId: text('config_id').notNull(),
    content: text('content').notNull(),
    locator: jsonb('locator').$type<Locator>().notNull().default({}),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.knowledgeId, t.ordinal] })],
);

/**
 * What a processing run read from its source -- the extracted sections,
 * passages built by the kind itself, the record lines and the fetched title
 * -- kept while the source is being processed. A resumed run reads it back
 * instead of fetching, downloading or transcribing again: it works from the
 * same revision as the staged passages, and nothing is paid for twice.
 * Cleared with the staged passages when the source becomes ready or fails.
 */
export const knowledgeExtract = pgTable('knowledge_extract', {
  knowledgeId: uuid('knowledge_id')
    .primaryKey()
    .references(() => knowledge.id, { onDelete: 'cascade' }),
  extracted: jsonb('extracted').notNull(),
  createdAt: createdAt(),
});

export const chunk = pgTable(
  'chunk',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    knowledgeId: uuid('knowledge_id')
      .notNull()
      .references(() => knowledge.id, { onDelete: 'cascade' }),
    /** Copied from the knowledge, so a search scopes by Ree without a join. */
    reeId: uuid('ree_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    content: text('content').notNull(),
    /*
     * Two vector slots, each tagged with the embedding space it belongs to
     * (lib/services/embedding-space.ts). Neither slot is "the current one":
     * retrieval reads whichever carries the space its question was embedded
     * in, so a model switch is a one-row flip of the active space and never
     * rewrites these (2.5, reembed.ts). A slot with no vector has no tag;
     * `embedding` without a tag is a vector stored before 0044, in the base space.
     */
    embedding: vector('embedding', { dimensions: 1536 }),
    embeddingSpace: uuid('embedding_space'),
    embeddingNext: vector('embedding_next', { dimensions: 1536 }),
    embeddingNextSpace: uuid('embedding_next_space'),
    locator: jsonb('locator').$type<Locator>().notNull().default({}),
  },
  (t) => [
    index('chunk_knowledge_idx').on(t.knowledgeId, t.ordinal),
    index('chunk_ree_idx').on(t.reeId),
    /*
     * Discover's passage indexes (binary copies, one per slot) are not
     * declared here: `db:deploy` builds them concurrently after its
     * transaction (lib/infra/search-indexes.ts), and drizzle-kit never
     * learns of them. The half-precision pair that was declared here is
     * retired: 0080 only takes it out of drizzle-kit's snapshot, and
     * `db:cutover -- drop-retired-indexes` drops it, concurrently, by hand.
     */
  ],
);

/**
 * A binary-quantized copy (`binary_quantize`, one bit per dimension, 192
 * bytes) of each chunk vector slot that holds a vector in some space:
 * `slot` 0 is `embedding` (untagged means the base space), 1 is
 * `embedding_next`. Written only by the trigger 0079 puts on `chunk`
 * (`chunk_bit_sync`), so every write of a slot, its space tag, its Ree or
 * its source keeps it current, and a slot set to null drops its row.
 *
 * Kept apart from `chunk`, whose 6 KB vectors live out of line (TOAST):
 * ranking one Ree's passages exactly reads one of those per passage, a
 * random read each on a cold cache (seconds for a Ree of a few thousand).
 * Here a Ree's rows sit some 30 to a page, so Discover ranks a named Ree
 * by bits that differ and reads the full vectors of only the nearest few
 * (explore.ts `nearestOwnPassage`). `knowledge_id` lets that ranking keep
 * to answerable sources before it cuts.
 *
 * Rows that existed before 0079 are filled by `db:cutover -- chunk-bits`
 * (lib/infra/chunk-bits.ts), which marks `chunk_bit_backfill` when no slot
 * is left without its row; until then Discover ranks the old way.
 */
export const chunkBit = pgTable(
  'chunk_bit',
  {
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunk.id, { onDelete: 'cascade' }),
    slot: smallint('slot').notNull(),
    space: uuid('space').notNull(),
    reeId: uuid('ree_id').notNull(),
    knowledgeId: uuid('knowledge_id').notNull(),
    bits: bit('bits', { dimensions: 1536 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chunkId, t.slot] }),
    index('chunk_bit_ree_idx').on(t.reeId, t.space),
    check('chunk_bit_slot_check', sql`${t.slot} in (0, 1)`),
  ],
);

/** One row: when `chunk_bit` last held a row for every chunk vector slot (lib/infra/chunk-bits.ts); null until the first backfill finishes. */
export const chunkBitBackfill = pgTable(
  'chunk_bit_backfill',
  {
    id: boolean('id').primaryKey().default(true),
    completedAt: timestampTz('completed_at'),
  },
  (t) => [check('chunk_bit_backfill_single', sql`${t.id}`)],
);

/**
 * 回答核验 tallies, one per completed check: what the owner's statistics
 * count. Kept apart from the reply, so the figures outlived the
 * conversations the checks were made in (dropped by migration 0069).
 */
export const answerCheck = pgTable(
  'answer_check',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reeId: uuid('ree_id')
      .notNull()
      .references(() => ree.id, { onDelete: 'cascade' }),
    cited: integer('cited').notNull().default(0),
    unsupported: integer('unsupported').notNull().default(0),
    partial: integer('partial').notNull().default(0),
    uncited: integer('uncited').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('answer_check_ree_idx').on(t.reeId, t.createdAt)],
);

export const creditGrant = pgTable(
  'credit_grant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    source: text('source').$type<'welcome' | 'plan' | 'pack' | 'earned'>().notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    remaining: bigint('remaining', { mode: 'number' }).notNull(),
    /** A Plan grant's period: it is spendable from `period_start` until `expires_at` (the period's end). */
    expiresAt: timestampTz('expires_at'),
    /** Beyond 4: when a Plan grant's period began. */
    periodStart: timestampTz('period_start'),
    /** Beyond 4: the purchase a Plan or Pack grant came from; one grant per purchase. */
    purchaseId: uuid('purchase_id').references(() => purchase.id),
    /** Beyond 4: the redemption a redeemed Pack or Plan period came from; `redemption_period` is the Plan month (0 for a Pack). */
    redemptionId: uuid('redemption_id').references((): AnyPgColumn => redeemRedemption.id),
    redemptionPeriod: integer('redemption_period'),
    /**
     * An earned grant's payout date: from then on a payout may draw on it.
     * Null on an earned grant paid for from free credits -- spendable, never
     * withdrawable (review H2). Always null on other sources.
     */
    withdrawableAt: timestampTz('withdrawable_at'),
    /**
     * An earned grant's paying purchase: the asker's Plan or Pack the fee was
     * paid from. A refund or chargeback of it voids what of this grant has
     * not matured yet (review H2). Null when free or untraceable.
     */
    fundingPurchaseId: uuid('funding_purchase_id').references(() => purchase.id),
    /**
     * An earned grant that originates from a withdrawable invitation reward:
     * the reward itself, or earnings from query fees paid out of such credits
     * (carried through every hop by `paidShare`). Read by the payout funding
     * review only; it changes nothing about when the grant is withdrawable.
     */
    inviteFunded: boolean('invite_funded').notNull().default(false),
    /**
     * A Pack grant converted from earned credits that a payout could have
     * drawn on (paid for by askers): it counts as paid, like a bought Pack,
     * so the query fees it pays reach owners as withdrawable earnings. It
     * keeps the earned credits' `funding_purchase_id` and `invite_funded`,
     * so the payout funding review still traces them.
     */
    convertedPaid: boolean('converted_paid').notNull().default(false),
    /** Any Pack grant converted from earned credits, paid for or not (the payout funding review tells free conversions from console grants). */
    converted: boolean('converted').notNull().default(false),
    /**
     * A converted Pack from earnings still in their maturity period: until
     * then a refund of `funding_purchase_id` may void it, as it would have
     * voided the earnings (review S2). Null once matured or never voidable.
     */
    voidUntil: timestampTz('void_until'),
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_grant_user_idx').on(t.userId),
    check('credit_grant_converted_check', sql`(not converted or source = 'pack') and (not converted_paid or converted) and (void_until is null or converted_paid)`),
    check('credit_grant_withdrawable_check', sql`withdrawable_at is null or source = 'earned'`),
    check('credit_grant_invite_funded_check', sql`not invite_funded or (source = 'earned' and withdrawable_at is not null) or (source = 'pack' and converted_paid)`),
    index('credit_grant_funding_idx').on(t.fundingPurchaseId).where(sql`funding_purchase_id is not null`),
    uniqueIndex('credit_grant_purchase_key').on(t.purchaseId).where(sql`purchase_id is not null`),
    uniqueIndex('credit_grant_redemption_key').on(t.redemptionId, t.redemptionPeriod).where(sql`redemption_id is not null`),
    check('credit_grant_origin_check', sql`purchase_id is null or redemption_id is null`),
    check('credit_grant_redemption_check', sql`(redemption_id is null) = (redemption_period is null)`),
    index('credit_grant_expiry_idx').on(t.expiresAt).where(sql`source = 'plan' and remaining > 0`),
    check('credit_grant_source_check', oneOf('source', ['welcome', 'plan', 'pack', 'earned'])),
    check('credit_grant_remaining_check', sql`remaining >= 0 and remaining <= amount`),
    check('credit_grant_plan_check', sql`(source = 'plan') = (expires_at is not null)`),
  ],
);

export const CREDIT_ENTRY_REASONS = [
  'welcome',
  'knowledge_hold',
  'knowledge_settle',
  'knowledge_refund',
  'query_hold',
  'query_base',
  'query_refund',
  'query_fee_paid',
  'query_fee_earned',
  'purchase',
  'refund',
  'chargeback',
  'debt_offset',
  'expire',
  'payout_hold',
  'payout_release',
  'payout_paid',
  'video_script',
  'video_export',
  'admin_adjust',
  /* Step 7: a video hold given back (a script that failed, an export cancelled or abandoned). */
  'video_refund',
  /* 回答核验: the per-Ree check fee, held with the question, all to the platform. */
  'verify_hold',
  'verify_settle',
  'verify_refund',
  /* Ree 圆桌: one synthesis of a question's answers, to the platform. */
  'synthesis_hold',
  'synthesis_settle',
  'synthesis_refund',
  /* Knowledge storage (Blob files, text, passages and vectors), billed daily: docs/audit/credit-import-audit.md P4. */
  'storage_charge',
  /* A redeem code: a Pack's credits, or one month of a redeemed Plan (docs/design/redeem-codes.md). */
  'redeem',
  /* A chargeback the merchant won: what it took back is restored (debt cancelled first, then the purchase's grant). */
  'chargeback_reverse',
  /* A Ree owner's unmatured earned credits voided because the purchase that paid for them was refunded or charged back. */
  'earned_void',
  /* What an `earned_void` took is given back as the asker pays off (or a won chargeback cancels) the debt it was voided for. */
  'earned_restore',
  /* An invited user registered: withdrawable earned credits to the inviter, within the site-wide quota (docs/design/invitations.md). */
  'invite_reward',
  /* The same, past the quota: gift credits in the welcome bucket, never withdrawable. */
  'invite_reward_gift',
  /* New-user tasks, once per account: gift credits in the welcome bucket, never withdrawable. */
  'task_first_ree',
  'task_first_question',
  'task_first_comment',
  /* v5's starter tasks in place of the two above (kept for history): a first post, a first 有帮助. */
  'task_first_post',
  'task_first_helpful',
  /* A daily check-in in the account's first months: gift credits, never withdrawable. */
  'check_in',
  /* v5: a public post past the day's free ones, held when published, to the platform once a Ree answers, given back otherwise. */
  'post_hold',
  'post_settle',
  'post_refund',
  /* AI 通用回答: the base fee for the general answer an asker gets when no Ree answered, to the platform once written, given back otherwise. */
  'ai_answer_hold',
  'ai_answer_settle',
  'ai_answer_refund',
  /* Earned credits turned into Pack credits at the console's rate: the earned side, then the Pack grant it became. */
  'earned_convert',
  'earned_converted',
  /* Earned credits paying part or all of a Plan or Pack: held with the checkout, paid once the purchase is credited, released if it never is. */
  'deduction_hold',
  'deduction_paid',
  'deduction_release',
  /* A refund or chargeback of such a purchase gives the earned credits back in proportion. */
  'deduction_return',
] as const;
export type CreditEntryReason = (typeof CREDIT_ENTRY_REASONS)[number];

/** Append-only. `allocations` (beyond 4) names the grants each row moved. */
export const creditEntry = pgTable(
  'credit_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    delta: bigint('delta', { mode: 'number' }).notNull(),
    reason: text('reason').$type<CreditEntryReason>().notNull(),
    refId: uuid('ref_id'),
    reeId: uuid('ree_id'),
    note: text('note'),
    allocations: jsonb('allocations').$type<Allocation[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_entry_user_idx').on(t.userId, t.createdAt),
    index('credit_entry_ref_idx').on(t.refId),
    /* Per-Ree usage: answer counts (query_base) and income (query_fee_earned), by time for statistics. */
    index('credit_entry_ree_idx').on(t.reeId, t.reason, t.createdAt).where(sql`ree_id is not null`),
    check('credit_entry_reason_check', oneOf('reason', CREDIT_ENTRY_REASONS)),
  ],
);

export const creditHold = pgTable(
  'credit_hold',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    kind: text('kind').$type<'chat' | 'knowledge' | 'video' | 'payout' | 'post' | 'deduction'>().notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    allocations: jsonb('allocations').$type<Allocation[]>().notNull(),
    status: text('status').$type<'held' | 'settled' | 'released'>().notNull().default('held'),
    refId: uuid('ref_id'),
    /** Which sub-ledger the hold writes (`chat_fee`, `chat_verify`, …), so a hold closed by a reaper names the right reasons; null for the kind's own. */
    ledger: text('ledger'),
    /** The Ree a chat hold is for. */
    reeId: uuid('ree_id'),
    createdAt: createdAt(),
    closedAt: timestampTz('closed_at'),
  },
  (t) => [
    index('credit_hold_user_idx').on(t.userId, t.status),
    index('credit_hold_ref_idx').on(t.refId),
    index('credit_hold_open_idx').on(t.kind, t.createdAt).where(sql`status = 'held'`),
    check('credit_hold_kind_check', oneOf('kind', ['chat', 'knowledge', 'video', 'payout', 'post', 'deduction'])),
    check('credit_hold_status_check', oneOf('status', ['held', 'settled', 'released'])),
  ],
);

/**
 * Payout tracing for the conversation answers' earnings (payout-funding.ts),
 * frozen by migration 0069 before it dropped the conversation tables: one
 * row per reply a `query_fee_earned` entry names (`credit_entry.ref_id`),
 * with what the trace read from the reply -- its question, which the
 * asker's `query_fee_paid` entries name, the Ree, who asked and when. No
 * foreign keys: like the ledger it outlives the rows it names.
 */
export const payoutTraceLegacy = pgTable('payout_trace_legacy', {
  replyId: uuid('reply_id').primaryKey(),
  requestId: uuid('request_id').notNull(),
  reeId: uuid('ree_id'),
  askerId: uuid('asker_id').notNull(),
  askedAt: timestampTz('asked_at').notNull(),
});

/** One durable snapshot per knowledge reservation, including retries. No source FK:
 * deleting extracted content must not delete its supplier receipts or billing history. */
export const knowledgeCostRun = pgTable('knowledge_cost_run', {
  id: uuid('id').primaryKey().references(() => creditHold.id),
  knowledgeId: uuid('knowledge_id'),
  reeId: uuid('ree_id'),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull(),
  reeName: text('ree_name').notNull(),
  kind: text('kind').notNull(),
  runId: text('run_id'),
  status: text('status').$type<'pending' | 'processing' | 'ready' | 'failed' | 'unknown'>().notNull(),
  error: text('error'),
  /** False for legacy / already-purged sources without supplier metering. */
  metered: boolean('metered').notNull().default(true),
  charges: jsonb('charges').$type<ProviderCharge[]>().notNull().default([]),
  chargedCredits: bigint('charged_credits', { mode: 'number' }),
  /** A processing run's last sign of life; null for runs started before 0045 (judged by age instead). */
  heartbeatAt: timestampTz('heartbeat_at'),
  createdAt: createdAt(),
}, (t) => [
  index('knowledge_cost_run_created_idx').on(t.createdAt, t.id),
  index('knowledge_cost_run_source_idx').on(t.knowledgeId),
  uniqueIndex('knowledge_cost_run_run_idx').on(t.runId),
  check('knowledge_cost_run_status_check', oneOf('status', ['pending', 'processing', 'ready', 'failed', 'unknown'])),
]);

export const administrator = pgTable(
  'administrator',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    role: text('role').$type<'owner' | 'administrator'>().notNull().default('administrator'),
    passwordHash: text('password_hash').notNull(),
    totpSecretCipher: text('totp_secret_cipher').notNull(),
    /** Beyond 4: the last TOTP step spent, so a code cannot be replayed. */
    totpLastCounter: bigint('totp_last_counter', { mode: 'number' }),
    /** Beyond 4: lockout after repeated failures. */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestampTz('locked_until'),
    /** An invited row's current enrolment-link nonce; re-issuing a link rotates it, enrolling clears it. */
    inviteNonce: text('invite_nonce'),
    disabledAt: timestampTz('disabled_at'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('administrator_email_key').on(t.email),
    check('administrator_role_check', oneOf('role', ['owner', 'administrator'])),
  ],
);

/** `id` is the keyed digest of the cookie's token. */
export const adminSession = pgTable(
  'admin_session',
  {
    id: text('id').primaryKey(),
    administratorId: uuid('administrator_id')
      .notNull()
      .references(() => administrator.id, { onDelete: 'cascade' }),
    expiresAt: timestampTz('expires_at').notNull(),
  },
  (t) => [index('admin_session_administrator_idx').on(t.administratorId)],
);

/** Supplier contract prices, versioned in each processing usage record. */
export const providerPricing = pgTable('provider_pricing', {
  id: integer('id').primaryKey().default(1),
  revision: uuid('revision').notNull().defaultRandom(),
  rates: jsonb('rates').$type<ProviderRate[]>().notNull(),
  updatedBy: uuid('updated_by').references(() => administrator.id),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
}, (t) => [check('provider_pricing_singleton_check', sql`${t.id} = 1`)]);

export const modelConfig = pgTable(
  'model_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: text('kind').$type<ModelKind>().notNull(),
    transport: text('transport').$type<'gateway' | 'openai_compatible'>().notNull(),
    baseUrl: text('base_url'),
    model: text('model').notNull(),
    apiKeyCipher: text('api_key_cipher'),
    apiKeyTail: text('api_key_tail'),
    timeoutMs: integer('timeout_ms').notNull().default(60000),
    enabled: boolean('enabled').notNull().default(false),
    /** Generation has independent Free and Plan activation slots. */
    enabledPlan: boolean('enabled_plan').notNull().default(false),
    /**
     * Embedding only: the space its vectors are tagged with while it is the
     * enabled entry, set when it is enabled (null: the base space, see
     * lib/services/embedding-space.ts).
     */
    embeddingSpace: uuid('embedding_space'),
    /**
     * Generation through an OpenAI-compatible endpoint: the operator says the
     * model reads images (posts carry them). A gateway entry's comes from the
     * gateway's catalog instead (its `vision` tag).
     */
    supportsImages: boolean('supports_images').notNull().default(false),
    lastProbeAt: timestampTz('last_probe_at'),
    lastProbeOk: boolean('last_probe_ok'),
    updatedBy: uuid('updated_by'),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
    /**
     * Deleted from the console: the row stays (model_call.config_id, the
     * re-embed jobs and the cost backfill still read it) but no list, page
     * or request uses it again. Only an entry in no list can be deleted.
     */
    deletedAt: timestampTz('deleted_at'),
  },
  (t) => [
    check('model_config_deleted_check', sql`deleted_at is null or not (enabled or enabled_plan)`),
    uniqueIndex('model_config_one_enabled_key').on(t.kind).where(sql`enabled`),
    uniqueIndex('model_config_one_enabled_plan_key').on(t.kind).where(sql`enabled_plan`),
    check('model_config_enabled_plan_check', sql`not enabled_plan or kind = 'generation'`),
    check('model_config_kind_check', oneOf('kind', MODEL_KINDS)),
    check('model_config_transport_check', oneOf('transport', ['gateway', 'openai_compatible'])),
    check(
      'model_config_base_url_check',
      sql`(transport = 'openai_compatible') = (base_url is not null)`,
    ),
  ],
);

/**
 * Primary and backups per kind (and per audience for generation): position
 * 0 tries first. `model_config.enabled` / `enabled_plan` stay on the first
 * active entry (written together with the list) and name the primary, so
 * code from before lists still reads the right model; the list adds the
 * backups after it (design Q9).
 */
export const modelChain = pgTable(
  'model_chain',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<ModelKind>().notNull(),
    audience: text('audience').$type<ChainAudience>().notNull(),
    modelConfigId: uuid('model_config_id').notNull().references(() => modelConfig.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** Paused: keeps its place, never tried. */
    active: boolean('active').notNull().default(true),
    updatedBy: uuid('updated_by'),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('model_chain_entry_key').on(t.kind, t.audience, t.modelConfigId),
    uniqueIndex('model_chain_position_key').on(t.kind, t.audience, t.position),
    check('model_chain_kind_check', oneOf('kind', MODEL_KINDS)),
    check('model_chain_audience_check', oneOf('audience', CHAIN_AUDIENCES)),
    check('model_chain_audience_kind_check', sql`(kind = 'generation') = (audience in ('free', 'plan'))`),
    check('model_chain_position_check', sql`position >= 0`),
  ],
);

/** Whether an entry is cooling after a failure, shared by every instance (each also keeps its own copy for ten seconds). */
export const modelHealth = pgTable(
  'model_health',
  {
    modelConfigId: uuid('model_config_id').primaryKey().references(() => modelConfig.id, { onDelete: 'cascade' }),
    state: text('state').$type<'ok' | 'cooling'>().notNull().default('ok'),
    reason: text('reason').$type<SwitchingClass>(),
    coolingUntil: timestampTz('cooling_until'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastFailureAt: timestampTz('last_failure_at'),
    lastSuccessAt: timestampTz('last_success_at'),
    /** The failure class and HTTP status (`quota:402`); never the provider's text. */
    lastErrorCode: text('last_error_code'),
    lastProbeAt: timestampTz('last_probe_at'),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('model_health_state_check', oneOf('state', ['ok', 'cooling'])),
    check('model_health_reason_check', sql.raw(`reason is null or reason in (${COOLING_REASONS.map((r) => `'${r}'`).join(', ')})`)),
  ],
);

/** The console's "recent switches": an entry starting to cool, recovering, or cleared by hand. */
export const modelHealthEvent = pgTable(
  'model_health_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    modelConfigId: uuid('model_config_id').notNull(),
    event: text('event').$type<'cooling' | 'recovered' | 'manual_clear'>().notNull(),
    reason: text('reason').$type<SwitchingClass>(),
    coolingUntil: timestampTz('cooling_until'),
    createdAt: createdAt(),
  },
  (t) => [
    index('model_health_event_time_idx').on(t.createdAt),
    check('model_health_event_event_check', oneOf('event', ['cooling', 'recovered', 'manual_clear'])),
  ],
);

/** Firecrawl credentials; last_used_at coordinates rotation across server instances. */
export const firecrawlKey = pgTable(
  'firecrawl_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    apiKeyCipher: text('api_key_cipher').notNull(),
    apiKeyHash: text('api_key_hash').notNull(),
    apiKeyTail: text('api_key_tail').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    isFallback: boolean('is_fallback').notNull().default(false),
    lastUsedAt: timestampTz('last_used_at'),
    useCount: integer('use_count').notNull().default(0),
    lastStatus: integer('last_status'),
    cooldownUntil: timestampTz('cooldown_until'),
    updatedBy: uuid('updated_by'),
    createdAt: createdAt(),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('firecrawl_key_hash_key').on(t.apiKeyHash),
    uniqueIndex('firecrawl_key_fallback_key').on(t.isFallback).where(sql`${t.isFallback} = true`),
    index('firecrawl_key_rotation_idx').on(t.enabled, t.lastUsedAt),
    check('firecrawl_key_name_check', sql`char_length(name) between 1 and 80`),
    check('firecrawl_key_use_count_check', sql`use_count >= 0`),
  ],
);

export const adminAudit = pgTable(
  'admin_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    administratorId: uuid('administrator_id'),
    action: text('action').notNull(),
    target: text('target'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: createdAt(),
  },
  (t) => [index('admin_audit_time_idx').on(t.createdAt), index('admin_audit_action_idx').on(t.action)],
);

/** A user's GitHub grant for private repositories (2.2); the token is sealed under ADMIN_SECRET_KEY. */
export const githubConnection = pgTable('github_connection', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  githubLogin: text('github_login').notNull(),
  encryptedToken: text('encrypted_token').notNull(),
  scope: text('scope').notNull().default(''),
  connectedAt: timestampTz('connected_at').notNull().defaultNow(),
});

/**
 * A domain the user proved is theirs (2.2), once for all their Rees. `method`
 * is the check that passed; `challenge` is the value either check looks for.
 */
export const domainClaim = pgTable(
  'domain_claim',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    method: text('method').$type<'dns_txt' | 'well_known'>(),
    challenge: text('challenge').notNull(),
    status: text('status').$type<'pending' | 'verified' | 'failed'>().notNull().default('pending'),
    verifiedAt: timestampTz('verified_at'),
    /** Beyond 4: when the last check ran, for the page's "最近检查". */
    checkedAt: timestampTz('checked_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('domain_claim_user_domain_key').on(t.userId, t.domain),
    check('domain_claim_method_check', sql`method is null or method in ('dns_txt', 'well_known')`),
    check('domain_claim_status_check', oneOf('status', ['pending', 'verified', 'failed'])),
  ],
);

/**
 * One paid Paddle transaction (2.3): a Plan's first payment or a renewal, or
 * a checkout of 1 to 10 Packs. Created by the webhook when the money has
 * arrived, never at checkout, so an abandoned checkout leaves nothing behind.
 */
export const purchase = pgTable(
  'purchase',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    kind: text('kind').$type<'plan' | 'pack'>().notNull(),
    quantity: integer('quantity').notNull().default(1),
    /** Null only for a purchase paid in full with earned credits, which never reaches Paddle. */
    paddleTransactionId: text('paddle_transaction_id'),
    /** Beyond 4: the subscription a Plan payment belongs to. */
    paddleSubscriptionId: text('paddle_subscription_id'),
    status: text('status').$type<'paid' | 'refunded' | 'chargeback'>().notNull().default('paid'),
    /** What the buyer paid, tax included, in the currency's minor unit. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    /** Beyond 4. */
    currency: text('currency').notNull().default('USD'),
    credits: bigint('credits', { mode: 'number' }).notNull(),
    /** Beyond 4: credits taken back so far by refunds and chargebacks. */
    reversedCredits: bigint('reversed_credits', { mode: 'number' }).notNull().default(0),
    /** Beyond 4: Paddle adjustments already applied, so a re-sent one is not applied twice. */
    adjustmentIds: text('adjustment_ids').array().notNull().default(sql`'{}'::text[]`),
    /** Beyond 4: a Plan payment's billing period. */
    periodStart: timestampTz('period_start'),
    periodEnd: timestampTz('period_end'),
    /** Earned credits that paid part (or all) of the price, worth `earned_minor` of it; `amount_minor` is what was paid besides. */
    earnedCredits: bigint('earned_credits', { mode: 'number' }).notNull().default(0),
    earnedMinor: bigint('earned_minor', { mode: 'number' }).notNull().default(0),
    /** The `deduction` hold those earned credits were paid from, so a refund gives them back to the same grants. */
    earnedHoldId: uuid('earned_hold_id'),
    /** Earned credits refunds and chargebacks have given back so far. */
    earnedReturned: bigint('earned_returned', { mode: 'number' }).notNull().default(0),
    /** The checkout page's request id for a purchase paid in full with earned credits: a repeated request returns this purchase (review S4). */
    requestId: uuid('request_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('purchase_paddle_transaction_key').on(t.paddleTransactionId),
    uniqueIndex('purchase_request_key').on(t.userId, t.requestId).where(sql`request_id is not null`),
    check('purchase_paid_check', sql`paddle_transaction_id is not null or earned_minor > 0`),
    check('purchase_earned_check', sql`earned_credits >= 0 and earned_minor >= 0 and earned_returned between 0 and earned_credits`),
    index('purchase_user_idx').on(t.userId, t.createdAt),
    check('purchase_kind_check', oneOf('kind', ['plan', 'pack'])),
    check('purchase_status_check', oneOf('status', ['paid', 'refunded', 'chargeback'])),
    /* 1–10 is the checkout's rule; a payment is recorded as Paddle took it. */
    check('purchase_quantity_check', sql`quantity >= 1`),
    check('purchase_reversed_check', sql`reversed_credits between 0 and credits`),
  ],
);

/**
 * A user's Plan (2.3), mirrored from Paddle's subscription events. Active
 * means paying: it unlocks Packs until `current_period_end`. Cancelling sets
 * `cancel_at_period_end`; the period's credits stay spendable to its end.
 */
export const subscription = pgTable(
  'subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    paddleSubscriptionId: text('paddle_subscription_id').notNull(),
    /** Beyond 4. */
    paddleCustomerId: text('paddle_customer_id'),
    status: text('status').$type<'active' | 'cancelled' | 'expired'>().notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    currentPeriodStart: timestampTz('current_period_start'),
    currentPeriodEnd: timestampTz('current_period_end'),
    /** Beyond 4: Paddle's `updated_at` of the state held here; an older event never overwrites a newer one. */
    paddleUpdatedAt: timestampTz('paddle_updated_at'),
    createdAt: createdAt(),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('subscription_paddle_key').on(t.paddleSubscriptionId),
    index('subscription_user_idx').on(t.userId, t.status),
    check('subscription_status_check', oneOf('status', ['active', 'cancelled', 'expired'])),
  ],
);

/**
 * Beyond 4: the Paddle transactions checkout created, so a second Plan
 * checkout (another tab, a double click) reopens the open one instead of
 * starting a second subscription.
 */
export const paddleCheckout = pgTable(
  'paddle_checkout',
  {
    paddleTransactionId: text('paddle_transaction_id').primaryKey(),
    priceKey: text('price_key'),
    unitPriceMinor: integer('unit_price_minor'),
    unitCredits: integer('unit_credits').notNull().default(100_000),
    /** The Paddle price the checkout was created with; a payment for this transaction must be for it. Null on checkouts from before it was kept. */
    paddlePriceId: text('paddle_price_id'),
    supersededAt: timestampTz('superseded_at'),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    kind: text('kind').$type<'plan' | 'pack'>().notNull(),
    quantity: integer('quantity').notNull(),
    /** Earned credits held to pay `earned_minor` of this checkout (a `deduction` hold); released if the checkout is replaced or left unpaid. */
    earnedHoldId: uuid('earned_hold_id'),
    earnedCredits: bigint('earned_credits', { mode: 'number' }).notNull().default(0),
    earnedMinor: integer('earned_minor').notNull().default(0),
    /** Failed cancellations of an earned checkout (Paddle refused or was down): the sweep backs off by them and alerts when Paddle says it was paid (review round 2). */
    releaseAttempts: integer('release_attempts').notNull().default(0),
    releaseTriedAt: timestampTz('release_tried_at'),
    releaseError: text('release_error'),
    createdAt: createdAt(),
  },
  (t) => [index('paddle_checkout_earned_idx').on(t.createdAt).where(sql`earned_hold_id is not null and superseded_at is null`), index('paddle_checkout_user_idx').on(t.userId, t.kind, t.createdAt), check('paddle_checkout_kind_check', oneOf('kind', ['plan', 'pack']))],
);

/**
 * Beyond 4: every Paddle notification we accepted, by Paddle's event id. The
 * row is written in the transaction that applies the event, so a re-delivery
 * finds it and changes nothing, and a failed one leaves no row to block the retry.
 */
export const billingEvent = pgTable(
  'billing_event',
  {
    id: text('id').primaryKey(),
    eventType: text('event_type').notNull(),
    occurredAt: timestampTz('occurred_at'),
    /** What the event did: `credited`, `refunded`, `subscription`, `ignored`, … */
    outcome: text('outcome').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestampTz('received_at').notNull().defaultNow(),
  },
  (t) => [index('billing_event_time_idx').on(t.receivedAt)],
);

/**
 * Beyond 4: what a refund or chargeback could not take back because the
 * credits were already spent (2.3, "不足部分记一条负债行"). The balance never
 * goes below zero; the next credits to arrive pay this off first.
 */
export const creditDebt = pgTable(
  'credit_debt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    remaining: bigint('remaining', { mode: 'number' }).notNull(),
    purchaseId: uuid('purchase_id').references(() => purchase.id),
    createdAt: createdAt(),
    clearedAt: timestampTz('cleared_at'),
  },
  (t) => [
    index('credit_debt_open_idx').on(t.userId).where(sql`remaining > 0`),
    check('credit_debt_remaining_check', sql`remaining >= 0 and remaining <= amount and amount > 0`),
  ],
);

/* ------------------------------------------------------------ redeem codes */

/**
 * One generation of redeem codes (docs/design/redeem-codes.md): what each
 * code gives, how often it and each user may use it, and when. Target and
 * limits are a promise to whoever holds a code, so only the name, note,
 * status and expiry change afterwards. `credits` is snapshotted at creation:
 * a Plan's per-month allowance, or a Pack batch's total.
 */
export const redeemBatch = pgTable(
  'redeem_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    note: text('note'),
    kind: text('kind').$type<'plan' | 'pack'>().notNull(),
    planMonths: integer('plan_months'),
    packQuantity: integer('pack_quantity'),
    credits: bigint('credits', { mode: 'number' }).notNull(),
    codePrefix: text('code_prefix'),
    codeCount: integer('code_count').notNull(),
    /** Per code; null (unlimited) only for a batch of one code. */
    maxRedemptions: integer('max_redemptions'),
    /** Per user, across the whole batch. */
    perUserLimit: integer('per_user_limit').notNull().default(1),
    startsAt: timestampTz('starts_at').notNull(),
    expiresAt: timestampTz('expires_at'),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    redemptionCount: integer('redemption_count').notNull().default(0),
    createdBy: uuid('created_by').references(() => administrator.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('redeem_batch_created_idx').on(t.createdAt),
    index('redeem_batch_status_idx').on(t.status, t.expiresAt),
    check('redeem_batch_kind_check', oneOf('kind', ['plan', 'pack'])),
    check('redeem_batch_status_check', oneOf('status', ['active', 'disabled'])),
    check('redeem_batch_target_check', sql`(kind = 'plan') = (plan_months is not null) and (kind = 'pack') = (pack_quantity is not null)`),
    check('redeem_batch_months_check', sql`plan_months is null or plan_months between 1 and 12`),
    check('redeem_batch_quantity_check', sql`pack_quantity is null or pack_quantity between 1 and 10`),
    check('redeem_batch_credits_check', sql`credits between 1 and 100000000`),
    check('redeem_batch_count_check', sql`code_count between 1 and 10000`),
    check('redeem_batch_limits_check', sql`(max_redemptions is null or max_redemptions >= 1) and (max_redemptions is not null or code_count = 1) and per_user_limit >= 1`),
    check('redeem_batch_window_check', sql`expires_at is null or starts_at < expires_at`),
    check('redeem_batch_name_check', sql`char_length(name) between 1 and 80`),
  ],
);

/** A code of a batch. Only its digest is looked up; the sealed copy is for the console's export. */
export const redeemCode = pgTable(
  'redeem_code',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => redeemBatch.id),
    codeDigest: text('code_digest').notNull(),
    codeSealed: text('code_sealed').notNull(),
    codeLast4: text('code_last4').notNull(),
    maxRedemptions: integer('max_redemptions'),
    redemptionCount: integer('redemption_count').notNull().default(0),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    lastRedeemedAt: timestampTz('last_redeemed_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('redeem_code_digest_key').on(t.codeDigest),
    index('redeem_code_batch_idx').on(t.batchId, t.createdAt),
    index('redeem_code_last4_idx').on(t.batchId, t.codeLast4),
    check('redeem_code_status_check', oneOf('status', ['active', 'disabled'])),
    check('redeem_code_count_check', sql`redemption_count >= 0 and (max_redemptions is null or redemption_count <= max_redemptions)`),
  ],
);

/**
 * One successful redemption. A redeemed Plan is the run
 * [plan_starts_at, plan_ends_at), one Plan grant per month; it makes the
 * user's Plan active as a paying subscription does (`planStateOf`).
 */
export const redeemRedemption = pgTable(
  'redeem_redemption',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    codeId: uuid('code_id')
      .notNull()
      .references(() => redeemCode.id),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => redeemBatch.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    kind: text('kind').$type<'plan' | 'pack'>().notNull(),
    credits: bigint('credits', { mode: 'number' }).notNull(),
    planMonths: integer('plan_months'),
    planStartsAt: timestampTz('plan_starts_at'),
    planEndsAt: timestampTz('plan_ends_at'),
    /**
     * A Plan's next month still to be issued: when it begins, or null once
     * the last month is out (or for a Pack). The cron picks up rows whose
     * time has come (docs/design/redeem-codes.md 11.2).
     */
    nextPeriodAt: timestampTz('next_period_at'),
    requestId: uuid('request_id'),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    /** Reserved for a later "revoke" (design Q5); nothing sets it yet. */
    revokedAt: timestampTz('revoked_at'),
    revokedBy: uuid('revoked_by').references(() => administrator.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('redeem_redemption_request_key').on(t.userId, t.requestId).where(sql`request_id is not null`),
    index('redeem_redemption_batch_user_idx').on(t.batchId, t.userId),
    index('redeem_redemption_code_idx').on(t.codeId, t.createdAt),
    index('redeem_redemption_batch_time_idx').on(t.batchId, t.createdAt),
    index('redeem_redemption_plan_idx').on(t.userId, t.planEndsAt).where(sql`kind = 'plan' and revoked_at is null`),
    index('redeem_redemption_next_period_idx').on(t.nextPeriodAt).where(sql`next_period_at is not null and revoked_at is null`),
    check('redeem_redemption_kind_check', oneOf('kind', ['plan', 'pack'])),
    check('redeem_redemption_plan_check', sql`(kind = 'plan') = (plan_months is not null and plan_starts_at is not null and plan_ends_at is not null)`),
  ],
);

/**
 * A user's knowledge storage cost so far (`lib/services/storage-billing.ts`):
 * pico-dollars accrued, and the credits charged for them. The charge is
 * always `ceil(cost)`, so it is never below cost and at most one credit above.
 */
export const storageAccrual = pgTable('storage_accrual', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  costPico: numeric('cost_pico', { precision: 40, scale: 0 }).notNull().default('0'),
  chargedCredits: bigint('charged_credits', { mode: 'number' }).notNull().default(0),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
});

/* --------------------------------------------------------- step 4: explore */

/**
 * A public Ree's knowledge profile (2.4): at most 16 vectors -- its
 * introduction and tags, its example questions, and centroids of its
 * passages. Only public Rees have rows; turning private deletes them.
 */
export const reeProfileVector = pgTable(
  'ree_profile_vector',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reeId: uuid('ree_id')
      .notNull()
      .references(() => ree.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'profile' | 'sample_question' | 'centroid'>().notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    /** The embedding space of `embedding`; null for rows made before 0044 (the base space). */
    embeddingSpace: uuid('embedding_space'),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('ree_profile_vector_ree_idx').on(t.reeId),
    index('ree_profile_vector_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    check('ree_profile_vector_kind_check', oneOf('kind', ['profile', 'sample_question', 'centroid'])),
  ],
);

/** Beyond 4: fixed-window request counters for the free, unauthenticated explore search (2.4, "按 IP 和账号限频"). */
export const rateBucket = pgTable(
  'rate_bucket',
  {
    key: text('key').notNull(),
    windowStart: timestampTz('window_start').notNull(),
    hits: integer('hits').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

/**
 * The console's overrides of `USER_RATE_LIMITS` (lib/services/rate-limit-settings.ts):
 * one row per limit name an administrator changed; a name without a row
 * keeps its code default. Names are not constrained here, so a limit
 * removed from code leaves a harmless row behind.
 */
export const rateLimitSetting = pgTable('rate_limit_setting', {
  name: text('name').primaryKey(),
  perMinute: integer('per_minute').notNull(),
  perHour: integer('per_hour').notNull(),
  updatedBy: uuid('updated_by').references(() => administrator.id, { onDelete: 'set null' }),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
}, () => [
  check('rate_limit_setting_minute_check', sql`per_minute between 1 and 1000000`),
  check('rate_limit_setting_hour_check', sql`per_hour between 1 and 1000000`),
]);

/**
 * Accounts the user-route limiter lets straight through (official batch
 * work), for the limit names in `limits` only, so an exemption from upload
 * tokens does not also open the model-cost routes.
 */
export const rateLimitExemption = pgTable('rate_limit_exemption', {
  userId: uuid('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  limits: text('limits').array().notNull().default(sql`'{uploadToken,browse}'::text[]`),
  note: text('note'),
  createdBy: uuid('created_by').references(() => administrator.id, { onDelete: 'set null' }),
  createdAt: timestampTz('created_at').notNull().defaultNow(),
}, () => [check('rate_limit_exemption_limits_check', sql`cardinality(limits) > 0`)]);

/**
 * The console's values for the ceilings each feature counts itself (posts
 * and follow-ups a day, Explore questions a minute per account), keyed by
 * `CEILING_KEYS` in lib/services/rate-limit-settings.ts; a key without a row
 * keeps its code default. No exemption lifts these.
 */
export const limitCeilingSetting = pgTable('limit_ceiling_setting', {
  key: text('key').primaryKey(),
  value: integer('value').notNull(),
  updatedBy: uuid('updated_by').references(() => administrator.id, { onDelete: 'set null' }),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
}, () => [check('limit_ceiling_setting_value_check', sql`value between 1 and 100000`)]);

/**
 * Beyond 4: anonymous chat with free Rees (query fee 0) on the public and
 * share pages. Rounds answered, and attempts, per key and UTC day, reserved
 * atomically before the model is called (lib/services/anonymous-chat.ts).
 * A visitor's keys are an HMAC under a key derived from AUTH_SECRET of the
 * browser fingerprint, the anonymous-id cookie or the client address,
 * prefixed by which one it is (the raw values are never stored); `ree:` and
 * `all:` keys count a Ree's and the platform's. The hourly rank job clears
 * past days.
 */
export const anonymousChatQuota = pgTable(
  'anonymous_chat_quota',
  {
    keyHash: text('key_hash').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    rounds: integer('rounds').notNull().default(0),
    /** Every round taken, given back or not: refunds never return an attempt (ANONYMOUS_ATTEMPTS_FACTOR). */
    attempts: integer('attempts').notNull().default(0),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.keyHash, t.day] }),
    index('anonymous_chat_quota_day_idx').on(t.day),
    check('anonymous_chat_quota_rounds_check', sql`rounds >= 0 and attempts >= rounds`),
  ],
);

/**
 * Beyond 4: one row per answer a free Ree gave a signed-out visitor. Nothing
 * else of the exchange is kept (no conversation, message or ledger entry);
 * the row only lets the owner's statistics, the public answer count and
 * the share page's figures include anonymous answers.
 */
export const anonymousAnswer = pgTable(
  'anonymous_answer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reeId: uuid('ree_id')
      .notNull()
      .references(() => ree.id, { onDelete: 'cascade' }),
    /** The `re0_visitor` id when the answer was asked on the share page by a browser that visited it (share.ts `shareVisitorFor`); null elsewhere. */
    shareVisitorId: text('share_visitor_id'),
    createdAt: createdAt(),
  },
  (t) => [index('anonymous_answer_ree_idx').on(t.reeId, t.createdAt), index('anonymous_answer_share_idx').on(t.reeId, t.createdAt).where(sql`share_visitor_id is not null`)],
);

/**
 * Beyond 4: the Ree page's public Q&A. One row per question an asker chose
 * to publish ("回答后公开"), a redacted snapshot of the question and the
 * answer, single-turn only. A row is shown while it is `published` and its
 * Ree is public with public Q&A on. Nothing adds rows any more: an asker's
 * conversation is gone (migration 0069 kept the rows it had published), and
 * every published row is also a post (public-qa-sync.ts).
 */
export const reePublicQa = pgTable(
  'ree_public_qa',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reeId: uuid('ree_id').notNull().references(() => ree.id, { onDelete: 'cascade' }),
    source: text('source').$type<PublicQaSource>().notNull(),
    /** The signed-in asker, never shown; deleting the account deletes the row. */
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    citations: jsonb('citations').$type<CitationSnapshot[]>().notNull().default([]),
    lang: text('lang').$type<'zh' | 'en'>().notNull(),
    status: text('status').$type<PublicQaStatus>().notNull().default('pending'),
    moderationAttempts: integer('moderation_attempts').notNull().default(0),
    hiddenBy: text('hidden_by').$type<PublicQaHider>(),
    helpfulCount: integer('helpful_count').notNull().default(0),
    reportCount: integer('report_count').notNull().default(0),
    /** Pinned by the owner: first in the stream and the share page; one per Ree. */
    pinnedAt: timestampTz('pinned_at'),
    createdAt: createdAt(),
    publishedAt: timestampTz('published_at'),
  },
  (t) => [
    index('ree_public_qa_feed_idx').on(t.reeId, t.publishedAt.desc(), t.id.desc()).where(sql`status = 'published'`),
    index('ree_public_qa_pending_idx').on(t.createdAt).where(sql`status = 'pending'`),
    uniqueIndex('ree_public_qa_pinned_key').on(t.reeId).where(sql`pinned_at is not null`),
    index('ree_public_qa_user_idx').on(t.userId).where(sql`user_id is not null`),
    check('ree_public_qa_source_check', oneOf('source', [...PUBLIC_QA_SOURCES])),
    check('ree_public_qa_status_check', oneOf('status', [...PUBLIC_QA_STATUSES])),
    check('ree_public_qa_hidden_by_check', sql`hidden_by is null or hidden_by in (${sql.raw(PUBLIC_QA_HIDERS.map((value) => `'${value}'`).join(', '))})`),
    check('ree_public_qa_lang_check', oneOf('lang', ['zh', 'en'])),
    check('ree_public_qa_question_check', sql`char_length(question) between 1 and 4000`),
    check('ree_public_qa_answer_check', sql`char_length(answer) between 1 and ${sql.raw(String(PUBLIC_QA_ANSWER_MAX_CHARS))}`),
    check('ree_public_qa_published_check', sql`(status = 'published') <= (published_at is not null)`),
  ],
);

/** "有帮助" on a public answer: one per signed-in user. */
export const reePublicQaVote = pgTable(
  'ree_public_qa_vote',
  {
    qaId: uuid('qa_id').notNull().references(() => reePublicQa.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.qaId, t.userId] }), index('ree_public_qa_vote_user_idx').on(t.userId)],
);

/** "举报" on a public answer: one per reporter, the account or an HMAC of the anonymous id. */
export const reePublicQaReport = pgTable(
  'ree_public_qa_report',
  {
    qaId: uuid('qa_id').notNull().references(() => reePublicQa.id, { onDelete: 'cascade' }),
    reporterKey: text('reporter_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.qaId, t.reporterKey] })],
);

/* ---------------------------------------------------------------- v5 posts */

/**
 * Beyond 4 (v5): a public post -- a question for everyone that up to five
 * relevant Rees answer on their own (lib/services/posts.ts). Also the home
 * of the Ree page's public Q&A: every published `ree_public_qa` row is
 * copied in as a post with one answer (`legacy_qa_id`, `syncPublicQa`),
 * which can run again at any time without copying twice.
 */
export const post = pgTable(
  'post',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The author; null for a visitor's published answer and RE0's examples. Deleting the account deletes their posts. */
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    source: text('source').$type<PostSource>().notNull(),
    /**
     * `private` (私密提问): only the author ever sees it (`visiblePost` is public
     * only); it skips review and goes straight to `published`.
     */
    visibility: text('visibility').$type<PostVisibility>().notNull().default('public'),
    /** A private post's owner actions: 置顶, 归档, and 重命名 (null shows the question). */
    pinnedAt: timestampTz('pinned_at'),
    archivedAt: timestampTz('archived_at'),
    title: text('title'),
    /** The public post 转为公开 copied this private one into: one copy per private post. */
    publishedCopyId: uuid('published_copy_id').references((): AnyPgColumn => post.id, { onDelete: 'set null' }),
    /** The API key an MCP ask (`source = 'api'`) came through, for the key's usage; null once the key is deleted. */
    apiKeyId: uuid('api_key_id').references((): AnyPgColumn => apiKey.id, { onDelete: 'set null' }),
    /** The public Q&A row this post was copied from. */
    legacyQaId: uuid('legacy_qa_id').references(() => reePublicQa.id, { onDelete: 'set null' }),
    /**
     * A visitor's question from the share page (`source = 'visitor'`, no
     * author): the Ree's owner who pays for its answer, the hold taken from
     * them when it was asked (moved onto the answer, or given back), and an
     * HMAC of the asking browser's `re0_visitor` id, so that browser can
     * follow it there (lib/services/visitor-asks.ts). Never the raw id.
     */
    sponsorId: uuid('sponsor_id').references(() => user.id, { onDelete: 'set null' }),
    sponsorHoldId: uuid('sponsor_hold_id'),
    visitorKey: text('visitor_key'),
    /** The author chose "匿名发布": the page shows "一位用户". */
    anonymous: boolean('anonymous').notNull().default(false),
    question: text('question').notNull(),
    detail: text('detail').notNull().default(''),
    /**
     * What the post's images (`post_image`) say, written once by the
     * generation model (OCR + a short description): what matching, retrieval
     * and the synthesis read in their place. Null without images, or until
     * written.
     */
    imageText: text('image_text'),
    lang: text('lang').$type<'zh' | 'en'>().notNull(),
    /** The first answering Ree's category, for the feed's tag. */
    category: text('category'),
    /** The Ree the author named ("发帖问它"): it answers whatever the threshold says, while it takes posts. */
    mentionReeId: uuid('mention_ree_id').references(() => ree.id, { onDelete: 'set null' }),
    /** "引用提问": this post quotes a post, or one answer of it (`quote_kind`); the ids go when what they point at is purged, the kind stays so the card says it is gone. */
    quoteKind: text('quote_kind').$type<'post' | 'answer'>(),
    quotePostId: uuid('quote_post_id').references((): AnyPgColumn => post.id, { onDelete: 'set null' }),
    quoteAnswerId: uuid('quote_answer_id').references((): AnyPgColumn => postAnswer.id, { onDelete: 'set null' }),
    /** Set when the post it quotes is taken down: its answers may restate the quoted text, so an administrator reviews them (`/admin/posts?view=quotes`); cleared when they do. */
    quoteReviewAt: timestampTz('quote_review_at'),
    status: text('status').$type<PostStatus>().notNull().default('pending'),
    /** Who took a published post down: an administrator, or `POST_REPORT_THRESHOLD` distinct reporters (until an administrator restores it). */
    hiddenBy: text('hidden_by').$type<'admin' | 'reports'>(),
    reportCount: integer('report_count').notNull().default(0),
    /** The composer's token for one post: the same token, or the same text within a minute, publishes (and holds) once. */
    clientToken: uuid('client_token'),
    moderationAttempts: integer('moderation_attempts').notNull().default(0),
    answerState: text('answer_state').$type<PostAnswerState>().notNull().default('waiting'),
    candidates: integer('candidates').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    answerCount: integer('answer_count').notNull().default(0),
    /** "有帮助" on the post itself (`post_vote`); the cards show it added to its first-round answers' votes. */
    helpfulCount: integer('helpful_count').notNull().default(0),
    /** Published follow-ups (追问) shown under it, for the cards; kept as they are published, hidden, restored and deleted. */
    followupCount: integer('followup_count').notNull().default(0),
    summaryState: text('summary_state').$type<'running' | 'done'>(),
    summaryContent: text('summary_content'),
    summarySources: jsonb('summary_sources').$type<SynthesisSource[]>(),
    summaryHoldId: uuid('summary_hold_id'),
    /** The answers the summary was written from; it is not shown once any of them is no longer shown. */
    summaryAnswers: jsonb('summary_answers').$type<string[]>(),
    /** Free rewrites of a stale summary so far; capped at `POST_SUMMARY_FREE_REWRITES`. */
    summaryRewrites: integer('summary_rewrites').notNull().default(0),
    summaryAt: timestampTz('summary_at'),
    /** In the author's trash since: hidden from everyone else at once. */
    deletedAt: timestampTz('deleted_at'),
    createdAt: createdAt(),
    publishedAt: timestampTz('published_at'),
    /** When a run claimed it (`answer_state` 'answering'): how long that run has had, for the sweep (null before 0073: read as `published_at`). */
    answeringAt: timestampTz('answering_at'),
    answeredAt: timestampTz('answered_at'),
  },
  (t) => [
    index('post_feed_idx').on(t.publishedAt.desc(), t.id.desc()).where(sql`status = 'published' and deleted_at is null and visibility = 'public'`),
    index('post_user_idx').on(t.userId, t.createdAt.desc()).where(sql`user_id is not null`),
    index('post_pending_idx').on(t.createdAt).where(sql`status = 'pending' or answer_state <> 'done'`),
    uniqueIndex('post_legacy_qa_key').on(t.legacyQaId).where(sql`legacy_qa_id is not null`),
    /* The counts leave out a 转为公开 copy (its answers were counted on the private post): looked up per answer. */
    index('post_published_copy_idx').on(t.publishedCopyId).where(sql`published_copy_id is not null`),
    index('post_quote_idx').on(t.quotePostId).where(sql`quote_post_id is not null`),
    index('post_quote_review_idx').on(t.quoteReviewAt).where(sql`quote_review_at is not null`),
    check('post_quote_kind_check', sql`quote_kind is null or quote_kind in ('post', 'answer')`),
    uniqueIndex('post_client_token_key').on(t.userId, t.clientToken).where(sql`client_token is not null`),
    /* 发现 → 帖子 searches question and detail with ILIKE; trigrams let that use an index (pg_trgm, migration 0057). */
    index('post_search_idx').using('gin', sql`(question || ' ' || detail) gin_trgm_ops`),
    check('post_source_check', oneOf('source', [...POST_SOURCES])),
    check('post_status_check', oneOf('status', [...POST_STATUSES])),
    check('post_answer_state_check', oneOf('answer_state', [...POST_ANSWER_STATES])),
    check('post_hidden_by_check', sql`hidden_by is null or hidden_by in ('admin', 'reports')`),
    check('post_summary_state_check', sql`summary_state is null or summary_state in ('running', 'done')`),
    check('post_lang_check', oneOf('lang', ['zh', 'en'])),
    check('post_question_check', sql`char_length(question) between 1 and 4000`),
    check('post_detail_check', sql`char_length(detail) <= ${sql.raw(String(POST_DETAIL_MAX))}`),
    check('post_published_check', sql`(status = 'published') <= (published_at is not null)`),
    check('post_visibility_check', oneOf('visibility', [...POST_VISIBILITIES])),
    check('post_title_check', sql`title is null or char_length(title) between 1 and ${sql.raw(String(POST_TITLE_MAX))}`),
    /* 试问 and MCP asks are private by nature. */
    check('post_private_source_check', sql`source not in ('test', 'api') or visibility = 'private'`),
    /* A visitor's question is always public and has no author. */
    check('post_visitor_source_check', sql`source <> 'visitor' or (visibility = 'public' and user_id is null)`),
    index('post_visitor_idx').on(t.mentionReeId, t.visitorKey, t.createdAt.desc()).where(sql`visitor_key is not null`),
  ],
);

/**
 * An image attached to a post (lib/domain/post-images.ts): a private Blob
 * object under its author's prefix, served by `/media` to whoever may read
 * the post. 转为公开 copies the rows, so one object may belong to two posts.
 */
export const postImage = pgTable(
  'post_image',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    pathname: text('pathname').notNull(),
    contentType: text('content_type').notNull(),
    bytes: integer('bytes').notNull(),
    /** The feed's small copy beside the image (`<image>.thumb.jpg`, lib/domain/post-images.ts); null when the composer made none. */
    thumbPathname: text('thumb_pathname'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('post_image_position_key').on(t.postId, t.position),
    index('post_image_pathname_idx').on(t.pathname),
    index('post_image_thumb_pathname_idx').on(t.thumbPathname),
    check('post_image_position_check', sql`position between 0 and 3`),
    check('post_image_content_type_check', oneOf('content_type', ['image/jpeg', 'image/png', 'image/webp'])),
  ],
);

/**
 * A channel: the posts tagged `#name` (lib/domain/hashtags.ts says what a
 * tag is). Made by the first public post that uses the tag, by whoever
 * posted it; never deleted, but listed and indexed only while a visible
 * post is in it -- its counts are read from `post_channel` at query time,
 * so a post taken down, rejected or trashed leaves it at once.
 */
export const channel = pgTable(
  'channel',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NFKC, lower case, 1–32 characters (`channelNameOf`). */
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('channel_name_key').on(t.name),
    /* The Channel tab's search (ILIKE), as posts' (pg_trgm, migration 0057). */
    index('channel_name_search_idx').using('gin', sql`name gin_trgm_ops`),
    check('channel_name_check', sql`char_length(name) between 1 and 32`),
  ],
);

/** A public post filed under a channel: written with the post, at most ten per post. */
export const postChannel = pgTable(
  'post_channel',
  {
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull().references(() => channel.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.channelId] }), index('post_channel_channel_idx').on(t.channelId, t.postId)],
);

/**
 * A follow-up (追问) under a public post: a signed-in reader asks on, and
 * only Rees that answered the post's first round answer it -- those it
 * @-mentions, or else the relevant ones (lib/services/post-followups.ts).
 * Reviewed like a post before any Ree is asked; its answers are
 * `post_answer` rows pointing back at it, charged to whoever asked.
 */
export const postFollowup = pgTable(
  'post_followup',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    lang: text('lang').$type<'zh' | 'en'>().notNull(),
    /** The Rees it @-mentions: at most every first-round answerer, checked when asked. */
    mentionReeIds: uuid('mention_ree_ids').array().notNull().default(sql`'{}'::uuid[]`),
    status: text('status').$type<FollowupStatus>().notNull().default('pending'),
    hiddenBy: text('hidden_by').$type<'admin' | 'reports'>(),
    reportCount: integer('report_count').notNull().default(0),
    moderationAttempts: integer('moderation_attempts').notNull().default(0),
    answerState: text('answer_state').$type<PostAnswerState>().notNull().default('waiting'),
    candidates: integer('candidates').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    /**
     * Asked under the AI answer of a public post no Ree answered (继续问
     * AI): answered by the AI only, at the asker's cost; reviewed, public
     * and counted like any follow-up since 0072 (ai-answers.ts).
     */
    aiOnly: boolean('ai_only').notNull().default(false),
    /** The composer's token: the same token, or the same text under the same post within a minute, asks once. */
    clientToken: uuid('client_token'),
    /** The API key an MCP continuation of a private post came through (`post.api_key_id` for its first question). */
    apiKeyId: uuid('api_key_id').references((): AnyPgColumn => apiKey.id, { onDelete: 'set null' }),
    deletedAt: timestampTz('deleted_at'),
    createdAt: createdAt(),
    publishedAt: timestampTz('published_at'),
    /** When a run claimed it (`answer_state` 'answering'): how long that run has had, for the sweep (null before 0073: read as `published_at`). */
    answeringAt: timestampTz('answering_at'),
    answeredAt: timestampTz('answered_at'),
  },
  (t) => [
    index('post_followup_thread_idx').on(t.postId, t.createdAt),
    index('post_followup_user_idx').on(t.userId, t.createdAt.desc()),
    index('post_followup_pending_idx').on(t.createdAt).where(sql`status = 'pending' or answer_state <> 'done'`),
    uniqueIndex('post_followup_client_token_key').on(t.userId, t.clientToken).where(sql`client_token is not null`),
    check('post_followup_status_check', oneOf('status', [...FOLLOWUP_STATUSES])),
    check('post_followup_answer_state_check', oneOf('answer_state', [...POST_ANSWER_STATES])),
    check('post_followup_hidden_by_check', sql`hidden_by is null or hidden_by in ('admin', 'reports')`),
    check('post_followup_lang_check', oneOf('lang', ['zh', 'en'])),
    check('post_followup_question_check', sql`char_length(question) between 1 and 2000`),
    check('post_followup_mentions_check', sql`cardinality(mention_ree_ids) <= 5`),
    check('post_followup_published_check', sql`(status = 'published') <= (published_at is not null)`),
  ],
);

/** "举报" on a follow-up: one per reporter, the account or an HMAC of the visitor's network. */
export const postFollowupReport = pgTable(
  'post_followup_report',
  {
    followupId: uuid('followup_id').notNull().references(() => postFollowup.id, { onDelete: 'cascade' }),
    reporterKey: text('reporter_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.followupId, t.reporterKey] })],
);

/** One Ree's answer to a post. */
export const postAnswer = pgTable(
  'post_answer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    /** Null for the post's first round; a follow-up's answers point at it (追问). */
    followupId: uuid('followup_id').references((): AnyPgColumn => postFollowup.id, { onDelete: 'cascade' }),
    reeId: uuid('ree_id').notNull().references(() => ree.id, { onDelete: 'cascade' }),
    legacyQaId: uuid('legacy_qa_id').references(() => reePublicQa.id, { onDelete: 'set null' }),
    /** The best passage's similarity when the search picked it; null for a mention or a copied Q&A. */
    similarity: real('similarity'),
    mentioned: boolean('mentioned').notNull().default(false),
    state: text('state').$type<AnswerState>().notNull().default('queued'),
    text: text('text').notNull().default(''),
    citations: jsonb('citations').$type<CitationSnapshot[]>().notNull().default([]),
    model: text('model'),
    hiddenBy: text('hidden_by').$type<AnswerHider>(),
    helpfulCount: integer('helpful_count').notNull().default(0),
    reportCount: integer('report_count').notNull().default(0),
    /** Pinned by the Ree's owner: first on the Ree page and the share page; one per Ree. */
    pinnedAt: timestampTz('pinned_at'),
    /** A paid Ree's answer: what its author agreed to pay (base fee plus query fee), and the two holds. */
    price: integer('price'),
    baseHoldId: uuid('base_hold_id'),
    feeHoldId: uuid('fee_hold_id'),
    /** When the author agreed or declined. */
    decidedAt: timestampTz('decided_at'),
    /** How many times the author agreed to this request: at most `POST_PAID_AGREE_MAX`. */
    agreements: integer('agreements').notNull().default(0),
    createdAt: createdAt(),
    answeredAt: timestampTz('answered_at'),
  },
  (t) => [
    index('post_answer_awaiting_idx').on(t.postId).where(sql`state in ('awaiting', 'answering')`),
    /* One answer per Ree in the first round, and one per Ree in each follow-up. */
    uniqueIndex('post_answer_post_ree_key').on(t.postId, t.reeId).where(sql`followup_id is null`),
    uniqueIndex('post_answer_followup_ree_key').on(t.followupId, t.reeId).where(sql`followup_id is not null`),
    index('post_answer_ree_idx').on(t.reeId, t.answeredAt.desc(), t.id.desc()).where(sql`state = 'answered' and hidden_by is null`),
    uniqueIndex('post_answer_legacy_qa_key').on(t.legacyQaId).where(sql`legacy_qa_id is not null`),
    uniqueIndex('post_answer_pinned_key').on(t.reeId).where(sql`pinned_at is not null`),
    check('post_answer_state_check', oneOf('state', [...ANSWER_STATES])),
    check('post_answer_hidden_by_check', sql`hidden_by is null or hidden_by in (${sql.raw(ANSWER_HIDERS.map((value) => `'${value}'`).join(', '))})`),
    check('post_answer_text_check', sql`char_length(text) <= ${sql.raw(String(PUBLIC_QA_ANSWER_MAX_CHARS))}`),
  ],
);

/** "有帮助" on an answer: one per signed-in user. */
export const postAnswerVote = pgTable(
  'post_answer_vote',
  {
    answerId: uuid('answer_id').notNull().references(() => postAnswer.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.answerId, t.userId] }), index('post_answer_vote_user_idx').on(t.userId)],
);

/** "没帮助" on a private post's answer: its author only (public answers have no 👎). */
export const postAnswerFeedback = pgTable(
  'post_answer_feedback',
  {
    answerId: uuid('answer_id').notNull().references(() => postAnswer.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.answerId, t.userId] })],
);

/**
 * What the conversations counted before private posts replaced them,
 * frozen by migration 0066 so the figures stay when the conversation tables
 * go (PR B): each Ree's answers to other people (explore `answersByOthers`,
 * rank `answers_all`), other people's 有用 / 没用 (`votesByOthers`), and
 * other people's questions, answered or not (roles `external_questions`).
 * Readers add the same figures counted from posts.
 */
export const reeLegacyStats = pgTable('ree_legacy_stats', {
  reeId: uuid('ree_id')
    .primaryKey()
    .references(() => ree.id, { onDelete: 'cascade' }),
  answersByOthers: integer('answers_by_others').notNull().default(0),
  helpful: integer('helpful').notNull().default(0),
  unhelpful: integer('unhelpful').notNull().default(0),
  answersAll: integer('answers_all').notNull().default(0),
  questionsByOthers: integer('questions_by_others').notNull().default(0),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
});

/** The role threshold's conversation figures per user (roles.ts `roleMetrics`), frozen like `ree_legacy_stats`. */
export const userLegacyStats = pgTable('user_legacy_stats', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  externalQuestions: integer('external_questions').notNull().default(0),
  helpful: integer('helpful').notNull().default(0),
  unhelpful: integer('unhelpful').notNull().default(0),
});

/** "有帮助" on a post itself: one per signed-in user. */
export const postVote = pgTable(
  'post_vote',
  {
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.userId] }), index('post_vote_user_idx').on(t.userId)],
);

/** "举报" on an answer: one per reporter, the account or an HMAC of the anonymous id. */
export const postAnswerReport = pgTable(
  'post_answer_report',
  {
    answerId: uuid('answer_id').notNull().references(() => postAnswer.id, { onDelete: 'cascade' }),
    reporterKey: text('reporter_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.answerId, t.reporterKey] })],
);

/** "举报" on a post's question: one per reporter, the account or an HMAC of the visitor's network. */
export const postReport = pgTable(
  'post_report',
  {
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    reporterKey: text('reporter_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.reporterKey] })],
);

/** "收藏" on a post. */
export const postSave = pgTable(
  'post_save',
  {
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.postId] }), index('post_save_recent_idx').on(t.userId, t.createdAt.desc(), t.postId.desc())],
);

/**
 * AI 通用回答: the general answer an asker gets when no Ree answered a round
 * (lib/services/ai-answers.ts) -- the first round of a post (`followup_id`
 * null) or one follow-up -- one per round. Apart from `post_answer` on
 * purpose: it is no Ree's answer, so no count, rank, feed, summary or Ree
 * page ever reads it. Only `user_id`, who asked the round and pays for it,
 * ever sees it. `vote` is their 有帮助 / 没帮助, for its quality only.
 */
export const postAiAnswer = pgTable(
  'post_ai_answer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id').notNull().references(() => post.id, { onDelete: 'cascade' }),
    followupId: uuid('followup_id').references((): AnyPgColumn => postFollowup.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    state: text('state').$type<AiAnswerState>().notNull().default('running'),
    text: text('text').notNull().default(''),
    model: text('model'),
    /** The base fee held while it is written: settled once answered, released otherwise. */
    holdId: uuid('hold_id'),
    /** What it was charged (the fee once answered); 0 until then. */
    price: integer('price').notNull().default(0),
    vote: text('vote').$type<'helpful' | 'unhelpful'>(),
    /**
     * On a public post, the review it needs before anyone but its asker reads
     * it: `pending` once written, then `passed` or `rejected`. Null on a
     * private post (only its author ever reads it) and while not written.
     */
    review: text('review').$type<AiAnswerReview>(),
    reviewAttempts: integer('review_attempts').notNull().default(0),
    /** Distinct reporters (`post_ai_answer_report`); at `PUBLIC_QA_REPORT_THRESHOLD` it is refused (`review` 'rejected', `hidden_by` 'reports'). */
    reportCount: integer('report_count').notNull().default(0),
    /** Taken down after it passed review -- by reports or an administrator -- with `review` set to 'rejected'; an administrator may restore it. */
    hiddenBy: text('hidden_by').$type<'reports' | 'admin'>(),
    /** When it started running (again, after a by-hand retry): what the sweep times it by. */
    startedAt: timestampTz('started_at'),
    createdAt: createdAt(),
    answeredAt: timestampTz('answered_at'),
  },
  (t) => [
    uniqueIndex('post_ai_answer_post_key').on(t.postId).where(sql`followup_id is null`),
    uniqueIndex('post_ai_answer_followup_key').on(t.followupId).where(sql`followup_id is not null`),
    index('post_ai_answer_running_idx').on(t.startedAt).where(sql`state = 'running'`),
    index('post_ai_answer_user_idx').on(t.userId),
    index('post_ai_answer_review_idx').on(t.answeredAt).where(sql`review = 'pending'`),
    check('post_ai_answer_state_check', oneOf('state', [...AI_ANSWER_STATES])),
    check('post_ai_answer_vote_check', sql`vote is null or vote in ('helpful', 'unhelpful')`),
    check('post_ai_answer_review_check', sql`review is null or review in ('pending', 'passed', 'rejected')`),
    check('post_ai_answer_text_check', sql`char_length(text) <= ${sql.raw(String(PUBLIC_QA_ANSWER_MAX_CHARS))}`),
    check('post_ai_answer_hidden_by_check', sql`hidden_by is null or hidden_by in ('reports', 'admin')`),
  ],
);

/** "举报" on an AI answer anyone may read: one per reporter, the account or an HMAC of the visitor's network (as `post_answer_report`). */
export const postAiAnswerReport = pgTable(
  'post_ai_answer_report',
  {
    aiAnswerId: uuid('ai_answer_id').notNull().references(() => postAiAnswer.id, { onDelete: 'cascade' }),
    reporterKey: text('reporter_key').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.aiAnswerId, t.reporterKey] })],
);

/* ------------------------------------------------------------- step 5 */

/**
 * A request for the verified role (2.7). One pending row per user; a
 * rejection starts the 30-day wait, a close by an administrator's role change
 * (made official) does not. `metrics` is the threshold as it stood when the
 * user applied.
 */
export const verificationRequest = pgTable(
  'verification_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    statement: text('statement').notNull(),
    links: text('links').array().notNull().default(sql`'{}'::text[]`),
    metrics: jsonb('metrics').$type<RoleMetrics>().notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected' | 'closed'>().notNull().default('pending'),
    /** The reviewer's note: required on a rejection and shown to the user. */
    rejectedReason: text('rejected_reason'),
    closedByRoleChange: boolean('closed_by_role_change').notNull().default(false),
    reviewedBy: uuid('reviewed_by'),
    createdAt: createdAt(),
    decidedAt: timestampTz('decided_at'),
  },
  (t) => [
    uniqueIndex('verification_request_pending_key').on(t.userId).where(sql`status = 'pending'`),
    index('verification_request_user_idx').on(t.userId, t.createdAt),
    index('verification_request_status_idx').on(t.status, t.createdAt),
    check('verification_request_status_check', oneOf('status', ['pending', 'approved', 'rejected', 'closed'])),
    check('verification_request_links_check', sql`cardinality(links) <= 3`),
  ],
);

export const NOTICE_KINDS = ['takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification', 'post_answered', 'post_quoted', 'post_paid_requests', 'post_followup', 'followup_answered', 'chats_removal', 'post_ai_answer', 'visitor_ask_paused'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * An in-app notice (8.2, "通知"): no email, no push. `text` is the
 * administrator's words (a reason) when there are any; `params` (beyond 4)
 * carries what the page needs to word the notice in the reader's language.
 */
export const notice = pgTable(
  'notice',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<NoticeKind>().notNull(),
    text: text('text').notNull().default(''),
    params: jsonb('params').$type<Record<string, string | number | null>>().notNull().default({}),
    refId: uuid('ref_id'),
    readAt: timestampTz('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notice_user_idx').on(t.userId, t.createdAt),
    index('notice_unread_idx').on(t.userId).where(sql`read_at is null`),
    check('notice_kind_check', oneOf('kind', NOTICE_KINDS)),
  ],
);

/**
 * A full re-embed (2.5): every chunk gets the candidate model's vector,
 * tagged with the job's `space`, in its spare slot while retrieval stays on
 * the old space; the last step enables the candidate with that space, one
 * row. One running job at a time. `done` and `total` count chunks.
 */
export const reembedJob = pgTable(
  'reembed_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromModelConfigId: uuid('from_model_config_id'),
    toModelConfigId: uuid('to_model_config_id')
      .notNull()
      .references(() => modelConfig.id),
    status: text('status').$type<'running' | 'done' | 'failed'>().notNull().default('running'),
    total: integer('total').notNull().default(0),
    done: integer('done').notNull().default(0),
    /** The embedding space the candidate's vectors are tagged with: new per job, or the failed job's it resumes. */
    space: uuid('space').notNull(),
    /** Sources stored while the job runs; the switch only happens if none arrived since its last look. */
    arrived: integer('arrived').notNull().default(0),
    /** Beyond 4: why it failed, and who started it. */
    error: text('error'),
    startedBy: uuid('started_by'),
    startedAt: timestampTz('started_at').notNull().defaultNow(),
    /** Beyond 4: the last time a step saved progress, so a stalled job is picked up again. */
    heartbeatAt: timestampTz('heartbeat_at'),
    finishedAt: timestampTz('finished_at'),
  },
  (t) => [
    uniqueIndex('reembed_job_running_key').on(t.status).where(sql`status = 'running'`),
    check('reembed_job_status_check', oneOf('status', ['running', 'done', 'failed'])),
  ],
);

/**
 * Beyond 4: one model call, for the overview's "本月调用次数与估算成本"
 * (2.5, 7: usage goes to logs and the cost board, never to the bill).
 */
export const modelCall = pgTable(
  'model_call',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<'generation' | 'embedding' | 'transcription'>().notNull(),
    model: text('model').notNull(),
    configId: uuid('config_id'),
    configName: text('config_name'),
    userId: uuid('user_id'),
    audience: text('audience').$type<'free' | 'plan'>(),
    purpose: text('purpose').$type<CallPurpose>(),
    status: text('status').$type<CallStatus>().notNull().default('unknown'),
    durationMs: integer('duration_ms'),
    usageKnown: boolean('usage_known').notNull().default(false),
    endpoint: text('endpoint'),
    requestId: text('request_id'),
    errorCode: text('error_code'),
    costUsd: text('cost_usd'),
    costBasis: text('cost_basis').$type<CostBasis>().notNull().default('unresolved'),
    rate: jsonb('rate').$type<ProviderRate>(),
    priceRevision: text('price_revision'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Transcription: seconds of audio. */
    seconds: integer('seconds').notNull().default(0),
    /** The attempt's place in its kind's list (0: the primary); null when the environment's model answered. */
    chainPosition: integer('chain_position'),
    createdAt: createdAt(),
  },
  (t) => [
    index('model_call_time_idx').on(t.createdAt),
    index('model_call_generation_time_idx').on(t.createdAt, t.id).where(sql`kind = 'generation'`),
    check('model_call_status_check', oneOf('status', ['unknown', 'succeeded', 'failed', 'aborted'])),
    check('model_call_audience_check', sql`audience is null or audience in ('free', 'plan')`),
    check('model_call_cost_basis_check', oneOf('cost_basis', ['unresolved', 'provider_reported', 'configured_rate', 'estimated'])),
    check('model_call_kind_check', oneOf('kind', ['generation', 'embedding', 'transcription'])),
  ],
);

/* ------------------------------------------------------ payouts, 2.3 (step 6) */

export const KYC_STATUSES = ['pending', 'verified', 'rejected', 'reset'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

/**
 * One identity submission, reviewed by hand (2.3, 2.5 "KYC 记录"). A user's
 * current state is their newest row. "要求重新验证" stamps `reset_at` on the
 * newest row and adds a `reset` row that carries only the reason; the user
 * then submits again. Images live in private Blob under `kyc/<user>/` and are
 * deleted 30 days after the decision or the reset (`files_deleted_at`); the
 * metadata stays.
 */
export const kycRecord = pgTable(
  'kyc_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    /** Only `manual` today; a third-party provider adds a value, history stays valid (2.3). */
    provider: text('provider').$type<'manual'>().notNull().default('manual'),
    status: text('status').$type<KycStatus>().notNull().default('pending'),
    legalName: text('legal_name'),
    country: text('country'),
    documentKind: text('document_kind').$type<'passport' | 'id' | 'residence'>(),
    documentLast4: text('document_last4'),
    /** The document's expiry date, a calendar day. */
    documentExpires: text('document_expires'),
    taxForm: text('tax_form').$type<'W-8BEN' | 'W-9'>(),
    /** When the user declared the tax form submitted, and agreed to the purpose and retention. */
    taxDeclaredAt: timestampTz('tax_declared_at'),
    consentAt: timestampTz('consent_at'),
    documentBlob: text('document_blob'),
    selfieBlob: text('selfie_blob'),
    filesDeletedAt: timestampTz('files_deleted_at'),
    /** A rejection's reason, or on a `reset` row why re-verification was asked for. */
    reason: text('reason'),
    reviewedBy: uuid('reviewed_by'),
    decidedAt: timestampTz('decided_at'),
    /** Superseded by a re-verification request at this time. */
    resetAt: timestampTz('reset_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('kyc_record_user_idx').on(t.userId, t.createdAt),
    index('kyc_record_status_idx').on(t.status, t.createdAt),
    index('kyc_record_files_idx').on(t.createdAt).where(sql`files_deleted_at is null and (document_blob is not null or selfie_blob is not null)`),
    check('kyc_record_provider_check', oneOf('provider', ['manual'])),
    check('kyc_record_status_check', oneOf('status', KYC_STATUSES)),
    check('kyc_record_document_kind_check', sql`document_kind is null or document_kind in ('passport', 'id', 'residence')`),
    check('kyc_record_tax_form_check', sql`tax_form is null or tax_form in ('W-8BEN', 'W-9')`),
    check('kyc_record_expires_check', sql`document_expires is null or document_expires ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
    /* A submission carries every field; only a `reset` row is a bare reason. */
    check(
      'kyc_record_submission_check',
      sql`status = 'reset' or (legal_name is not null and country is not null and document_kind is not null and document_last4 is not null and document_expires is not null and tax_form is not null and tax_declared_at is not null and consent_at is not null)`,
    ),
  ],
);

export const PAYOUT_STATUSES = ['pending', 'approved', 'rejected', 'paid', 'failed'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * A manual PayPal payout (2.3): the requested earned credits are held at
 * once (`hold_id`), an administrator approves or rejects, sends the money
 * outside the system and records the transfer, or marks it failed. Rejection
 * and failure release the hold; payment settles it. `pending` and `approved`
 * are in progress, and a user has at most one of those.
 */
export const payout = pgTable(
  'payout',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    credits: bigint('credits', { mode: 'number' }).notNull(),
    /** The PayPal address at request time, which is where the money goes. */
    paypalEmail: text('paypal_email').notNull(),
    status: text('status').$type<PayoutStatus>().notNull().default('pending'),
    holdId: uuid('hold_id').references(() => creditHold.id),
    /** The verified identity the request was made under. */
    kycRecordId: uuid('kyc_record_id').references(() => kycRecord.id),
    /** The reviewer's note: required on a rejection. */
    reviewNote: text('review_note'),
    reviewedBy: uuid('reviewed_by'),
    reviewedAt: timestampTz('reviewed_at'),
    transferId: text('transfer_id'),
    /** What reached the user, in US cents; the rest of the request is PayPal's fee. */
    paidCents: integer('paid_cents'),
    feeCredits: bigint('fee_credits', { mode: 'number' }),
    failureReason: text('failure_reason'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestampTz('resolved_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('payout_open_key').on(t.userId).where(sql`status in ('pending', 'approved')`),
    /* One PayPal transfer pays one request; the check before the write is not enough on its own. */
    uniqueIndex('payout_transfer_key').on(t.transferId).where(sql`transfer_id is not null`),
    index('payout_user_idx').on(t.userId, t.createdAt),
    index('payout_status_idx').on(t.status, t.createdAt),
    check('payout_status_check', oneOf('status', PAYOUT_STATUSES)),
    check('payout_credits_check', sql`credits > 0`),
    check('payout_paid_check', sql`(status = 'paid') = (paid_cents is not null and transfer_id is not null)`),
    check('payout_paid_cents_check', sql`paid_cents is null or (paid_cents > 0 and paid_cents::bigint * 100 <= credits)`),
    check('payout_fee_check', sql`fee_credits is null or (fee_credits >= 0 and fee_credits = credits - paid_cents::bigint * 100)`),
  ],
);

/* ------------------------------------------------------------- step 7 */

/**
 * A Ree's 15-second introduction (2.6): the four shots' text, the template,
 * accent, aspect and music switch. `generated` turns true with the first
 * script and the video exists from then on; `revision` counts saves (the
 * editor sends it back, so two tabs cannot overwrite each other);
 * `exports_count` is how many exports were paid for or used the free one,
 * which decides whether the next is free. Cache hits never count.
 */
export const reeVideo = pgTable(
  'ree_video',
  {
    reeId: uuid('ree_id')
      .primaryKey()
      .references(() => ree.id, { onDelete: 'cascade' }),
    generated: boolean('generated').notNull().default(false),
    revision: integer('revision').notNull().default(0),
    template: text('template').$type<(typeof VIDEO_TEMPLATES)[number]>().notNull().default('product-demo'),
    accentColor: text('accent_color').notNull().default('#127ee3'),
    aspect: text('aspect').$type<'16:9' | '9:16'>().notNull().default('16:9'),
    music: boolean('music').notNull().default(true),
    scenes: jsonb('scenes').$type<import('@/lib/domain/video').VideoScenes>(),
    exportsCount: integer('exports_count').notNull().default(0),
    /** Beyond 4: when the current script was generated. */
    generatedAt: timestampTz('generated_at'),
    createdAt: createdAt(),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('ree_video_template_check', oneOf('template', VIDEO_TEMPLATES)),
    check('ree_video_aspect_check', oneOf('aspect', ['16:9', '9:16'])),
    check('ree_video_accent_check', sql`accent_color ~ '^#[0-9a-f]{6}$'`),
    check('ree_video_generated_check', sql`not generated or scenes is not null`),
  ],
);

/**
 * One MP4 export, rendered in the owner's browser and uploaded straight to
 * Blob (2.6). `content_version` is the hash of everything the render drew
 * (script, live Ree data, template, accent, aspect, music, composition
 * version): an export whose hash already has a `done` row is a cache hit and
 * gets no row of its own. A `started` row the browser never completed is
 * `abandoned` by the cron and its hold released.
 */
export const videoExport = pgTable(
  'video_export',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reeId: uuid('ree_id')
      .notNull()
      .references(() => ree.id, { onDelete: 'cascade' }),
    /** Beyond 4: who started it (whose credits were held). */
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    contentVersion: text('content_version').notNull(),
    template: text('template').$type<(typeof VIDEO_EXPORT_TEMPLATES)[number]>().notNull(),
    aspect: text('aspect').$type<'16:9' | '9:16'>().notNull(),
    status: text('status').$type<'started' | 'done' | 'abandoned'>().notNull().default('started'),
    /** The Blob pathname, served at `/media/<pathname>`. */
    blobUrl: text('blob_url'),
    /** Beyond 4: the uploaded file's size. */
    bytes: integer('bytes'),
    costCredits: integer('cost_credits').notNull().default(0),
    createdAt: createdAt(),
    finishedAt: timestampTz('finished_at'),
  },
  (t) => [
    uniqueIndex('video_export_done_key').on(t.reeId, t.contentVersion).where(sql`status = 'done'`),
    index('video_export_ree_idx').on(t.reeId, t.createdAt),
    index('video_export_started_idx').on(t.createdAt).where(sql`status = 'started'`),
    check('video_export_status_check', oneOf('status', ['started', 'done', 'abandoned'])),
    check('video_export_template_check', oneOf('template', VIDEO_EXPORT_TEMPLATES)),
    check('video_export_aspect_check', oneOf('aspect', ['16:9', '9:16'])),
    check('video_export_cost_check', sql`cost_credits >= 0`),
  ],
);

/** Immutable price versions. Historical Paddle IDs remain valid for renewals and delayed webhooks. */
export const billingPrice = pgTable('billing_price', {
  id: uuid('id').primaryKey().defaultRandom(),
  environment: text('environment').$type<'sandbox' | 'production'>().notNull(),
  kind: text('kind').$type<'plan' | 'pack'>().notNull(),
  priceMinor: integer('price_minor').notNull(),
  credits: integer('credits'),
  paddlePriceId: text('paddle_price_id').notNull(),
  promotionPriceMinor: integer('promotion_price_minor'),
  promotionStartsAt: timestampTz('promotion_starts_at'),
  promotionEndsAt: timestampTz('promotion_ends_at'),
  enabled: boolean('enabled').notNull().default(true),
  updatedBy: uuid('updated_by').references(() => administrator.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('billing_price_current_key').on(t.environment, t.kind).where(sql`enabled`),
  index('billing_price_paddle_idx').on(t.paddlePriceId),
  check('billing_price_environment_check', oneOf('environment', ['sandbox', 'production'])),
  check('billing_price_kind_check', oneOf('kind', ['plan', 'pack'])),
  check('billing_price_amount_check', sql`price_minor between 1 and 100000000`),
  check('billing_price_credits_check', sql`credits between 1 and 100000000`),
  check('billing_price_promotion_check', sql`(promotion_price_minor is null and promotion_starts_at is null and promotion_ends_at is null) or (promotion_price_minor is not null and promotion_starts_at is not null and promotion_ends_at is not null and promotion_price_minor > 0 and promotion_price_minor < price_minor and promotion_starts_at < promotion_ends_at)`),
]);

/** The registration gift is independent of the payment provider and only affects future sign-ups. */
export const signupReward = pgTable('signup_reward', {
  id: integer('id').primaryKey().default(1),
  credits: integer('credits').notNull(),
  revision: uuid('revision').notNull().defaultRandom(),
  updatedBy: uuid('updated_by').references(() => administrator.id),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
}, () => [
  check('signup_reward_singleton_check', sql`id = 1`),
  check('signup_reward_credits_check', sql`credits between 0 and 100000000`),
]);

/**
 * Our infrastructure rates (docs/audit/credit-import-audit.md P4), edited on
 * 价格与促销. Append-only like `billing_price`: each save adds a row from
 * `effective_from` on, so storage already accrued keeps the rate it accrued
 * at. The latest row applies; with none, `DEFAULT_INFRA_COST_RATES`. Every
 * rate is above zero and the index factor at least 1, so nothing can be
 * billed below cost.
 */
export const infraCostRates = pgTable('infra_cost_rates', {
  id: uuid('id').primaryKey().defaultRandom(),
  transferPerGb: numeric('transfer_per_gb', { precision: 20, scale: 12 }).notNull(),
  blobStoragePerGbMonth: numeric('blob_storage_per_gb_month', { precision: 20, scale: 12 }).notNull(),
  databaseStoragePerGbMonth: numeric('database_storage_per_gb_month', { precision: 20, scale: 12 }).notNull(),
  databaseIndexFactor: numeric('database_index_factor', { precision: 7, scale: 4 }).notNull(),
  chunkRowBytes: integer('chunk_row_bytes').notNull(),
  effectiveFrom: timestampTz('effective_from').notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => administrator.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [
  index('infra_cost_rates_effective_idx').on(t.effectiveFrom),
  check('infra_cost_rates_positive_check', sql`transfer_per_gb > 0 and blob_storage_per_gb_month > 0 and database_storage_per_gb_month > 0`),
  check('infra_cost_rates_factor_check', sql`database_index_factor >= 1 and database_index_factor <= 100`),
  check('infra_cost_rates_overhead_check', sql`chunk_row_bytes between 1 and 100000`),
]);

/** The flat video script charge, shared by standard scripts and narrated demos. */
export const videoPricing = pgTable('video_pricing', {
  id: integer('id').primaryKey().default(1),
  scriptCredits: integer('script_credits').notNull(),
  revision: uuid('revision').notNull().defaultRandom(),
  updatedBy: uuid('updated_by').references(() => administrator.id),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
}, () => [
  check('video_pricing_singleton_check', sql`id = 1`),
  check('video_pricing_script_credits_check', sql`script_credits between 1 and 100000000`),
]);

/** The charge for new MP4 exports after a Ree's first successful export. */
export const videoExportPricing = pgTable('video_export_pricing', {
  id: integer('id').primaryKey().default(1),
  credits: integer('credits').notNull(),
  revision: uuid('revision').notNull().defaultRandom(),
  updatedBy: uuid('updated_by').references(() => administrator.id),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
}, () => [
  check('video_export_pricing_singleton_check', sql`id = 1`),
  check('video_export_pricing_credits_check', sql`credits between 1 and 100000000`),
]);

/**
 * Beyond 4: anonymous chat's daily caps, once set in the console's pricing
 * page: per browser, per Ree, over the platform, per client address, and
 * the attempts factor. Nothing reads or writes it since anonymous chat and
 * its form went (2026-11); kept as it was.
 */
export const anonymousChatSettings = pgTable('anonymous_chat_settings', {
  id: integer('id').primaryKey().default(1),
  reeRoundsPerDay: integer('ree_rounds_per_day').notNull(),
  platformRoundsPerDay: integer('platform_rounds_per_day').notNull(),
  ipRoundsPerDay: integer('ip_rounds_per_day').notNull(),
  visitorRoundsPerDay: integer('visitor_rounds_per_day').notNull().default(10),
  attemptsFactor: integer('attempts_factor').notNull().default(2),
  revision: uuid('revision').notNull().defaultRandom(),
  updatedBy: uuid('updated_by').references(() => administrator.id),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
}, () => [
  check('anonymous_chat_settings_singleton_check', sql`id = 1`),
  check('anonymous_chat_settings_limits_check', sql`ree_rounds_per_day between 1 and 10000000 and platform_rounds_per_day between 1 and 10000000 and ip_rounds_per_day between 1 and 10000000`),
  check('anonymous_chat_settings_visitor_check', sql`visitor_rounds_per_day between 1 and 1000 and attempts_factor between 1 and 10`),
]);

/**
 * The site-wide payout minimum, as an administrator sets it on the console's
 * payout review page. No row means `PAYOUT_MIN_CREDITS`. An account's own
 * `user.payout_min_credits`, when set, replaces it for that account.
 */
export const payoutSettings = pgTable('payout_settings', {
  id: integer('id').primaryKey().default(1),
  minCredits: integer('min_credits').notNull(),
  revision: uuid('revision').notNull().defaultRandom(),
  updatedBy: uuid('updated_by').references(() => administrator.id, { onDelete: 'set null' }),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
}, () => [
  check('payout_settings_singleton_check', sql`id = 1`),
  check('payout_settings_min_check', sql`min_credits between 1 and 100000000`),
]);

/**
 * What earned credits may do besides a payout (docs/design/earned-credits.md),
 * as an administrator sets it on the console's pricing page. No row means
 * `EARNED_DEFAULTS`. Conversion turns earned credits into Pack credits at
 * `convert_rate_bp` / 10,000; a deduction pays `deduct_credits_per_cent`
 * earned credits for each US cent of a Plan or Pack, at most
 * `deduct_max_percent` of the price, and leaves either nothing or at least
 * `deduct_min_charge_minor` to pay through Paddle.
 */
export const earnedSettings = pgTable('earned_settings', {
  id: integer('id').primaryKey().default(1),
  convertEnabled: boolean('convert_enabled').notNull(),
  convertRateBp: integer('convert_rate_bp').notNull(),
  convertMinCredits: integer('convert_min_credits').notNull(),
  deductEnabled: boolean('deduct_enabled').notNull(),
  deductCreditsPerCent: integer('deduct_credits_per_cent').notNull(),
  deductMaxPercent: integer('deduct_max_percent').notNull(),
  deductMinChargeMinor: integer('deduct_min_charge_minor').notNull(),
  revision: uuid('revision').notNull().defaultRandom(),
  updatedBy: uuid('updated_by').references(() => administrator.id, { onDelete: 'set null' }),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
}, () => [
  check('earned_settings_singleton_check', sql`id = 1`),
  check('earned_settings_convert_check', sql`convert_rate_bp between 1 and 100000 and convert_min_credits between 1 and 100000000`),
  check('earned_settings_deduct_check', sql`deduct_credits_per_cent between 1 and 1000000 and deduct_max_percent between 1 and 100 and deduct_min_charge_minor between 70 and 100000`),
]);

/* ------------------------------------------------------------ invitations */

/**
 * Invitations, new-user tasks and daily check-ins (docs/design/invitations.md),
 * as an administrator sets them on the console's 邀请与任务 page. No row
 * means the defaults in lib/constants.ts. Every amount 0 to 100,000,000 (0
 * turns that reward off). `withdrawable_invites` is the site-wide number of
 * invited registrations whose reward is withdrawable; later ones are paid
 * the same amount as gift credits.
 */
export const rewardSettings = pgTable('reward_settings', {
  id: integer('id').primaryKey().default(1),
  invitesEnabled: boolean('invites_enabled').notNull(),
  withdrawableInvites: integer('withdrawable_invites').notNull(),
  /** Per inviter: at most this many of their invitations pay a withdrawable reward; later ones pay gift credits. */
  withdrawableInvitesPerInviter: integer('withdrawable_invites_per_inviter').notNull(),
  inviteCredits: integer('invite_credits').notNull(),
  firstReeCredits: integer('first_ree_credits').notNull(),
  /** Retired with their tasks (TASK_KINDS): read by nothing, defaulted so a save need not write them. Drop once no deployment reads them. */
  firstQuestionCredits: integer('first_question_credits').notNull().default(1000),
  firstCommentCredits: integer('first_comment_credits').notNull().default(1000),
  firstPostCredits: integer('first_post_credits').notNull().default(1000),
  firstHelpfulCredits: integer('first_helpful_credits').notNull().default(1000),
  checkInCredits: integer('check_in_credits').notNull(),
  checkInMaxDays: integer('check_in_max_days').notNull(),
  checkInWindowMonths: integer('check_in_window_months').notNull(),
  revision: uuid('revision').notNull().defaultRandom(),
  updatedBy: uuid('updated_by').references(() => administrator.id, { onDelete: 'set null' }),
  updatedAt: timestampTz('updated_at').notNull().defaultNow(),
}, () => [
  check('reward_settings_singleton_check', sql`id = 1`),
  check('reward_settings_quota_check', sql`withdrawable_invites between 0 and 10000000 and withdrawable_invites_per_inviter between 0 and 1000000`),
  check(
    'reward_settings_credits_check',
    sql`invite_credits between 0 and 100000000 and first_ree_credits between 0 and 100000000 and first_question_credits between 0 and 100000000 and first_comment_credits between 0 and 100000000 and first_post_credits between 0 and 100000000 and first_helpful_credits between 0 and 100000000 and check_in_credits between 0 and 100000000`,
  ),
  check('reward_settings_check_in_check', sql`check_in_max_days between 0 and 3650 and check_in_window_months between 1 and 120`),
]);

/** Each account's one invite code: created with the account, or on first read for accounts older than invitations. */
export const inviteCode = pgTable(
  'invite_code',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invite_code_code_key').on(t.code), check('invite_code_code_check', sql`code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$'`)],
);

/**
 * One row per attributed registration: who invited whom, through which code,
 * the credits the inviter was paid (0 when the reward was off) and whether
 * they were withdrawable. Written in the registration transaction under the
 * quota's lock; the count of withdrawable rows is what the quota measures.
 */
export const invitation = pgTable(
  'invitation',
  {
    /* No cascade, as with the ledger: a row here is a paid reward and a place in the withdrawable quota. */
    inviteeId: uuid('invitee_id')
      .primaryKey()
      .references(() => user.id),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => user.id),
    code: text('code').notNull(),
    rewardCredits: integer('reward_credits').notNull(),
    withdrawable: boolean('withdrawable').notNull(),
    /** Why a paid reward was gift credits: the site-wide quota was used up, or the inviter's own cap was reached. */
    giftReason: text('gift_reason').$type<'site_quota' | 'inviter_cap'>(),
    createdAt: createdAt(),
  },
  (t) => [
    index('invitation_inviter_idx').on(t.inviterId, t.createdAt),
    check('invitation_self_check', sql`invitee_id <> inviter_id`),
    check('invitation_reward_check', sql`reward_credits >= 0 and (reward_credits > 0 or not withdrawable)`),
    check('invitation_gift_reason_check', sql`gift_reason is null or (gift_reason in ('site_quota', 'inviter_cap') and not withdrawable and reward_credits > 0)`),
  ],
);

/**
 * A daily check-in: at most one per account and calendar day (UTC+8,
 * `CHECK_IN_TIME_ZONE`), each paid as gift credits in the same transaction.
 */
export const checkIn = pgTable(
  'check_in',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    day: date('day').notNull(),
    credits: integer('credits').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('check_in_user_day_key').on(t.userId, t.day), check('check_in_credits_check', sql`credits > 0`)],
);

/**
 * A new-user task paid: at most one row per account and task, so a retry or
 * a race never pays twice. `ref_id` is what completed it (the Ree, the
 * post, the post or answer marked helpful; for the retired tasks the
 * question or the comment); it is kept when that is later deleted.
 */
export const taskReward = pgTable(
  'task_reward',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    task: text('task').$type<TaskKind>().notNull(),
    credits: integer('credits').notNull(),
    refId: uuid('ref_id'),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.task] }),
    check('task_reward_task_check', oneOf('task', TASK_KINDS)),
    check('task_reward_credits_check', sql`credits > 0`),
  ],
);

/**
 * Beyond 4: the share page `/s/[slug]` -- a visit, or a conversion: what
 * the visitor asked from it. `visitor_id` is the random id of the
 * `re0_visitor` cookie (no IP, no user agent); the owner's own visits are
 * not recorded. A visit holds its half-hour `visit_slot`, so one visitor
 * counts once per slot even when two tabs open at once. Since the chat
 * pages went (2026-11-20) a conversion is a post published from the share
 * page (`kind = 'post'`, one per post and Ree); the `conversation` ones stay
 * as they were counted, without the conversation (dropped by migration 0069).
 */
export const reeShareEvent = pgTable(
  'ree_share_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reeId: uuid('ree_id')
      .notNull()
      .references(() => ree.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'visit' | 'conversation' | 'post'>().notNull(),
    visitorId: text('visitor_id').notNull(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    /** `post` conversions (2026-11-20): the post published from the share page, which asked this Ree. */
    postId: uuid('post_id').references((): AnyPgColumn => post.id, { onDelete: 'set null' }),
    /** Visits only: `floor(epoch seconds / 1800)`. */
    visitSlot: integer('visit_slot'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ree_share_event_ree_idx').on(t.reeId, t.kind, t.createdAt),
    index('ree_share_event_visitor_idx').on(t.visitorId, t.reeId, t.createdAt),
    uniqueIndex('ree_share_event_post_key').on(t.postId, t.reeId).where(sql`kind = 'post'`),
    uniqueIndex('ree_share_event_visit_key').on(t.visitorId, t.reeId, t.visitSlot).where(sql`kind = 'visit'`),
    check('ree_share_event_kind_check', oneOf('kind', ['visit', 'conversation', 'post'])),
    check('ree_share_event_visit_slot_check', sql`(kind = 'visit') = (visit_slot is not null)`),
  ],
);

/* -------------------------------------------------------------- Traffic */

/**
 * Site-wide traffic (console 「流量」, lib/services/traffic.ts): one row per
 * page view the root layout's beacon reports, kept `TRAFFIC_RETENTION_DAYS`.
 * A visitor is the share page's `re0_visitor` cookie id; no IP and no user
 * agent is stored, and of the referrer only its host. `source` is the
 * visit's, decided on its landing view and copied onto later ones; `path`
 * has no query and no language prefix (lib/domain/traffic.ts).
 */
export const siteView = pgTable(
  'site_view',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    visitorId: text('visitor_id').notNull(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    pageKind: text('page_kind').$type<PageKind>().notNull(),
    landing: boolean('landing').notNull(),
    source: text('source').notNull(),
    referrerHost: text('referrer_host'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    createdAt: createdAt(),
  },
  (t) => [
    index('site_view_visitor_idx').on(t.visitorId, t.createdAt),
    index('site_view_created_idx').on(t.createdAt),
    check('site_view_page_kind_check', oneOf('page_kind', PAGE_KINDS)),
    check('site_view_path_check', sql`char_length(path) between 1 and 300`),
    check('site_view_source_check', sql`char_length(source) between 1 and 100`),
  ],
);

/**
 * Finished days of `site_view`, rolled up by the daily cron
 * (`/api/cron/traffic`) and kept for good. Each day has a row per grouping
 * set: `source` and `page_kind` are `''` where the row covers all of them,
 * so `('', '')` is the day's exact total and visitors are exact per row
 * (never summed over sources or kinds). `visits` counts landing views.
 */
export const siteTrafficDay = pgTable(
  'site_traffic_day',
  {
    day: date('day', { mode: 'string' }).notNull(),
    source: text('source').notNull(),
    pageKind: text('page_kind').notNull(),
    views: integer('views').notNull(),
    visitors: integer('visitors').notNull(),
    visits: integer('visits').notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.source, t.pageKind] })],
);

/** Landing views per finished day, source and page, for 「落地页」. */
export const siteTrafficLanding = pgTable(
  'site_traffic_landing',
  {
    day: date('day', { mode: 'string' }).notNull(),
    source: text('source').notNull(),
    path: text('path').notNull(),
    pageKind: text('page_kind').notNull(),
    visits: integer('visits').notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.source, t.path] })],
);

/** The days the rollup has finished: their figures come from the two tables above, not from `site_view`. */
export const siteTrafficRollup = pgTable('site_traffic_rollup', {
  day: date('day', { mode: 'string' }).primaryKey(),
  rolledAt: timestampTz('rolled_at').notNull().defaultNow(),
});

/**
 * Crawler and infrastructure traffic (console 「流量」 → 「爬虫 / 基础设施」,
 * lib/services/crawler-traffic.ts): read once a day from Vercel
 * Observability by the cron `/api/cron/crawler-traffic`, never counted on
 * the request path. Per finished UTC+8 day, CDN requests, function
 * invocations and Fast Origin Transfer bytes by crawler family and agent
 * name (lib/domain/crawler-traffic.ts). People's browsers are one row per
 * day, `human` with agent `''`: no person's user agent is stored.
 */
export const crawlerTrafficDay = pgTable(
  'crawler_traffic_day',
  {
    day: date('day', { mode: 'string' }).notNull(),
    family: text('family').$type<CrawlerFamily>().notNull(),
    agent: text('agent').notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull(),
    invocations: bigint('invocations', { mode: 'number' }).notNull(),
    originBytes: bigint('origin_bytes', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.family, t.agent] }),
    check('crawler_traffic_day_family_check', oneOf('family', CRAWLER_FAMILIES)),
    check('crawler_traffic_day_agent_check', sql`char_length(agent) <= 60`),
  ],
);

/**
 * The same figures per day and route (`/r/[slug]`, `/login` …). `family`
 * `''` is the route's total; the families' rows come from the top
 * route-and-agent pairs, so they may add up to less than it.
 */
export const crawlerRouteDay = pgTable(
  'crawler_route_day',
  {
    day: date('day', { mode: 'string' }).notNull(),
    route: text('route').notNull(),
    family: text('family').notNull(),
    requests: bigint('requests', { mode: 'number' }).notNull(),
    invocations: bigint('invocations', { mode: 'number' }).notNull(),
    originBytes: bigint('origin_bytes', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.route, t.family] }), check('crawler_route_day_route_check', sql`char_length(route) <= 300`)],
);

/** The days fetched from Observability: their figures are in the two tables above. */
export const crawlerTrafficFetch = pgTable('crawler_traffic_fetch', {
  day: date('day', { mode: 'string' }).primaryKey(),
  fetchedAt: timestampTz('fetched_at').notNull().defaultNow(),
});

/**
 * Vercel billing charges of this project (`project`) and of the team itself
 * (`team`: its plan and seats), per billing day (US Pacific, as Vercel cuts
 * them) and service, in USD. The cron replaces the last few days on every
 * run, since Vercel may still revise them.
 */
export const infraChargeDay = pgTable(
  'infra_charge_day',
  {
    day: date('day', { mode: 'string' }).notNull(),
    scope: text('scope').$type<ChargeScope>().notNull(),
    service: text('service').notNull(),
    cost: numeric('cost', { precision: 18, scale: 8 }).notNull(),
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    unit: text('unit').notNull(),
    fetchedAt: timestampTz('fetched_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.day, t.scope, t.service] }), check('infra_charge_day_scope_check', oneOf('scope', ['project', 'team']))],
);

/* ------------------------------------------------------------------ MCP */

/**
 * A user's API key for the MCP server (`/api/mcp`). The key itself
 * (`re0_sk_` + 64 hex) is shown once, at creation; only its SHA-256 digest
 * and last four characters are kept. Keys are revoked, never deleted, so
 * the questions they asked keep their tag.
 */
export const apiKey = pgTable(
  'api_key',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    keyDigest: text('key_digest').notNull(),
    keyTail: text('key_tail').notNull(),
    lastUsedAt: timestampTz('last_used_at'),
    expiresAt: timestampTz('expires_at'),
    revokedAt: timestampTz('revoked_at'),
    /**
     * What the key asked and spent through MCP conversations, frozen by
     * migration 0067 before PR B deletes them; its usage adds the private
     * posts asked through it (api-keys.ts `usageOf`).
     */
    legacyQuestions: integer('legacy_questions').notNull().default(0),
    legacySpent: integer('legacy_spent').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('api_key_digest_key').on(t.keyDigest),
    index('api_key_user_idx').on(t.userId, t.createdAt),
    check('api_key_name_check', sql`char_length(name) between 1 and 60`),
  ],
);

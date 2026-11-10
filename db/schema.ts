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
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import type { ReeDraft } from '@/lib/domain/ree';
import type { SocialContact } from '@/lib/domain/account';
import type { CitationSnapshot, Locator, SentenceCheck } from '@/lib/domain/answer';
import type { SynthesisSource } from '@/lib/domain/synthesis';
import type { Allocation } from '@/lib/domain/credits';
import type { ProviderCharge, ProviderRate } from '@/lib/domain/provider-cost';
import type { CallPurpose, CallStatus, CostBasis } from '@/lib/domain/model-calls';
import type { KnowledgeActivity, KnowledgeChild } from '@/lib/domain/knowledge';
import type { RoleMetrics } from '@/lib/domain/roles';
import type { ReeRank } from '@/lib/domain/explore';
import { REE_COMMENT_MAX_LENGTH } from '@/lib/domain/ree-comment';
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
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('user_provider_subject_key').on(t.provider, t.providerSubject),
    check('user_lang_check', oneOf('lang', ['zh', 'en'])),
    check('user_provider_check', oneOf('provider', ['google', 'github'])),
    check('user_role_check', oneOf('role', ['normal', 'verified', 'official'])),
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
    /** The explore ranking, materialised hourly by `/api/cron/rank` (4). */
    rank: jsonb('rank').$type<ReeRank>().notNull().default({}),
    /** Beyond 4: three example questions the system wrote after the first ready source, shown only once the owner adopts them (8.2). */
    suggestedQuestions: jsonb('suggested_questions').$type<string[]>().notNull().default([]),
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
      oneOf('category', ['technology', 'design', 'business', 'learning', 'professional', 'life', 'other']),
    ),
    check('ree_query_fee_check', sql`query_fee between 0 and 10000`),
    check('ree_tags_check', sql`cardinality(tags) <= 3`),
    /* A taken-down Ree is private until an administrator restores it, whoever writes the row (step 5). */
    check('ree_moderated_private_check', sql`moderated_at is null or not is_public`),
    check('ree_published_public_check', sql`not is_published or (is_public and moderated_at is null and deleted_at is null)`),
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
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    /**
     * Beyond 4: the candidate model's vector while a re-embed job runs (2.5).
     * Retrieval keeps reading `embedding`; the job's last step moves these
     * over in one statement and clears them.
     */
    embeddingNext: vector('embedding_next', { dimensions: 1536 }),
    locator: jsonb('locator').$type<Locator>().notNull().default({}),
  },
  (t) => [
    index('chunk_knowledge_idx').on(t.knowledgeId, t.ordinal),
    index('chunk_ree_idx').on(t.reeId),
    /*
     * No vector index: retrieval is an exact scan within one Ree (`+ 0` in
     * chat.ts / explore.ts keeps the planner off one), and an HNSW index made
     * every write -- above all the model switch's swap of every passage,
     * reembed.ts `finish` -- rebuild graph entries nobody reads (0038).
     */
  ],
);

export const conversation = pgTable(
  'conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    /** `mcp`: questions asked through the MCP server (`/api/mcp`), one Ree each; never in the web lists. */
    kind: text('kind').$type<'normal' | 'ree_test' | 'mcp'>().notNull().default('normal'),
    reeId: uuid('ree_id').references(() => ree.id),
    title: text('title').notNull().default(''),
    pinned: boolean('pinned').notNull().default(false),
    /** Archived since; a new question brings it back to Recent (8.2, "对话列表"). */
    archivedAt: timestampTz('archived_at'),
    /** In the trash since; purged with its messages 30 days later. */
    deletedAt: timestampTz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('conversation_user_idx').on(t.userId, t.updatedAt),
    index('conversation_trash_idx').on(t.deletedAt).where(sql`deleted_at is not null`),
    check('conversation_title_check', sql`char_length(title) <= 120`),
    uniqueIndex('conversation_ree_test_key')
      .on(t.userId, t.reeId)
      .where(sql`kind = 'ree_test'`),
    check('conversation_kind_check', oneOf('kind', ['normal', 'ree_test', 'mcp'])),
    check('conversation_ree_test_check', sql`(kind = 'ree_test') = (ree_id is not null)`),
  ],
);

export const conversationRee = pgTable(
  'conversation_ree',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    reeId: uuid('ree_id')
      .notNull()
      .references(() => ree.id),
    addedAt: timestampTz('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.reeId] })],
);

export const message = pgTable(
  'message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'ree'>().notNull(),
    reeId: uuid('ree_id').references(() => ree.id),
    content: text('content').notNull(),
    citations: jsonb('citations').$type<CitationSnapshot[]>().notNull().default([]),
    noAnswer: boolean('no_answer').notNull().default(false),
    noAnswerReason: text('no_answer_reason').$type<'no_sources' | 'out_of_scope'>(),
    requestId: uuid('request_id'),
    costCredits: integer('cost_credits').notNull().default(0),
    /** Beyond 4, on a question every asked Ree left unanswered: the public Rees suggested under it ("这些公开 Ree 可能知道"). */
    suggestedReeIds: jsonb('suggested_ree_ids').$type<string[]>().notNull().default([]),
    /** 回答核验, on an answer the asker had checked: one entry per sentence, where it sits and whether its passages back it. */
    checks: jsonb('checks').$type<SentenceCheck[]>().notNull().default([]),
    /** Null when no check was asked for; `failed` when it broke off and its fee went back. */
    checkState: text('check_state').$type<'done' | 'failed'>(),
    /** What the check was charged, apart from the answer's `cost_credits`. */
    checkCredits: integer('check_credits').notNull().default(0),
    /** On a question asked through the MCP server: the API key that asked it, for per-key usage. */
    apiKeyId: uuid('api_key_id').references((): AnyPgColumn => apiKey.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('message_conversation_idx').on(t.conversationId, t.createdAt),
    index('message_api_key_idx').on(t.apiKeyId, t.createdAt).where(sql`api_key_id is not null`),
    index('message_ree_idx').on(t.reeId, t.createdAt).where(sql`role = 'ree'`),
    check('message_role_check', oneOf('role', ['user', 'ree'])),
    check(
      'message_no_answer_reason_check',
      sql`no_answer_reason is null or no_answer_reason in ('no_sources', 'out_of_scope')`,
    ),
    check('message_check_state_check', sql`check_state is null or check_state in ('done', 'failed')`),
  ],
);

/**
 * 回答核验 tallies, one per completed check: what the owner's statistics
 * count. Kept apart from the reply so that clearing a test conversation,
 * which deletes its messages, leaves the figures as the answer counts are.
 */
export const answerCheck = pgTable(
  'answer_check',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reeId: uuid('ree_id')
      .notNull()
      .references(() => ree.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => message.id, { onDelete: 'set null' }),
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
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_grant_user_idx').on(t.userId),
    check('credit_grant_withdrawable_check', sql`withdrawable_at is null or source = 'earned'`),
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
    kind: text('kind').$type<'chat' | 'knowledge' | 'video' | 'payout'>().notNull(),
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
    check('credit_hold_kind_check', oneOf('kind', ['chat', 'knowledge', 'video', 'payout'])),
    check('credit_hold_status_check', oneOf('status', ['held', 'settled', 'released'])),
  ],
);

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
    lastProbeAt: timestampTz('last_probe_at'),
    lastProbeOk: boolean('last_probe_ok'),
    updatedBy: uuid('updated_by'),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
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
    paddleTransactionId: text('paddle_transaction_id').notNull(),
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
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('purchase_paddle_transaction_key').on(t.paddleTransactionId),
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
    createdAt: createdAt(),
  },
  (t) => [index('paddle_checkout_user_idx').on(t.userId, t.kind, t.createdAt), check('paddle_checkout_kind_check', oneOf('kind', ['plan', 'pack']))],
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

/* ------------------------------------------------- step 4: conversations, explore */

/** "有用 / 没用" on one Ree answer (2.4), one vote per user; voting the same way again takes it back. */
export const reeFeedback = pgTable(
  'ree_feedback',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    vote: text('vote').$type<'up' | 'down'>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] }), check('ree_feedback_vote_check', oneOf('vote', ['up', 'down']))],
);

/**
 * Ree 圆桌 (ree-council-proposal.md 4.3): one synthesis per question, kept
 * apart from `message` so every count of Ree answers, answer rates and
 * income stays as it is, and so no Ree ever sees it in its history.
 * `request_id` is the question; clearing the conversation removes it. A
 * `running` row is a synthesis being written (or one that died, once it is
 * older than SYNTHESIS_STALE_MS); a failed one is deleted.
 */
export const synthesis = pgTable(
  'synthesis',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => message.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    status: text('status').$type<'running' | 'done'>().notNull().default('running'),
    content: text('content').notNull().default(''),
    /** The Rees whose answers went in, lettered A, B, C in this order. */
    reeIds: jsonb('ree_ids').$type<string[]>().notNull().default([]),
    /** The kept markers, mapped back to the answers and citation snapshots. */
    sources: jsonb('sources').$type<SynthesisSource[]>().notNull().default([]),
    costCredits: integer('cost_credits').notNull().default(0),
    model: text('model'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('synthesis_request_key').on(t.requestId),
    index('synthesis_conversation_idx').on(t.conversationId),
    check('synthesis_status_check', oneOf('status', ['running', 'done'])),
  ],
);

/** "有用 / 没用" on a synthesis; never counted toward any Ree's rating. */
export const synthesisFeedback = pgTable(
  'synthesis_feedback',
  {
    synthesisId: uuid('synthesis_id')
      .notNull()
      .references(() => synthesis.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    vote: text('vote').$type<'up' | 'down'>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.synthesisId, t.userId] }), check('synthesis_feedback_vote_check', oneOf('vote', ['up', 'down']))],
);

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

export const NOTICE_KINDS = ['takedown', 'restore', 'credits_adjust', 'kyc', 'payout', 'role', 'verification'] as const;
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
 * A full re-embed (2.5): every chunk gets the candidate model's vector in
 * `chunk.embedding_next` while retrieval stays on the old one; the last step
 * swaps both columns and the enabled entry in one transaction. One running
 * job at a time. `done` and `total` count chunks.
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
 * Beyond 4: the share page `/s/[slug]` -- a visit, or a conversation the
 * visitor started or joined from it. `visitor_id` is the random id of the
 * `re0_visitor` cookie (no IP, no user agent); the owner's own visits are
 * not recorded. A visit holds its half-hour `visit_slot`, so one visitor
 * counts once per slot even when two tabs open at once; one conversion per
 * conversation and Ree.
 */
export const reeShareEvent = pgTable(
  'ree_share_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reeId: uuid('ree_id')
      .notNull()
      .references(() => ree.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'visit' | 'conversation'>().notNull(),
    visitorId: text('visitor_id').notNull(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversation.id, { onDelete: 'set null' }),
    /** Visits only: `floor(epoch seconds / 1800)`. */
    visitSlot: integer('visit_slot'),
    createdAt: createdAt(),
  },
  (t) => [
    index('ree_share_event_ree_idx').on(t.reeId, t.kind, t.createdAt),
    index('ree_share_event_visitor_idx').on(t.visitorId, t.reeId, t.createdAt),
    uniqueIndex('ree_share_event_conversation_key').on(t.conversationId, t.reeId).where(sql`kind = 'conversation'`),
    uniqueIndex('ree_share_event_visit_key').on(t.visitorId, t.reeId, t.visitSlot).where(sql`kind = 'visit'`),
    check('ree_share_event_kind_check', oneOf('kind', ['visit', 'conversation'])),
    check('ree_share_event_visit_slot_check', sql`(kind = 'visit') = (visit_slot is not null)`),
  ],
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
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('api_key_digest_key').on(t.keyDigest),
    index('api_key_user_idx').on(t.userId, t.createdAt),
    check('api_key_name_check', sql`char_length(name) between 1 and 60`),
  ],
);

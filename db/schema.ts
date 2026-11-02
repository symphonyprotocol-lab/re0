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
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import type { ReeDraft } from '@/lib/domain/ree';
import type { CitationSnapshot, Locator } from '@/lib/domain/answer';
import type { Allocation } from '@/lib/domain/credits';
import type { KnowledgeActivity, KnowledgeChild } from '@/lib/domain/knowledge';
import type { RoleMetrics } from '@/lib/domain/roles';
import type { ReeRank } from '@/lib/domain/explore';

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
    color: text('color').notNull().default('default'),
    category: text('category').notNull().default('other'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    systemPrompt: text('system_prompt').notNull().default(''),
    sampleQuestions: jsonb('sample_questions').$type<string[]>().notNull().default([]),
    isPublic: boolean('is_public').notNull().default(false),
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
    index('ree_public_idx').on(t.category, t.createdAt).where(sql`is_public and moderated_at is null and deleted_at is null`),
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
    index('chunk_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const conversation = pgTable(
  'conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    kind: text('kind').$type<'normal' | 'ree_test'>().notNull().default('normal'),
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
    check('conversation_kind_check', oneOf('kind', ['normal', 'ree_test'])),
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
    createdAt: createdAt(),
  },
  (t) => [
    index('message_conversation_idx').on(t.conversationId, t.createdAt),
    index('message_ree_idx').on(t.reeId, t.createdAt).where(sql`role = 'ree'`),
    check('message_role_check', oneOf('role', ['user', 'ree'])),
    check(
      'message_no_answer_reason_check',
      sql`no_answer_reason is null or no_answer_reason in ('no_sources', 'out_of_scope')`,
    ),
  ],
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
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_grant_user_idx').on(t.userId),
    uniqueIndex('credit_grant_purchase_key').on(t.purchaseId).where(sql`purchase_id is not null`),
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
    createdAt: createdAt(),
    closedAt: timestampTz('closed_at'),
  },
  (t) => [
    index('credit_hold_user_idx').on(t.userId, t.status),
    index('credit_hold_ref_idx').on(t.refId),
    check('credit_hold_kind_check', oneOf('kind', ['chat', 'knowledge', 'video', 'payout'])),
    check('credit_hold_status_check', oneOf('status', ['held', 'settled', 'released'])),
  ],
);

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

export const modelConfig = pgTable(
  'model_config',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: text('kind').$type<'generation' | 'embedding' | 'transcription'>().notNull(),
    transport: text('transport').$type<'gateway' | 'openai_compatible'>().notNull(),
    baseUrl: text('base_url'),
    model: text('model').notNull(),
    apiKeyCipher: text('api_key_cipher'),
    apiKeyTail: text('api_key_tail'),
    timeoutMs: integer('timeout_ms').notNull().default(60000),
    enabled: boolean('enabled').notNull().default(false),
    lastProbeAt: timestampTz('last_probe_at'),
    lastProbeOk: boolean('last_probe_ok'),
    updatedBy: uuid('updated_by'),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('model_config_one_enabled_key').on(t.kind).where(sql`enabled`),
    check('model_config_kind_check', oneOf('kind', ['generation', 'embedding', 'transcription'])),
    check('model_config_transport_check', oneOf('transport', ['gateway', 'openai_compatible'])),
    check(
      'model_config_base_url_check',
      sql`(transport = 'openai_compatible') = (base_url is not null)`,
    ),
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
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Transcription: seconds of audio. */
    seconds: integer('seconds').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('model_call_time_idx').on(t.createdAt),
    check('model_call_kind_check', oneOf('kind', ['generation', 'embedding', 'transcription'])),
  ],
);

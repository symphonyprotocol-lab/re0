/**
 * The tables of rebuild-proposal.md 4 delivered so far: the 15 of step 1 and
 * the 3 of step 2 (knowledge_folder, github_connection, domain_claim). Enumerations are
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
    deletedAt: timestampTz('deleted_at'),
    createdAt: createdAt(),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ree_slug_key').on(t.slug),
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
    createdAt: createdAt(),
    updatedAt: timestampTz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('conversation_user_idx').on(t.userId, t.updatedAt),
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
    createdAt: createdAt(),
  },
  (t) => [
    index('message_conversation_idx').on(t.conversationId, t.createdAt),
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
    expiresAt: timestampTz('expires_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('credit_grant_user_idx').on(t.userId),
    check('credit_grant_source_check', oneOf('source', ['welcome', 'plan', 'pack', 'earned'])),
    check('credit_grant_remaining_check', sql`remaining >= 0 and remaining <= amount`),
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

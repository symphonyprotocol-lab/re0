import {
  check,
  customType,
  date,
  pgTable,
  pgEnum,
  text,
  uuid,
  integer,
  bigint,
  bigserial,
  boolean,
  timestamp,
  jsonb,
  vector,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Postgres schema. See architecture.md 6.
 *
 * Conventions (architecture.md 6.4):
 * - ids are application-generated UUIDv7
 * - timestamps are UTC
 * - money is an integer in the minor unit plus an ISO 4217 code, never a float
 */

// ---------------------------------------------------------------- enums

/** The retrieval models the console configures; see `providerModelConfig`. */
export const modelKindEnum = pgEnum('model_kind', ['embedding', 'rerank']);
/** The page-rendering fallbacks; see `renderConfig`. `lib/domain/render-config.ts`. */
export const renderProviderEnum = pgEnum('render_provider', ['firecrawl', 'anysearch', 'jina']);
export const lifecycleStatusEnum = pgEnum('lifecycle_status', [
  'draft',
  'submitted',
  'reviewing',
  'changes_requested',
  'published',
  'suspended',
  'archived',
]);
export const indexStatusEnum = pgEnum('index_status', [
  'pending',
  'processing',
  'ready',
  'failed',
  'stale',
  'deleting',
]);
export const claimStatusEnum = pgEnum('claim_status', [
  'pending',
  'verified',
  'failed',
  'expired',
  'revoked',
]);
export const claimMethodEnum = pgEnum('claim_method', [
  'github_permission',
  'dns_txt',
  'well_known',
]);
export const sourceTypeEnum = pgEnum('source_type', [
  'github',
  'website',
  'markdown',
  'pdf',
  'notion',
  /** Written in the platform's own editor: articles and Q&A (agent-first-proposal.md 3.2, 6.5, 6.7). */
  'editor',
  /** An uploaded episode, indexed by its title and show notes only, never transcribed (6.6). */
  'audio',
]);
export const workspaceRoleEnum = pgEnum('workspace_role', [
  'owner',
  'admin',
  'developer',
  'viewer',
]);
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'canceled',
  'trialing',
  /** Paused at the provider: grants nothing, but is still a subscription that can resume. */
  'paused',
]);
export const reservationStatusEnum = pgEnum('reservation_status', [
  'pending',
  'committed',
  'released',
]);
export const anchorSubjectEnum = pgEnum('anchor_subject_type', [
  'version',
  'audit_head',
  'earning_statement',
]);
export const anchorBatchStatusEnum = pgEnum('anchor_batch_status', [
  'pending',
  'submitted',
  'confirmed',
  'failed',
  'superseded',
]);
export const settlementStatusEnum = pgEnum('settlement_status', [
  'accrued',
  'held',
  'paid',
  /**
   * Discharged as Additional Calls rather than money: the publisher turned the
   * statement into an `addon_grant` (agent-first-proposal.md 6.9). Distinct
   * from `paid` so the books still say what left as cash and what never did.
   */
  'redeemed',
  'clawed_back',
  'voided',
]);
export const billingDocumentKindEnum = pgEnum('billing_document_kind', [
  'subscription',
  'pack',
]);
/**
 * The provider's own vocabulary, mirrored rather than reshaped. One column
 * covers issuing and payment because that is how a provider models a billing
 * document; see lib/domain/billing.
 */
export const billingDocumentStatusEnum = pgEnum('billing_document_status', [
  'draft',
  'open',
  'paid',
  'failed',
  'refunded',
  'void',
  'uncollectible',
]);
export const policyModeEnum = pgEnum('policy_mode', ['quality', 'select']);
/** Which door a site key opens: the widget on the owner's site, or a showcase page of ours. */
export const siteKeyKindEnum = pgEnum('site_key_kind', ['embed', 'showcase']);
export const showcaseKindEnum = pgEnum('showcase_kind', ['company', 'product']);
export const showcaseStatusEnum = pgEnum('showcase_status', [
  'draft',
  'published',
  'disabled',
  'taken_down',
]);
export const showcaseAccessEnum = pgEnum('showcase_access', ['public', 'unlisted']);
export const showcaseLeadStatusEnum = pgEnum('showcase_lead_status', ['new', 'handled']);
export const showcaseDomainStatusEnum = pgEnum('showcase_domain_status', [
  'pending_ownership',
  'pending_dns',
  'ready',
  'failed',
]);

// ---------------------------------------------------------------- identity & commerce

/**
 * `email` is deliberately not unique: requirement.md 3.2 forbids merging
 * accounts that happen to share an address, so two providers reporting the
 * same mailbox stay two accounts until the user links them from a session.
 */
export const user = pgTable('user', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  status: text('status').notNull().default('active'),
  /**
   * How much the user's personal workspace may hold across all its live
   * assets: `base` (500 MB) or `extended` (2 GB). agent-first-proposal.md
   * 8.1 -- raised for good by the first Additional Calls purchase, later also
   * by the first channel subscription, and never lowered. On the user rather
   * than the workspace because purchases and subscriptions are the user's.
   * `lib/domain/plans.ts` `STORAGE_TIERS`.
   */
  storageTier: text('storage_tier').notNull().default('base'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const oauthAccount = pgTable(
  'oauth_account',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => user.id),
    provider: text('provider').notNull(),
    providerSubject: text('provider_subject').notNull(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oauth_provider_subject_uq').on(t.provider, t.providerSubject)],
);

/**
 * Session digest. The cookie carries a random token; only its HMAC is stored,
 * the same "never keep the secret itself" rule the API keys follow.
 *
 * `client_summary` is a coarse fingerprint (user agent family only). Plain IPs
 * must not be written to product storage -- architecture.md 11.2.
 */
export const userSession = pgTable(
  'user_session',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => user.id),
    tokenHash: text('token_hash').notNull(),
    clientSummary: jsonb('client_summary').$type<Record<string, string>>().notNull().default({}),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_session_token_hash_uq').on(t.tokenHash),
    /** Suspending an account and counting its live sessions both read by user. */
    index('user_session_user_idx').on(t.userId),
  ],
);

/**
 * A person's GitHub account, connected for repository imports.
 *
 * Login drops the provider token (requirement.md 12). This is the separate
 * grant a person gives on the wizard so it can list their own public
 * repositories and, at submit, prove the chosen one is theirs
 * (lib/domain/github.ts). `token_sealed` is the access token sealed with the
 * cookie key -- never the token itself -- and the row sits apart from
 * business tables as requirement.md 12 asks. One per user; reconnecting
 * replaces the token.
 */
export const githubConnection = pgTable(
  'github_connection',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => user.id),
    /** GitHub's numeric account id as text; logins are renamed, ids are not. */
    githubUserId: text('github_user_id').notNull(),
    login: text('login').notNull(),
    tokenSealed: text('token_sealed').notNull(),
    scope: text('scope').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('github_connection_user_uq').on(t.userId)],
);

/**
 * A person's Notion account, connected for page imports.
 *
 * The counterpart of `githubConnection` for the one source that cannot be
 * read anonymously: the sealed token is the only way to fetch the pages the
 * person shared with the integration, so it is kept for the asset's
 * refreshes as well as for the wizard's listing (lib/domain/notion.ts). One
 * per user; reconnecting replaces the token.
 */
export const notionConnection = pgTable(
  'notion_connection',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => user.id),
    /** The integration's bot id in the granted workspace. */
    botId: text('bot_id').notNull(),
    notionWorkspaceId: text('notion_workspace_id').notNull(),
    workspaceName: text('workspace_name'),
    notionUserId: text('notion_user_id'),
    ownerName: text('owner_name'),
    tokenSealed: text('token_sealed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notion_connection_user_uq').on(t.userId)],
);

export const workspace = pgTable(
  'workspace',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    /** `personal` is the only kind in the MVP; team workspaces reuse the table. */
    kind: text('kind').notNull().default('personal'),
    /**
     * The workspace's public name (agent-first-proposal.md 12): `/u/{handle}`
     * and the user Agent Card. On the workspace rather than the user because
     * channels, assets and A2A identity all belong to workspaces. Null means
     * no public page; `lib/domain/handle.ts` says what a handle may be.
     */
    handle: text('handle'),
    /**
     * Days a private asset -- one in no public channel -- is kept after its
     * last successful build (agent-first-proposal.md 7.9, 10). Null keeps it
     * until the owner deletes it; the retention cron deletes the rest.
     */
    privateAssetRetentionDays: integer('private_asset_retention_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('workspace_handle_uq').on(t.handle),
    check(
      'workspace_private_asset_retention_ck',
      sql`${t.privateAssetRetentionDays} is null or ${t.privateAssetRetentionDays} in (30, 90, 180, 365)`,
    ),
  ],
);

export const workspaceMember = pgTable(
  'workspace_member',
  {
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    userId: uuid('user_id').notNull().references(() => user.id),
    role: workspaceRoleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    /**
     * The primary key leads with `workspace_id`, so "which workspaces is this
     * user in" -- the direction every console screen asks -- cannot use it.
     */
    index('workspace_member_user_idx').on(t.userId),
  ],
);

export const apiKey = pgTable(
  'api_key',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    name: text('name').notNull(),
    /** Only the hash is stored. The full value is shown once, at creation. */
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    lastFour: text('last_four').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    environment: text('environment').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_key_hash_uq').on(t.keyHash),
    /** Listing or counting a workspace's keys, which authentication never does. */
    index('api_key_workspace_idx').on(t.workspaceId),
  ],
);

export const plan = pgTable('plan', {
  /**
   * `free`, `pro` and `addon`, and nothing else. requirement.md 4.1, 4.3.
   *
   * Additional Calls is a pack, not a subscription tier: it has a Plan Version
   * so its price and calls-per-pack are versioned and frozen like the others,
   * but no `subscription` row may point at that version. See lib/domain/plans.
   */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const planVersion = pgTable(
  'plan_version',
  {
    id: uuid('id').primaryKey(),
    planId: text('plan_id').notNull().references(() => plan.id),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull().default('USD'),
    monthlyCalls: integer('monthly_calls').notNull(),
    /**
     * Keys valid at once. The only per-workspace ceiling a version still
     * carries: the asset count is uncapped and content is bounded by the
     * owner's `user.storage_tier` (agent-first-proposal.md 8.1).
     */
    apiKeyLimit: integer('api_key_limit').notNull(),
    /**
     * What an asset build costs, frozen per version like every price here.
     * asset-build-billing.md 3.3; `lib/domain/build-billing.ts` `BuildRates`.
     * The pack stores the 0 sentinel in all three, never a rate.
     */
    buildBaseCalls: integer('build_base_calls').notNull().default(1),
    buildTokensPerCall: integer('build_tokens_per_call').notNull().default(20_000),
    buildPagesPerCall: integer('build_pages_per_call').notNull().default(5),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  /** "The newest version of this plan", which every allowance lookup asks. */
  (t) => [index('plan_version_plan_idx').on(t.planId, t.createdAt.desc())],
);

export const subscription = pgTable(
  'subscription',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    planVersionId: uuid('plan_version_id').notNull().references(() => planVersion.id),
    status: subscriptionStatusEnum('status').notNull(),
    providerCustomerId: text('provider_customer_id'),
    providerSubscriptionId: text('provider_subscription_id'),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    /**
     * When a cancellation the subscriber has already asked for takes effect.
     * The provider keeps the subscription `active` until then, so without this
     * a subscription that will lapse reads the same as one that renews. Null
     * means it renews -- or, on a Free row, that nothing renews it.
     */
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    /**
     * When the provider says this state was true. Webhooks arrive out of
     * order, so an event only overwrites a row whose state is older than its
     * own. Null on rows no provider wrote -- the Free subscription signup
     * creates -- which any event may supersede.
     */
    observedAt: timestamp('observed_at', { withTimezone: true }),
  },
  (t) => [
    /** The per-request quota transaction reads a workspace's subscription. */
    index('subscription_workspace_idx').on(t.workspaceId),
    /** One provider subscription, one row; nulls (Free rows) stay distinct. */
    uniqueIndex('subscription_provider_uq').on(t.providerSubscriptionId),
    /** "Is any subscription still on this plan version", before retiring one. */
    index('subscription_plan_version_idx').on(t.planVersionId),
  ],
);

/**
 * Additional Calls. requirement.md 4.3: the balance never expires and carries
 * across periods, so quota checks must read the balance and must not filter on
 * a validity window. See architecture.md 11.1.
 */
export const addonGrant = pgTable(
  'addon_grant',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    callsGranted: integer('calls_granted').notNull(),
    callsConsumed: integer('calls_consumed').notNull().default(0),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull().default('USD'),
    providerOrderId: text('provider_order_id'),
    /**
     * Set when the grant was not bought but redeemed: a creator turned
     * settled earnings into calls (agent-first-proposal.md 6.9). Then
     * `price_minor` is the earnings consumed, not a pack price, and the grant
     * is not a purchase -- `workspaceBilling` must not count it as one.
     *
     * The foreign key to `publisher_account` lives in the migration only:
     * that table is declared further down, and this file has no forward
     * `references()` -- drizzle resolves them lazily, but a tool walking the
     * table config at import time would hit the temporal dead zone.
     */
    publisherAccountId: uuid('publisher_account_id'),
    /** Who redeemed it, as `user:<id>` or `api_key:<id>`; null on a bought pack. */
    redeemedBy: text('redeemed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** The per-request quota transaction reads a workspace's grant balances. */
    index('addon_grant_workspace_idx').on(t.workspaceId),
    /** A pack order is granted once, however often its events are redelivered. */
    uniqueIndex('addon_grant_provider_order_uq').on(t.providerOrderId),
    /** The publisher's redemption history, newest first. */
    index('addon_grant_publisher_idx').on(t.publisherAccountId, t.createdAt.desc()),
  ],
);

export const paymentEvent = pgTable(
  'payment_event',
  {
    id: uuid('id').primaryKey(),
    provider: text('provider').notNull(),
    externalEventId: text('external_event_id').notNull(),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payment_event_uq').on(t.provider, t.externalEventId)],
);

/**
 * The console's read-only mirror of the Payment Provider's billing documents.
 *
 * requirement.md 5.3 asks the console to show orders, payment state, refunds
 * and invoicing status, and says every human action goes through the provider.
 * architecture.md 11.3 fixes what may be kept on this side: the external id,
 * the status, the amount and the currency. Cards, addresses and the provider's
 * rendered invoice stay over there and are not columns here.
 *
 * `payment_event` is the append-only, verified log of what the provider said;
 * this is the projection of it a screen can query. One row per provider
 * document, rewritten in place as its state moves, which is what makes
 * `(provider, external_id)` the key rather than the primary key: the row is
 * mutable because it mirrors something mutable.
 */
export const billingDocument = pgTable(
  'billing_document',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    provider: text('provider').notNull(),
    /** The provider's machine id -- what an operator pastes into its console. */
    externalId: text('external_id').notNull(),
    /** Its human-facing number, or the external id again when it issues none. */
    number: text('number').notNull(),
    kind: billingDocumentKindEnum('kind').notNull(),
    status: billingDocumentStatusEnum('status').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    /**
     * Refunds are their own column rather than a rewritten amount: what was
     * charged is a fact about the past, and a dispute that cannot see both
     * numbers cannot be settled. Partial refunds need it too.
     */
    refundedMinor: integer('refunded_minor').notNull().default(0),
    /** As the provider settled it. requirement.md 4.3 keeps the original code. */
    currency: text('currency').notNull().default('USD'),
    /**
     * A method *type* -- `card`, `alipay` -- never an instrument. A last-four
     * is card data by any useful definition and does not belong on this side.
     */
    method: text('method'),
    /** What was billed, when it is a subscription period. */
    subscriptionId: uuid('subscription_id').references(() => subscription.id),
    /** What was bought, when it is a call pack. */
    addonGrantId: uuid('addon_grant_id').references(() => addonGrant.id),
    /** The immutable version the order was priced against. requirement.md 4.3 */
    planVersionId: uuid('plan_version_id').references(() => planVersion.id),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** The verified event that last wrote this row -- the trail back to source. */
    lastEventId: uuid('last_event_id').references(() => paymentEvent.id),
    /**
     * The instant the provider says this state was true, not the instant we
     * wrote it. Webhooks arrive out of order, so this is what decides whether
     * an arriving event is newer than the row it would overwrite.
     */
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('billing_document_uq').on(t.provider, t.externalId),
    /*
     * Money is checked where it is stored, not only where it is parsed. The
     * mirror refuses these too (lib/domain/billing), but the table is written
     * by adapters, and an adapter that confuses minor and major units -- or
     * reports more back than went out -- must not be able to drive the
     * revenue readout negative.
     */
    check(
      'billing_document_amount_ck',
      sql`${t.amountMinor} >= 0 and ${t.refundedMinor} >= 0 and ${t.refundedMinor} <= ${t.amountMinor}`,
    ),
    /** The console's default order, and the page window that walks it. */
    index('billing_document_issued_idx').on(t.issuedAt.desc(), t.id.desc()),
    index('billing_document_status_idx').on(t.status, t.issuedAt.desc()),
    index('billing_document_workspace_idx').on(t.workspaceId, t.issuedAt.desc()),
  ],
);

/**
 * Checkouts this server opened at the Payment Provider. A paid checkout only
 * becomes a `subscription` row when its webhook lands, so until then this is
 * the one place that knows a purchase is under way; checkout reads it to
 * reuse an open one and to refuse a second subscription while the first is
 * still being confirmed. See lib/application/billing/checkout.
 */
export const paymentCheckout = pgTable(
  'payment_checkout',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    kind: billingDocumentKindEnum('kind').notNull(),
    /** The version it was priced at; an open checkout is only reused while that is still live. */
    planVersionId: uuid('plan_version_id').notNull().references(() => planVersion.id),
    checkoutUrl: text('checkout_url').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_checkout_uq').on(t.provider, t.externalId),
    index('payment_checkout_workspace_idx').on(t.workspaceId, t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------- knowledge

export const asset = pgTable(
  'asset',
  {
    id: uuid('id').primaryKey(),
    /** Public, stable id such as /vercel/next.js. requirement.md 6.1 */
    publicId: text('public_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    domainTag: text('domain_tag'),
    language: text('language'),
    /**
     * Ownership. Written only by a verified claim or an admin ruling.
     * architecture.md 5.4 -- ingestion, review and refresh must never touch it.
     */
    ownerWorkspaceId: uuid('owner_workspace_id').references(() => workspace.id),
    isPlatformAsset: boolean('is_platform_asset').notNull().default(false),
    /**
     * Which of the seven asset types this is (agent-first-proposal.md 3.2,
     * `lib/domain/asset.ts` `ASSET_KINDS`); follows from the one source.
     */
    kind: text('kind').$type<'website' | 'upload' | 'github' | 'notion' | 'post' | 'audio' | 'qa'>().notNull(),
    /**
     * `free` or `paid`, meaningful only inside a channel (proposal 6.2): who
     * may read an asset follows from the channel it is in and this flag, not
     * from a visibility column of its own. Reset to `free` whenever the asset
     * leaves its channel.
     */
    access: text('access').$type<'free' | 'paid'>().notNull().default('free'),
    lifecycleStatus: lifecycleStatusEnum('lifecycle_status').notNull(),
    indexStatus: indexStatusEnum('index_status').notNull(),
    currentVersionId: uuid('current_version_id'),
    storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastSuccessfulRefreshAt: timestamp('last_successful_refresh_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The tombstone. architecture.md 8.4: a delete first makes the asset
     * unreachable in Postgres -- this column, `archived`, `deleting`, and the
     * publication pointer withdrawn -- and the Delete Workflow then removes
     * the content. The row itself stays: `usage_event` is an append-only fact
     * that references it, and a deleted asset's billing history is still
     * history. Every list and lookup of live assets filters on this being
     * null.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * The owner's rights declaration (lib/domain/rights.ts): origin,
     * licence, how the content was written, their note, who declared and
     * when. Required before a public asset may be submitted
     * (review-visibility-proposal.md 5.1); null on a private asset that
     * never declared, and on assets created before it existed.
     */
    rightsDeclaration: jsonb('rights_declaration').$type<{
      origin: string;
      license: string;
      generation: string;
      note: string;
      declaredAt: string;
      declaredBy: string | null;
    }>(),
  },
  (t) => [
    /**
     * Partial: a deleted asset releases its Asset ID. A workspace that
     * deletes `/owner/repo` and adds it again must not be told the id is
     * taken by a tombstone, and every lookup by `public_id` already excludes
     * deleted rows -- so the constraint only has to hold among live ones.
     */
    uniqueIndex('asset_public_id_uq')
      .on(t.publicId)
      .where(sql`${t.deletedAt} is null`),
    index('asset_owner_idx').on(t.ownerWorkspaceId),
    index('asset_lifecycle_idx').on(t.lifecycleStatus, t.indexStatus),
    /**
     * The console's platform-asset list reads `asset` the other way round
     * from the catalogue: it starts from `is_platform_asset`, and the false
     * rows outnumber the true ones by orders of magnitude. Partial, so this
     * costs one entry per platform asset rather than one per asset.
     */
    index('asset_platform_idx')
      .on(t.lifecycleStatus, t.createdAt.desc())
      .where(sql`${t.isPlatformAsset}`),
  ],
);

/**
 * A channel: the one way an asset is shown to anyone but its owner
 * (agent-first-proposal.md 6.1). `workspace_id` is null only for the
 * platform's own channel, which holds the platform assets. `visibility` and
 * `status` together with the asset's `access` decide who sees what
 * (lib/domain/channel.ts, proposal 6.2). `profile` aggregates the public
 * assets' profiles for channel-level routing (proposal 3.7).
 */
export const channel = pgTable(
  'channel',
  {
    id: uuid('id').primaryKey(),
    slug: text('slug').notNull(),
    workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    visibility: text('visibility').$type<'public' | 'private'>().notNull().default('public'),
    status: text('status').$type<'active' | 'suspended'>().notNull().default('active'),
    /** A subscriber's daily retrieval cap the creator may set; null is no cap (proposal 6.10). */
    subscriberDailyLimit: integer('subscriber_daily_limit'),
    /**
     * When the owner switched subscriptions on, having confirmed the paid
     * distribution rights (proposal 6.11) -- who and when are the two
     * columns after it. Null is a free channel: no plan is sold and no
     * asset in it may be `paid`.
     */
    subscriptionsEnabledAt: timestamp('subscriptions_enabled_at', { withTimezone: true }),
    paidRightsConfirmedAt: timestamp('paid_rights_confirmed_at', { withTimezone: true }),
    /** FK to `user` in the migration only: `user` is declared, but keep the channel row free of the cycle. */
    paidRightsConfirmedBy: uuid('paid_rights_confirmed_by'),
    profile: jsonb('profile').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_slug_uq').on(t.slug),
    index('channel_workspace_idx').on(t.workspaceId),
  ],
);

/**
 * Which channel an asset is in. `asset_id` is the key: an asset is in at most
 * one channel (proposal 6.1). Cascades with the channel and with a purged
 * asset; a soft-deleted asset is taken out by the delete use case.
 */
export const channelAsset = pgTable(
  'channel_asset',
  {
    assetId: uuid('asset_id')
      .primaryKey()
      .references(() => asset.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    /** The creator closed comments on this asset (proposal 6.8); existing ones stay as they are. */
    commentsClosed: boolean('comments_closed').notNull().default(false),
  },
  (t) => [index('channel_asset_channel_idx').on(t.channelId, t.publishedAt.desc())],
);

/**
 * One distinct visitor of a channel on one day, for the directory's activity
 * term (proposal 6.4): by user, by calling workspace, or by the hashed key the
 * anonymous rate limiter uses. No address and no query is ever written here.
 */
export const channelVisit = pgTable(
  'channel_visit',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    visitorKind: text('visitor_kind').$type<'user' | 'workspace' | 'anonymous'>().notNull(),
    visitorKey: text('visitor_key').notNull(),
    visitedOn: date('visited_on', { mode: 'string' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.visitorKind, t.visitorKey, t.visitedOn] }),
    index('channel_visit_day_idx').on(t.visitedOn),
  ],
);

/**
 * A publishable key for the website widget. requirement.md 9.4,
 * lib/domain/site-key.ts.
 *
 * Stored in the clear, on purpose: the value is pasted into the owner's web
 * page, where every visitor can read it, so a hash would protect nothing.
 * What the row protects is spelled out in its columns -- the origins that may
 * embed the widget and how many Calls a day the key may spend. One key serves
 * one asset; the widget answers from that asset and nothing else.
 */
export const siteKey = pgTable(
  'site_key',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    name: text('name').notNull(),
    key: text('key').notNull(),
    /**
     * `embed` is the owner's key for their own site. `showcase` is the key a
     * showcase page of ours answers through: never listed to the owner,
     * never counted against the per-asset key limit, revoked with its page.
     */
    kind: siteKeyKindEnum('kind').notNull().default('embed'),
    /** Normalised origins (scheme://host[:port]) that may embed the widget. */
    allowedOrigins: jsonb('allowed_origins').$type<string[]>().notNull(),
    /** Calls this key may spend per rolling day, from the workspace's quota. */
    dailyLimit: integer('daily_limit').notNull(),
    /** The owner's greeting; null shows the product default. */
    welcome: text('welcome'),
    /** The widget's button and bubble colour, `#rrggbb`. */
    accent: text('accent').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('site_key_key_uq').on(t.key),
    /** The asset page lists its keys; authentication never does. */
    index('site_key_asset_idx').on(t.assetId),
  ],
);

/**
 * Where a site key's widget has actually been seen. requirement.md 9.4,
 * lib/application/embed/origins.ts.
 *
 * `siteKey.allowedOrigins` is what the owner permits; this is which of those
 * sites has pasted the snippet. One row per key and origin: `loads` counts
 * the widget page served to that parent, `questions` the visitor questions
 * admitted from it. Usage marks, not an audit fact -- written fire-and-forget
 * and dropped with the key.
 */
export const siteKeyOrigin = pgTable(
  'site_key_origin',
  {
    id: uuid('id').primaryKey(),
    siteKeyId: uuid('site_key_id')
      .notNull()
      .references(() => siteKey.id, { onDelete: 'cascade' }),
    /** Normalised, as `allowedOrigins` holds it. */
    origin: text('origin').notNull(),
    loads: integer('loads').notNull().default(0),
    questions: integer('questions').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('site_key_origin_uq').on(t.siteKeyId, t.origin)],
);

/**
 * What the website widget was asked, per asset. requirement.md 9.4,
 * lib/application/embed/exchanges.ts.
 *
 * The request log keeps no query text (architecture.md 17.1); this table
 * does, on purpose: a visitor asked the owner's site, and the owner reads
 * what their visitors ask and what they were told to grow the asset from
 * it. Scoped to the asset, nothing of the visitor beyond the site they
 * asked from; the owner's own try-outs from the dashboard are previews.
 */
export const widgetExchange = pgTable(
  'widget_exchange',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    /** Kept after the key is revoked; null once the key row is gone. */
    siteKeyId: uuid('site_key_id').references(() => siteKey.id, { onDelete: 'set null' }),
    origin: text('origin').notNull(),
    preview: boolean('preview').notNull().default(false),
    question: text('question').notNull(),
    /** The query the answer was retrieved with when the question itself missed. */
    rewrittenQuery: text('rewritten_query'),
    /** 'answer' | 'no_context' | 'degraded' | 'not_ready' | 'unavailable' (the widget's outcome kinds). */
    outcome: text('outcome').notNull(),
    /** The bound sentences, joined; null when nothing was generated. */
    answer: text('answer'),
    sources: jsonb('sources').$type<{ url: string; title: string }[]>().notNull().default([]),
    latencyMs: integer('latency_ms'),
    /** The visitor's verdict on a showcase page: 'helpful' | 'unhelpful'; null when none was given. */
    feedback: text('feedback'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('widget_exchange_asset_time_idx').on(t.assetId, t.createdAt)],
);

/**
 * The owner's FAQ for an asset. requirement.md 9.4, lib/domain/faq.ts.
 *
 * Each entry becomes a document of the next build -- question as title,
 * answer as body, cited to `pageUrl` -- so a recurring widget question finds
 * a chunk written for it. `assetVersion.faqDigest` remembers the FAQ a
 * version was built with.
 */
export const assetFaq = pgTable(
  'asset_faq',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    /** The page the entry stands for; what its citation opens. */
    pageUrl: text('page_url').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('asset_faq_asset_idx').on(t.assetId, t.createdAt)],
);

/**
 * An asset shared as a standalone page. lib/domain/showcase.ts.
 *
 * One live row per asset. The page answers through its own `siteKey`
 * (kind `showcase`), so the widget's exchange log, FAQ and quota brakes
 * apply unchanged. `content` is the owner's copy for the top of the page,
 * validated by the domain before it is stored; `starterQuestions` the chips
 * under it. `slug` is the public address; `previousSlug` keeps the last one
 * so a link already shared keeps working after a rename.
 */
export const assetShowcase = pgTable(
  'asset_showcase',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    siteKeyId: uuid('site_key_id').notNull().references(() => siteKey.id),
    kind: showcaseKindEnum('kind').notNull(),
    slug: text('slug').notNull(),
    previousSlug: text('previous_slug'),
    status: showcaseStatusEnum('status').notNull().default('draft'),
    access: showcaseAccessEnum('access').notNull().default('public'),
    locale: text('locale').notNull().default('en'),
    content: jsonb('content').$type<Record<string, unknown>>().notNull().default({}),
    starterQuestions: jsonb('starter_questions').$type<string[]>().notNull().default([]),
    logoKey: text('logo_key'),
    screenshotKey: text('screenshot_key'),
    accent: text('accent').notNull(),
    showBranding: boolean('show_branding').notNull().default(true),
    /** Link-only pages may ask for a password: argon2id, null when none. */
    passwordHash: text('password_hash'),
    /** Bumped on every password change; the unlock cookie names the version it was issued for. */
    passwordVersion: integer('password_version').notNull().default(0),
    /** After this the page is closed to visitors; null never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    generatedAt: timestamp('generated_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('asset_showcase_asset_uq')
      .on(t.assetId)
      .where(sql`${t.deletedAt} is null`),
    uniqueIndex('asset_showcase_slug_uq')
      .on(t.slug)
      .where(sql`${t.deletedAt} is null`),
    index('asset_showcase_previous_slug_idx')
      .on(t.previousSlug)
      .where(sql`${t.previousSlug} is not null`),
    index('asset_showcase_workspace_idx').on(t.workspaceId),
  ],
);

/** Views, questions and CTA clicks per showcase page and UTC day. Counters, written off the request path. */
export const assetShowcaseDaily = pgTable(
  'asset_showcase_daily',
  {
    showcaseId: uuid('showcase_id')
      .notNull()
      .references(() => assetShowcase.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    views: integer('views').notNull().default(0),
    questions: integer('questions').notNull().default(0),
    ctaClicks: integer('cta_clicks').notNull().default(0),
    leads: integer('leads').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.showcaseId, t.day] })],
);

/**
 * A lead left on a showcase page (lib/domain/showcase.ts `validateLead`):
 * a visitor the asset could not answer, their contact, and the exchange
 * they were in. The one table that holds a visitor's personal data; the
 * exchange log never does, and nothing here is embedded or grouped.
 */
export const showcaseLead = pgTable(
  'showcase_lead',
  {
    id: uuid('id').primaryKey(),
    showcaseId: uuid('showcase_id')
      .notNull()
      .references(() => assetShowcase.id, { onDelete: 'cascade' }),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    exchangeId: uuid('exchange_id').references(() => widgetExchange.id, { onDelete: 'set null' }),
    email: text('email').notNull(),
    name: text('name'),
    message: text('message'),
    status: showcaseLeadStatusEnum('status').notNull().default('new'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    handledAt: timestamp('handled_at', { withTimezone: true }),
  },
  (t) => [
    index('showcase_lead_showcase_idx').on(t.showcaseId, t.createdAt),
    index('showcase_lead_workspace_new_idx')
      .on(t.workspaceId)
      .where(sql`${t.status} = 'new'`),
  ],
);

/**
 * A showcase page on the owner's own subdomain (lib/domain/showcase.ts
 * `parseCustomHost`, lib/application/showcase/domain.ts). Ownership is
 * proved through a TXT challenge first; only then is the host added to the
 * deployment's Vercel project. The challenge token is kept in the clear:
 * the owner is shown the record until it resolves, and it proves control
 * of this host for this page and nothing else. One host per page.
 */
export const showcaseDomain = pgTable(
  'showcase_domain',
  {
    id: uuid('id').primaryKey(),
    showcaseId: uuid('showcase_id')
      .notNull()
      .references(() => assetShowcase.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    host: text('host').notNull(),
    status: showcaseDomainStatusEnum('status').notNull().default('pending_ownership'),
    verificationId: uuid('verification_id').references(() => domainVerification.id, { onDelete: 'set null' }),
    verificationToken: text('verification_token'),
    /** The record Vercel asks for when the host was used on another account; null when none was asked. */
    vercelTxtName: text('vercel_txt_name'),
    vercelTxtValue: text('vercel_txt_value'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('showcase_domain_showcase_uq').on(t.showcaseId), uniqueIndex('showcase_domain_host_uq').on(t.host)],
);

export const assetAlias = pgTable(
  'asset_alias',
  {
    id: uuid('id').primaryKey(),
    fromPublicId: text('from_public_id').notNull(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
  },
  (t) => [uniqueIndex('asset_alias_uq').on(t.fromPublicId)],
);

export const source = pgTable(
  'source',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    type: sourceTypeEnum('type').notNull(),
    location: text('location').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    /** Encrypted reference only. Never the secret itself. */
    credentialRef: text('credential_ref'),
    refreshPolicy: jsonb('refresh_policy').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('source_asset_idx').on(t.assetId)],
);

export const assetVersion = pgTable(
  'asset_version',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    label: text('label').notNull(),
    sourceDigest: text('source_digest').notNull(),
    /**
     * What each source contributed to this version, keyed by source id: its
     * own snapshot digest, content bytes and the facts scoring reads. The
     * next build compares a source's fresh digest against this and, when
     * equal, copies the source's documents and chunks forward instead of
     * parsing and embedding them again (`build-version.ts`). Null on versions
     * built before this existed, which the next build treats as "rebuild all".
     */
    sourceDigests: jsonb('source_digests').$type<
      Record<
        string,
        { digest: string; bytes: number; lastModifiedAt: string | null; hasLicense: boolean }
      >
    >(),
    parserVersion: text('parser_version').notNull(),
    chunkerVersion: text('chunker_version').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    /**
     * The width the model was asked for, frozen beside its name.
     *
     * The column is fixed and narrower vectors are zero-padded into it
     * (`lib/domain/model-config.ts`), so the stored width says nothing about
     * which space a version lives in -- two builds of the same model at
     * different dimensions are as incomparable as two different models, and
     * without this the guard on the retrieval path could not tell them apart.
     */
    embeddingDimensions: integer('embedding_dimensions').notNull().default(1536),
    /**
     * The text-search configuration its chunks were indexed with, resolved from
     * the asset's language at build time.
     *
     * Frozen here alongside the parser, chunker and embedding model
     * (requirement.md 8.1) because it is the fourth thing that decides what a
     * version is -- and because a build compares all four against the current
     * version to decide whether an unchanged source still needs rebuilding.
     */
    /**
     * The FAQ this version was built with (lib/domain/faq.ts `faqCanonical`,
     * hashed); null when the asset had none. A build compares it to know
     * whether an edit to the FAQ alone is a change.
     */
    faqDigest: text('faq_digest'),
    searchConfig: text('search_config').notNull().default('simple'),
    /** Merkle root over ordered chunk digests, input to Version Anchor. */
    contentMerkleRoot: text('content_merkle_root'),
    /**
     * The bottom-k sketch of this version's chunks (lib/domain/fingerprint.ts),
     * for the review rules' duplicate check against published assets.
     * Null on versions built before it existed, which simply never match.
     */
    contentSketch: jsonb('content_sketch').$type<string[]>(),
    indexStatus: indexStatusEnum('index_status').notNull(),
    totalTokens: integer('total_tokens').notNull().default(0),
    totalChunks: integer('total_chunks').notNull().default(0),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('asset_version_asset_idx').on(t.assetId, t.createdAt.desc()),
    /** One build per label: the console's version list is chosen from by label. */
    uniqueIndex('asset_version_label_uq').on(t.assetId, t.label),
  ],
);

export const assetReview = pgTable('asset_review', {
  id: uuid('id').primaryKey(),
  assetId: uuid('asset_id').notNull().references(() => asset.id),
  versionId: uuid('version_id').references(() => assetVersion.id),
  stage: text('stage').notNull(),
  outcome: text('outcome'),
  feedback: jsonb('feedback').$type<string[]>().notNull().default([]),
  /**
   * requirement.md 7.4's five checks, each with a verdict and a note
   * (lib/domain/review.ts `ReviewChecklist`). Null on a private asset's
   * safety pause, and on rows written before the checklist existed.
   */
  checklist: jsonb('checklist').$type<Record<string, { verdict: string; note: string }>>(),
  /**
   * The machine decision this row appeals (lib/domain/asset.ts
   * `appealableDecision`): set on the owner's `appeal` row, null otherwise.
   * No foreign key, like `reviewer_id`: the rows are append-only anyway.
   */
  appealOf: uuid('appeal_of'),
  reviewerId: uuid('reviewer_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});

/**
 * Ownership claim. requirement.md 7.3, architecture.md 5.4.
 * A partial unique index keeps at most one pending claim per asset.
 */
export const assetClaim = pgTable(
  'asset_claim',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    claimantWorkspaceId: uuid('claimant_workspace_id').notNull().references(() => workspace.id),
    method: claimMethodEnum('method').notNull(),
    /** Hash only. The plaintext challenge is returned once, at creation. */
    challengeTokenHash: text('challenge_token_hash').notNull(),
    status: claimStatusEnum('status').notNull(),
    failureReason: text('failure_reason'),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    rulingAdminId: uuid('ruling_admin_id'),
    rulingReason: text('ruling_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('asset_claim_pending_uq')
      .on(t.assetId)
      .where(sql`${t.status} = 'pending'`),
    index('asset_claim_claimant_idx').on(t.claimantWorkspaceId),
  ],
);

/**
 * A challenge proving a workspace controls a host, met before a website
 * asset may be created from it (requirement.md 7.3.2,
 * architecture.md 5.4, lib/domain/domain-verification.ts). Reuses the claim
 * enums: a domain challenge is a claim made before the asset exists, and
 * a verified one is copied onto `asset_claim` when the asset is created.
 * Hash only; the plaintext token is returned once. Spent on exactly one
 * asset through `consumed_asset_id`.
 */
export const domainVerification = pgTable(
  'domain_verification',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    host: text('host').notNull(),
    method: claimMethodEnum('method').notNull(),
    challengeTokenHash: text('challenge_token_hash').notNull(),
    status: claimStatusEnum('status').notNull(),
    failureReason: text('failure_reason'),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    consumedAssetId: uuid('consumed_asset_id').references(() => asset.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('domain_verification_workspace_idx').on(t.workspaceId, t.createdAt)],
);

export const assetScore = pgTable(
  'asset_score',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    algorithmVersion: text('algorithm_version').notNull(),
    trustScore: integer('trust_score').notNull(),
    benchmarkScore: integer('benchmark_score').notNull(),
    breakdown: jsonb('breakdown').$type<Record<string, number>>().notNull().default({}),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  /** "This asset's newest score", which the catalogue reads per row. */
  (t) => [index('asset_score_current_idx').on(t.assetId, t.computedAt.desc())],
);

export const document = pgTable(
  'document',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    versionId: uuid('version_id').notNull().references(() => assetVersion.id),
    title: text('title').notNull(),
    sourceUrl: text('source_url').notNull(),
    objectKey: text('object_key'),
    /**
     * Which source this document came from. No foreign key: a source may be
     * removed while the versions it fed stay immutable. Null on documents
     * written before this existed.
     */
    sourceId: uuid('source_id'),
    /**
     * What the build's scan found in this file (lib/domain/ingestion.ts
     * `safetyFindingsOf`): the reason behind its chunks' `safety_status`,
     * kept so a reviewer sees which rule fired. Empty for a clean file.
     */
    safetyFindings: jsonb('safety_findings').$type<string[]>().notNull().default([]),
  },
  /** Documents are counted per version -- versions are immutable, so a count by
      asset would include every superseded build. */
  (t) => [index('document_version_idx').on(t.versionId)],
);

/**
 * Chunk text, the full-text vector and the embedding live on one row so that
 * publishing is a single ACID transaction. architecture.md 1.2 and 8.3.
 */
export const chunk = pgTable(
  'chunk',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    versionId: uuid('version_id').notNull().references(() => assetVersion.id),
    documentId: uuid('document_id').notNull().references(() => document.id),
    ordinal: integer('ordinal').notNull(),
    body: text('body').notNull(),
    tokens: integer('tokens').notNull(),
    citation: jsonb('citation').$type<Record<string, unknown>>().notNull(),
    safetyStatus: text('safety_status').notNull().default('clean'),
    /**
     * The Postgres text-search configuration this chunk was indexed with,
     * resolved from `asset.language` at build time.
     *
     * Denormalized because a generated column may only read its own row -- and
     * because editing the asset's language afterwards must not restate what
     * an already published Version means. See `lib/domain/ingestion.ts`.
     */
    searchConfig: text('search_config').notNull().default('simple'),
    /**
     * Generated from `body` and `search_config`, never written. A stored
     * generated column cannot drift from the text it indexes, and chunks are
     * immutable once inserted (requirement.md 8.1 freezes a published Version),
     * so it is computed once.
     *
     * A `case` over literal configurations rather than a `::regconfig` cast:
     * the cast is a catalogue lookup, which makes it STABLE, and Postgres
     * refuses a non-IMMUTABLE generation expression outright.
     */
    searchVector: customType<{ data: string; driverData: string; notNull: false }>({
      dataType: () => 'tsvector',
    })('search_vector').generatedAlwaysAs(sql`case "search_config"
        when 'arabic' then to_tsvector('arabic', "body")
        when 'armenian' then to_tsvector('armenian', "body")
        when 'basque' then to_tsvector('basque', "body")
        when 'catalan' then to_tsvector('catalan', "body")
        when 'danish' then to_tsvector('danish', "body")
        when 'dutch' then to_tsvector('dutch', "body")
        when 'english' then to_tsvector('english', "body")
        when 'finnish' then to_tsvector('finnish', "body")
        when 'french' then to_tsvector('french', "body")
        when 'german' then to_tsvector('german', "body")
        when 'greek' then to_tsvector('greek', "body")
        when 'hindi' then to_tsvector('hindi', "body")
        when 'hungarian' then to_tsvector('hungarian', "body")
        when 'indonesian' then to_tsvector('indonesian', "body")
        when 'irish' then to_tsvector('irish', "body")
        when 'italian' then to_tsvector('italian', "body")
        when 'lithuanian' then to_tsvector('lithuanian', "body")
        when 'nepali' then to_tsvector('nepali', "body")
        when 'norwegian' then to_tsvector('norwegian', "body")
        when 'portuguese' then to_tsvector('portuguese', "body")
        when 'romanian' then to_tsvector('romanian', "body")
        when 'russian' then to_tsvector('russian', "body")
        when 'serbian' then to_tsvector('serbian', "body")
        when 'spanish' then to_tsvector('spanish', "body")
        when 'swedish' then to_tsvector('swedish', "body")
        when 'tamil' then to_tsvector('tamil', "body")
        when 'turkish' then to_tsvector('turkish', "body")
        when 'yiddish' then to_tsvector('yiddish', "body")
        else to_tsvector('simple', "body")
      end`),
    /**
     * The pre-segmented form of `body`'s Han runs (space-joined bigrams, see
     * lib/domain/cjk.ts), written by the build for chunks that contain CJK
     * text and null otherwise. Stored rather than generated because Postgres
     * cannot compute it: segmentation is exactly what stock Postgres lacks
     * (migration 0011). Immutable like the rest of the row; changing the
     * segmentation scheme requires a CHUNKER_VERSION bump so every affected
     * version rebuilds instead of holding rows two schemes wrote.
     */
    bodySegmented: text('body_segmented'),
    /**
     * The CJK keyword index: `simple` is finally correct here because the
     * text arrives pre-segmented. Empty (not null) for non-CJK rows, so the
     * retrieval predicate can OR the two vectors without a null guard.
     */
    searchVectorCjk: customType<{ data: string; driverData: string; notNull: false }>({
      dataType: () => 'tsvector',
    })('search_vector_cjk').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("body_segmented", ''))`,
    ),
    embedding: vector('embedding', { dimensions: 1536 }),
  },
  (t) => [
    index('chunk_asset_version_idx').on(t.assetId, t.versionId),
    index('chunk_search_vector_cjk_idx').using('gin', t.searchVectorCjk),
    /*
     * No ANN index on `embedding` -- deliberately. architecture.md 9.1:
     * retrieval always pins one version first, so vector recall is an exact
     * scan of that version's few thousand rows via the index above. A global
     * HNSW here would be maintained on every ingestion insert and searched
     * with a filter it cannot honour. The picture-layer HNSW lives on
     * `asset_profile_vector`, which is small enough to be one.
     */
    index('chunk_search_vector_idx').using('gin', t.searchVector),
    /** One chunk per position, so a retried build cannot duplicate one. */
    uniqueIndex('chunk_position_uq').on(t.versionId, t.documentId, t.ordinal),
    /**
     * Every stored value has a `case` branch above. Without this a config with
     * no branch would generate a NULL vector -- a chunk that exists and can
     * never be found.
     */
    check('chunk_search_config_ck', sql`${t.searchConfig} in ('simple', 'arabic', 'armenian', 'basque', 'catalan', 'danish', 'dutch', 'english', 'finnish', 'french', 'german', 'greek', 'hindi', 'hungarian', 'indonesian', 'irish', 'italian', 'lithuanian', 'nepali', 'norwegian', 'portuguese', 'romanian', 'russian', 'serbian', 'spanish', 'swedish', 'tamil', 'turkish', 'yiddish')`),
  ],
);

/**
 * The asset profile: content-derived routing data. architecture.md 9.6.
 *
 * One row per built Version, written in the `profile` step of a build and
 * immutable after it, like everything else the version carries. Asset-level
 * discovery searches this row -- never `asset.title`, which on a UGC
 * platform carries no signal about the content.
 *
 * `search_text` is pre-segmented (space-joined titles and extracted terms, CJK
 * already split into n-grams by the domain extractor), which is why `simple`
 * is the right configuration here even though it is the wrong one for CJK
 * chunk bodies: segmentation happened before Postgres ever saw the text.
 */
export const assetProfile = pgTable(
  'asset_profile',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    versionId: uuid('version_id').notNull().references(() => assetVersion.id),
    /** Which extractor built this row; a new extractor rebuilds, never mixes. */
    profileVersion: text('profile_version').notNull(),
    documentTitles: jsonb('document_titles').$type<string[]>().notNull(),
    terms: jsonb('terms').$type<string[]>().notNull(),
    searchText: text('search_text').notNull(),
    searchVector: customType<{ data: string; driverData: string; notNull: false }>({
      dataType: () => 'tsvector',
    })('search_vector').generatedAlwaysAs(sql`to_tsvector('simple', "search_text")`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('asset_profile_version_uq').on(t.versionId),
    index('asset_profile_asset_idx').on(t.assetId),
    index('asset_profile_search_idx').using('gin', t.searchVector),
  ],
);

/**
 * The picture-layer vectors: centroid embeddings of a version's chunks, a
 * handful per asset. architecture.md 9.1 and 9.6 -- this table is the one
 * place a global HNSW is affordable and correct, because its row count is
 * assets x centroids (tens per asset), not chunks.
 */
export const assetProfileVector = pgTable(
  'asset_profile_vector',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').notNull().references(() => asset.id),
    versionId: uuid('version_id').notNull().references(() => assetVersion.id),
    ordinal: integer('ordinal').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
  },
  (t) => [
    uniqueIndex('asset_profile_vector_uq').on(t.versionId, t.ordinal),
    index('asset_profile_vector_asset_idx').on(t.assetId),
    index('asset_profile_vector_hnsw_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
);

/**
 * Retrieval's tunables, in force as the newest row. architecture.md 9.2, 9.6.
 *
 * Append-only like `llm_config`: a save mints a row, and the history is the
 * record of what retrieval was doing when. An empty table means the domain
 * defaults (`lib/domain/retrieval-config.ts`), which are the constants the
 * code used before this table existed. The newest row's id joins every
 * public cache key, so a change retires cached results without a flush.
 */
export const retrievalConfig = pgTable(
  'retrieval_config',
  {
    id: uuid('id').primaryKey(),
    recallLimit: integer('recall_limit').notNull(),
    rrfK: integer('rrf_k').notNull(),
    rerankWindow: integer('rerank_window').notNull(),
    rerankDocumentChars: integer('rerank_document_chars').notNull(),
    cacheTtlSeconds: integer('cache_ttl_seconds').notNull(),
    playgroundTokensDefault: integer('playground_tokens_default').notNull(),
    playgroundTokensMax: integer('playground_tokens_max').notNull(),
    routingRecallLimit: integer('routing_recall_limit').notNull(),
    routingRareSampleCap: integer('routing_rare_sample_cap').notNull(),
    routingResultLimit: integer('routing_result_limit').notNull(),
    playgroundAgent: integer('playground_agent').notNull().default(0),
    playgroundAgentSteps: integer('playground_agent_steps').notNull().default(4),
    playgroundAgentQueries: integer('playground_agent_queries').notNull().default(3),
    playgroundAgentResolves: integer('playground_agent_resolves').notNull().default(2),
    /** The channel directory's 热门 weights, in basis points (agent-first-proposal.md 6.4). */
    channelActivityBps: integer('channel_activity_bps').notNull().default(5000),
    channelFreshnessBps: integer('channel_freshness_bps').notNull().default(2500),
    channelQualityBps: integer('channel_quality_bps').notNull().default(2500),
    /** Half-life of the directory's freshness term, in days. */
    channelHalfLifeDays: integer('channel_half_life_days').notNull().default(14),
    /** A2A `ask`: Calls per answer and answers per workspace per day (agent-first-proposal.md 8.2). */
    askCallsPerAnswer: integer('ask_calls_per_answer').notNull().default(10),
    askDailyAnswers: integer('ask_daily_answers').notNull().default(500),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('retrieval_config_time_idx').on(t.createdAt.desc())],
);

/**
 * The playground's selectable models. architecture.md 9.5 -- the playground is
 * the only entry that calls a model, and these rows are what the console
 * configures: provider endpoint, model id, credential, budgets and unit
 * prices. The credential is sealed at rest and never leaves the server in the
 * clear (15.3); an edit that leaves the field blank carries the stored one
 * forward, so re-minting an entry does not mean re-typing the secret.
 *
 * Immutable versions like plans and policies, but a chain per `slug` rather
 * than one for the table: an entry's history is its rows in slug order, and
 * the configuration in force is the newest row of each slug. Editing an entry
 * appends; nothing here is ever updated, which is what keeps a cost event's
 * frozen prices meaning what they meant when it was written.
 */
export const llmConfig = pgTable(
  'llm_config',
  {
    id: uuid('id').primaryKey(),
    /** One model entry's stable identity; an edit mints a successor sharing it. */
    slug: text('slug').notNull(),
    /** What the console calls it -- a model id is rarely readable on its own. */
    label: text('label').notNull(),
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    /**
     * The provider credential, sealed with `CREDENTIAL_ENCRYPTION_KEY`
     * (`lib/infrastructure/crypto/credentials.ts`). Null on an entry nobody
     * has given a key yet, which is a model that cannot be called rather than
     * one quietly borrowing another entry's credential.
     */
    apiKeyCipher: text('api_key_cipher'),
    /** The model's context window; the playground sizes retrieval from it. */
    maxInputTokens: integer('max_input_tokens').notNull().default(8_000),
    maxOutputTokens: integer('max_output_tokens').notNull(),
    timeoutMs: integer('timeout_ms').notNull(),
    /** Micro-USD per million tokens, frozen per version like every price here. */
    promptPriceMicro: bigint('prompt_price_micro', { mode: 'number' }).notNull(),
    completionPriceMicro: bigint('completion_price_micro', { mode: 'number' }).notNull(),
    /** Rate for input tokens the provider served from its cache, read-side. */
    cachePriceMicro: bigint('cache_price_micro', { mode: 'number' }).notNull().default(0),
    /*
     * Declared abilities. Only `supportsReasoning` changes how the playground
     * calls the model today (it gates `reasoningEffort`); the other two record
     * what an entry is capable of, for entry points that can use them.
     */
    supportsTools: boolean('supports_tools').notNull().default(false),
    supportsReasoning: boolean('supports_reasoning').notNull().default(false),
    supportsVision: boolean('supports_vision').notNull().default(false),
    /** Null unless `supportsReasoning`; the application enforces that pairing. */
    reasoningEffort: text('reasoning_effort').$type<'minimal' | 'low' | 'medium' | 'high'>(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('llm_config_slug_time_idx').on(t.slug, t.createdAt.desc())],
);

/**
 * The retrieval models: the embedding model a version's vectors are built and
 * queried with, and the reranker that refines the fused head.
 * architecture.md 9.1, 9.2.
 *
 * One row per `kind`, newest in force -- there is exactly one model an
 * installation is indexing with and one reranker in front of its results, so
 * unlike `llm_config` there is nothing to assign. Append-only for the same
 * reason as `retrieval_config`: a change to either of these changes what
 * retrieval *is*, and the history of when it changed is the table itself.
 *
 * `dimensions` belongs only to an embedding entry and is what
 * `asset_version.embedding_dimensions` freezes; the stored vector columns
 * are wider and narrower vectors are padded into them (lib/domain/model-config.ts).
 * A rerank row leaves it null.
 */
export const providerModelConfig = pgTable(
  'provider_model_config',
  {
    id: uuid('id').primaryKey(),
    kind: modelKindEnum('kind').notNull(),
    /** What the console calls it -- a model id is rarely readable on its own. */
    label: text('label').notNull(),
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    /** Sealed like `llm_config.api_key_cipher`; never stored in the clear. */
    apiKeyCipher: text('api_key_cipher'),
    /** Embedding only; null on a rerank row. */
    dimensions: integer('dimensions'),
    timeoutMs: integer('timeout_ms').notNull(),
    /**
     * Switched off means the stage does not run: retrieval keeps its keyword
     * leg without an embedding model, and fusion order stands without a
     * reranker. Both are documented degradations, not failures.
     */
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('provider_model_config_kind_time_idx').on(t.kind, t.createdAt.desc()),
    /* A rerank row carrying a width would describe a model that does not
       exist, and an embedding row without one cannot be padded. */
    check(
      'provider_model_config_dimensions',
      sql`(${t.kind} = 'embedding') = (${t.dimensions} is not null)`,
    ),
  ],
);

/**
 * The rendering fallback a website build reaches when a site refuses the
 * plain fetch or serves a script shell. architecture.md 8.2. Append-only like
 * `provider_model_config`: one provider in force, the newest row. No row at
 * all means the deployment's `RENDER_PROVIDER*` variables.
 */
export const renderConfig = pgTable(
  'render_config',
  {
    id: uuid('id').primaryKey(),
    provider: renderProviderEnum('provider').notNull(),
    /**
     * A self-hosted instance; null calls the vendor's hosted API. Stored keys
     * are only ever sent to the hosted API, so a row with a base URL calls
     * without authentication.
     */
    baseUrl: text('base_url'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('render_config_time_idx').on(t.createdAt.desc())],
);

/**
 * Each provider's pool of API keys, tried in `position` order. Mutable, unlike
 * the configuration: a build records here that the provider called a key
 * spent or refused, and every console change is in the audit chain instead.
 */
export const renderProviderKey = pgTable(
  'render_provider_key',
  {
    id: uuid('id').primaryKey(),
    provider: renderProviderEnum('provider').notNull(),
    label: text('label').notNull(),
    /** Sealed like `provider_model_config.api_key_cipher`. */
    apiKeyCipher: text('api_key_cipher').notNull(),
    position: integer('position').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * What the provider last said was wrong with the key -- `exhausted` (402)
     * or `rejected` (401, AnySearch's 403) -- and when. A key that failed
     * within `RENDER_KEY_COOLDOWN_MS` is tried after the others; it is never
     * switched off by a build. Cleared when it answers again or from the
     * console.
     */
    failure: text('failure').$type<'exhausted' | 'rejected'>(),
    failureDetail: text('failure_detail'),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('render_provider_key_order_idx').on(t.provider, t.position),
    check(
      'render_provider_key_failure',
      sql`${t.failure} is null or ${t.failure} in ('exhausted', 'rejected')`,
    ),
  ],
);

/**
 * Which registry entry answers which callers: the model the platform spends
 * on a visitor who has paid nothing (`trial`: anonymous, or a workspace on
 * the free plan) and the one a paid subscription buys (`subscriber`).
 * Append-only; the newest row is in force. Null trial means the newest
 * enabled entry; null subscriber means the trial model.
 */
export const llmAudienceAssignment = pgTable(
  'llm_audience_assignment',
  {
    id: uuid('id').primaryKey(),
    trialSlug: text('trial_slug'),
    subscriberSlug: text('subscriber_slug'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('llm_audience_assignment_time_idx').on(t.createdAt.desc())],
);

/**
 * One row per model call the playground made: the cost metric of 9.5 ("模型
 * Token 只进成本指标"). Token counts and the cost computed with the config's
 * frozen prices -- never the query, never the answer (same secrecy as the
 * query itself). The asset is referenced by public id, deliberately without
 * a foreign key: spend history must survive the asset it was spent on.
 */
export const llmCostEvent = pgTable(
  'llm_cost_event',
  {
    id: uuid('id').primaryKey(),
    configId: uuid('config_id').notNull().references(() => llmConfig.id),
    assetPublicId: text('asset_public_id').notNull(),
    workspaceId: uuid('workspace_id'),
    model: text('model').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    /** Of `promptTokens`, the ones the provider served from cache. */
    cachedTokens: integer('cached_tokens').notNull().default(0),
    /** Of `completionTokens`, the ones spent thinking. A breakdown, not an addition. */
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    costMicroUsd: bigint('cost_micro_usd', { mode: 'number' }).notNull(),
    latencyMs: integer('latency_ms'),
    /** `answer` for the playground and the widget; `review` for the model layer of public review. */
    purpose: text('purpose').notNull().default('answer'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('llm_cost_event_time_idx').on(t.createdAt)],
);

// ---------------------------------------------------------------- policy, usage, ops

export const policyVersion = pgTable('policy_version', {
  id: uuid('id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
  mode: policyModeEnum('mode'),
  sourceTypes: jsonb('source_types').$type<Record<string, boolean>>().notNull().default({}),
  qualityFilters: jsonb('quality_filters').$type<Record<string, unknown>>().notNull().default({}),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const policyAssetEntry = pgTable('policy_asset_entry', {
  id: uuid('id').primaryKey(),
  policyVersionId: uuid('policy_version_id').notNull().references(() => policyVersion.id),
  kind: text('kind').notNull(),
  targetType: text('target_type').notNull(),
  targetValue: text('target_value').notNull(),
});

export const usageReservation = pgTable(
  'usage_reservation',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    requestId: text('request_id').notNull(),
    status: reservationStatusEnum('status').notNull(),
    /** Seats held: 1 for a retrieval, the quoted cap for a build. */
    calls: integer('calls').notNull().default(1),
    /**
     * 'retrieval' or 'build'. The abandoned-seat sweep in `reserveCall` only
     * releases retrieval seats: a build's seat outlives the sweep's TTL and
     * is released by the operation that holds it.
     */
    kind: text('kind').notNull().default('retrieval'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('usage_reservation_request_uq').on(t.requestId),
    /** The per-request quota transaction counts a workspace's reservations. */
    index('usage_reservation_workspace_idx').on(t.workspaceId),
  ],
);

export const usageEvent = pgTable(
  'usage_event',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    requestId: text('request_id').notNull(),
    assetId: uuid('asset_id').references(() => asset.id),
    versionId: uuid('version_id').references(() => assetVersion.id),
    operation: text('operation').notNull(),
    entrypoint: text('entrypoint').notNull(),
    /** 'plan' or 'addon'. Recorded so billing disputes need no reconstruction. */
    debitSource: text('debit_source').notNull(),
    addonGrantId: uuid('addon_grant_id').references(() => addonGrant.id),
    statusCode: integer('status_code').notNull(),
    latencyMs: integer('latency_ms'),
    inputTokens: integer('input_tokens'),
    returnedTokens: integer('returned_tokens'),
    /**
     * The event's weight against the allowance: 1 for every retrieval, the
     * priced figure for a build (`entrypoint = 'build'`). Every count of
     * consumption sums this rather than counting rows.
     */
    calls: integer('calls').notNull().default(1),
    /** A build's measurements and the rates it was priced at. `BuildDetail`. */
    buildDetail: jsonb('build_detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('usage_event_request_uq').on(t.requestId),
    index('usage_event_workspace_time_idx').on(t.workspaceId, t.createdAt),
    /** Retrieval calls per asset, for the console's per-asset figures. */
    index('usage_event_asset_time_idx').on(t.assetId, t.createdAt),
    /** "What did this version's build cost", read by the asset page. */
    index('usage_event_version_idx')
      .on(t.versionId)
      .where(sql`${t.entrypoint} = 'build'`),
  ],
);

export const usageSummary = pgTable(
  'usage_summary',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    bucketDate: timestamp('bucket_date', { withTimezone: true }).notNull(),
    /** Retrieval calls in the bucket. */
    calls: integer('calls').notNull().default(0),
    /** Build calls in the bucket, kept apart so the dashboard can say which is which. */
    buildCalls: integer('build_calls').notNull().default(0),
  },
  (t) => [uniqueIndex('usage_summary_uq').on(t.workspaceId, t.bucketDate)],
);

export const publisherAccount = pgTable(
  'publisher_account',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspace.id),
    providerAccountId: text('provider_account_id'),
    taxStatus: text('tax_status').notNull().default('pending'),
    agreementVersion: text('agreement_version'),
    /**
     * The creator's payout profile (agent-first-proposal.md 6.9): the PayPal
     * address payouts go to, and the record of the tax document the creator
     * sent to operations -- which kind, where it stands (`missing`,
     * `submitted`, `verified`), and when each step happened. The document
     * itself never lands here; which kinds suffice is still open (13.2).
     * Income accrues regardless; a payout needs both an address and a
     * `verified` document.
     */
    payeeEmail: text('payee_email'),
    taxFormKind: text('tax_form_kind'),
    taxFormStatus: text('tax_form_status').$type<'missing' | 'submitted' | 'verified'>().notNull().default('missing'),
    taxFormSubmittedAt: timestamp('tax_form_submitted_at', { withTimezone: true }),
    taxFormVerifiedAt: timestamp('tax_form_verified_at', { withTimezone: true }),
    /** The administrator who verified it; FK in the migration only, like `payout.resolved_by`. */
    taxFormVerifiedBy: uuid('tax_form_verified_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  /** One account per workspace: the application check-then-inserts on it. */
  (t) => [uniqueIndex('publisher_account_workspace_uq').on(t.workspaceId)],
);

/**
 * One amount credited to a creator's workspace, or taken back from it: the
 * ledger the monthly close sums. agent-first-proposal.md 6.9: a channel
 * subscription collection writes the creator's share as a positive row, a
 * refund or chargeback writes the negative, and a written-off balance writes
 * what the platform absorbed. Nothing writes it yet -- the collection side
 * arrives with channel subscriptions -- but the close, the statements, the
 * hold and the payout rails read it as it stands.
 *
 * `flagged` excludes a row from every sum without deleting it, so a ledger
 * correction stays visible. Nothing sets it today.
 */
export const earningEvent = pgTable(
  'earning_event',
  {
    id: uuid('id').primaryKey(),
    ownerWorkspaceId: uuid('owner_workspace_id').notNull().references(() => workspace.id),
    /** The creator's share in minor units; negative for a refund or chargeback. */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    /** What produced the row, e.g. `channel_subscription`, `refund`, `chargeback`, `written_off`. */
    source: text('source').notNull(),
    /**
     * What the row mirrors at the provider: the transaction for a collection,
     * the adjustment for a refund or chargeback. With `source` it is the
     * row's identity, so a redelivered webhook writes nothing twice.
     */
    reference: text('reference'),
    periodId: text('period_id').notNull(),
    flagged: boolean('flagged').notNull().default(false),
    /**
     * Where a channel collection came from (proposal 12): the channel, the
     * subscription, the transaction, its ex-tax subtotal and the share of it
     * the creator was due under the plan version. Null on a write-off.
     */
    channelId: uuid('channel_id'),
    channelSubscriptionId: uuid('channel_subscription_id'),
    providerTransactionId: text('provider_transaction_id'),
    grossMinor: bigint('gross_minor', { mode: 'number' }),
    shareBps: integer('share_bps'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('earning_event_period_owner_idx').on(t.periodId, t.ownerWorkspaceId),
    /** The owner's running balance, which every payout and new paid plan checks. */
    index('earning_event_owner_idx').on(t.ownerWorkspaceId),
    uniqueIndex('earning_event_reference_uq')
      .on(t.source, t.reference)
      .where(sql`${t.reference} is not null`),
  ],
);

/**
 * A UTC calendar month of the ledger. Inserted by the close, which takes it
 * `FOR UPDATE`; `locked_at` set means the sums are frozen and a re-run returns
 * them instead of recomputing.
 */
export const revenuePeriod = pgTable(
  'revenue_period',
  {
    id: text('id').primaryKey(),
    currency: text('currency').notNull().default('USD'),
    /** What the close summed over the period's unflagged events, all owners together. */
    totalAmountMinor: bigint('total_amount_minor', { mode: 'number' }).notNull().default(0),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
  },
);

/**
 * One statement per publisher account per period: the owner's unflagged
 * events in the period, summed. The row is what the hold, the credit path and
 * the payout rail act on, and what the earning anchor commits to.
 */
export const settlement = pgTable(
  'settlement',
  {
    id: uuid('id').primaryKey(),
    periodId: text('period_id').notNull().references(() => revenuePeriod.id),
    publisherAccountId: uuid('publisher_account_id').notNull().references(() => publisherAccount.id),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    status: settlementStatusEnum('status').notNull(),
    statementDigest: text('statement_digest'),
    /**
     * The grant a `redeemed` statement became, so the discharge is traceable in
     * both directions: statement -> calls here, calls -> statements by joining
     * back. Null unless the status is `redeemed`.
     */
    addonGrantId: uuid('addon_grant_id').references(() => addonGrant.id),
    /**
     * The cash payout the statement is in: set while it is `held` in a request
     * and kept once `paid`; cleared when the payout fails and the statement
     * returns to `accrued`. The foreign key lives in the migration only, for the
     * same forward-reference reason as `addon_grant.publisher_account_id`.
     */
    payoutId: uuid('payout_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  /** "Which statements does this payout cover", read when it is marked paid or failed. */
  (t) => [index('settlement_payout_idx').on(t.payoutId)],
);

/**
 * A cash payout, paid by hand (agent-first-proposal.md 6.9): the creator
 * requests it with a PayPal address, an operator sends the money from the
 * platform's PayPal account and records the transaction id here. `status` is
 * `requested`, `paid` or `failed`; at most one request per publisher is open.
 */
export const payout = pgTable(
  'payout',
  {
    id: uuid('id').primaryKey(),
    publisherAccountId: uuid('publisher_account_id').notNull().references(() => publisherAccount.id),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    /** The rail; `paypal` is the only one. */
    method: text('method').notNull().default('paypal'),
    /** Where the money goes: a PayPal account email, never a card or bank number. */
    payeeEmail: text('payee_email'),
    /** The PayPal transaction id the operator entered when marking it paid. */
    providerReference: text('provider_reference'),
    status: text('status').notNull(),
    failureReason: text('failure_reason'),
    /** Who asked for it, as `user:<id>` or `api_key:<id>`, like `addon_grant.redeemed_by`. */
    requestedBy: text('requested_by'),
    /** The administrator who marked it paid or failed; FK in the migration only. */
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** One open request per publisher: a second press cannot split the statements. */
    uniqueIndex('payout_open_uq')
      .on(t.publisherAccountId)
      .where(sql`${t.status} = 'requested'`),
    /** The console queue, oldest request first. */
    index('payout_status_time_idx').on(t.status, t.createdAt),
  ],
);

// ---------------------------------------------------------------- anchoring

export const anchorBatch = pgTable(
  'anchor_batch',
  {
    id: uuid('id').primaryKey(),
    subjectType: anchorSubjectEnum('subject_type').notNull(),
    leafSchemaVersion: integer('leaf_schema_version').notNull(),
    merkleRoot: text('merkle_root').notNull(),
    leafCount: integer('leaf_count').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    network: text('network').notNull(),
    txHash: text('tx_hash'),
    status: anchorBatchStatusEnum('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /**
     * When the batch was planned, not when its window closed. A backfill
     * anchors versions published days earlier, so `window_end` would make every
     * catch-up batch look overdue the moment it existed; the staleness alarm
     * needs this clock instead (aptos-anchoring-proposal.md 4.8).
     */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('anchor_batch_tx_uq').on(t.txHash)],
);

export const anchorLeaf = pgTable(
  'anchor_leaf',
  {
    id: uuid('id').primaryKey(),
    batchId: uuid('batch_id').notNull().references(() => anchorBatch.id),
    leafHash: text('leaf_hash').notNull(),
    leafSchemaVersion: integer('leaf_schema_version').notNull(),
    subjectType: anchorSubjectEnum('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    leafIndex: integer('leaf_index').notNull(),
    merkleProof: jsonb('merkle_proof').$type<string[]>(),
  },
  (t) => [
    uniqueIndex('anchor_leaf_subject_uq').on(
      t.subjectType,
      t.subjectId,
      t.leafSchemaVersion,
    ),
  ],
);

// ---------------------------------------------------------------- operations & admin

export const workflowOperation = pgTable(
  'workflow_operation',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id').references(() => asset.id),
    operationType: text('operation_type').notNull(),
    sourceDigest: text('source_digest'),
    /**
     * A refresh asked for one source only: that source is fetched, the
     * others are carried forward from the current version unfetched. Null
     * means every source.
     */
    sourceId: uuid('source_id'),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    /**
     * `manual` for an operator's button or a workspace action, `scheduled`
     * for a refresh the drain queued from a source's refresh policy.
     * `lib/domain/ingestion.ts` `OperationTrigger`.
     */
    trigger: text('trigger').notNull().default('manual'),
    /**
     * How the pages of a build were fetched -- our own fetch vs a rendering
     * provider, per page. Written by the build after `fetch-snapshot`; null
     * for operations that fetch nothing or from sources with no such choice.
     * `lib/domain/ingestion.ts` `FetchSummary`.
     */
    fetchSummary: jsonb('fetch_summary').$type<{
      direct: number;
      rendered: number;
      renderer: 'firecrawl' | 'anysearch' | 'jina' | null;
    }>(),
    /**
     * Where a running build is: the architecture.md 8.2 step it is in and
     * what it has counted so far. Written by the build at each stage
     * boundary and once per embedding window; kept on the finished row as
     * its final figures. `lib/domain/ingestion.ts` `BuildProgress`.
     */
    stage: text('stage'),
    progress: jsonb('progress').$type<{
      files?: number;
      documents?: number;
      chunksTotal?: number;
      chunksDone?: number;
    }>(),
    /**
     * The build's seat in the call ledger. asset-build-billing.md 4:
     * `quoted_calls` is the cap reserved before fetching, `charged_calls` the
     * priced figure once chunking measured the build; the reservation is
     * committed with the version's publication and released on every other
     * outcome. All null for a build that was never billable.
     */
    reservationId: uuid('reservation_id').references(() => usageReservation.id),
    quotedCalls: integer('quoted_calls'),
    chargedCalls: integer('charged_calls'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('workflow_operation_uq').on(t.assetId, t.sourceDigest, t.operationType),
    /** "Is anything open for this asset", and the queue depth above the list. */
    index('workflow_operation_asset_idx').on(t.assetId, t.operationType, t.status),
    /** The queue drain: oldest pending first, which every worker asks for. */
    index('workflow_operation_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    /** "What finished in the last day", the console's health panel. */
    index('workflow_operation_updated_idx').on(t.updatedAt),
  ],
);

export const requestLog = pgTable(
  'request_log',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id').references(() => workspace.id),
    requestId: text('request_id').notNull(),
    operation: text('operation').notNull(),
    /**
     * By public id and without a foreign key, like the cost events: the
     * request history a user reads must survive the asset it touched.
     * The query text is deliberately absent (architecture.md 17.1).
     */
    assetPublicId: text('asset_public_id'),
    /** 'rest' | 'mcp' | 'web' -- which door the request came through. */
    entrypoint: text('entrypoint'),
    statusCode: integer('status_code').notNull(),
    latencyMs: integer('latency_ms'),
    /** Tokens served, as the usage event counts them. Null when nothing was. */
    returnedTokens: integer('returned_tokens'),
    /**
     * The key that authenticated the request, so the screen can show its
     * masked prefix. No foreign key, like the asset above: the log must
     * outlive whatever it names, and a key row is only ever revoked anyway.
     */
    apiKeyId: uuid('api_key_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('request_log_workspace_time_idx').on(t.workspaceId, t.createdAt),
    /**
     * The console's health panel counts the last day's requests across every
     * workspace. Without a time-only index that is a scan of the busiest
     * table in the schema on every overview render.
     */
    index('request_log_time_idx').on(t.createdAt),
  ],
);

export const report = pgTable('report', {
  id: uuid('id').primaryKey(),
  assetId: uuid('asset_id').notNull().references(() => asset.id),
  reporterUserId: uuid('reporter_user_id').references(() => user.id),
  category: text('category').notNull(),
  detail: text('detail'),
  resolution: text('resolution'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const administrator = pgTable(
  'administrator',
  {
    id: uuid('id').primaryKey(),
    username: text('username').notNull(),
    email: text('email').notNull(),
    /**
     * Argon2id. Admin identity is separate from user OAuth (requirement.md 3.2).
     * Null until an invited administrator finishes enrolment -- a placeholder
     * hash would be a credential that exists but nobody chose.
     */
    passwordHash: text('password_hash'),
    /**
     * TOTP shared secret, sealed with `CREDENTIAL_ENCRYPTION_KEY` -- a plain
     * secret here would make the second factor worth exactly as much as the
     * password hash it sits next to.
     */
    mfaSecret: text('mfa_secret'),
    /**
     * Highest TOTP step already spent on a successful sign-in. A code is only
     * accepted strictly above it, so an observed code cannot be replayed inside
     * its own validity window (RFC 6238 5.2).
     */
    mfaLastCounter: bigint('mfa_last_counter', { mode: 'number' }),
    mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
    /** `invited` until enrolment completes, then `active`, or `disabled`. */
    status: text('status').notNull().default('invited'),
    /**
     * Single-use enrolment secret, stored as a keyed digest like every other
     * token here, with a deadline so a forgotten invitation stops being a way in.
     */
    inviteTokenHash: text('invite_token_hash'),
    inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true }),
    invitedBy: uuid('invited_by'),
    /** Reset on a successful sign-in; drives the lockout in lib/domain/admin. */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('administrator_username_uq').on(t.username),
    uniqueIndex('administrator_email_uq').on(t.email),
    uniqueIndex('administrator_invite_token_uq').on(t.inviteTokenHash),
  ],
);

/**
 * Console session digest, deliberately a different table from `user_session`.
 *
 * Two authorities, two stores: a product session can never be presented as an
 * admin one and vice versa, whatever a cookie says (requirement.md 3.2).
 */
export const adminSession = pgTable(
  'admin_session',
  {
    id: uuid('id').primaryKey(),
    administratorId: uuid('administrator_id')
      .notNull()
      .references(() => administrator.id),
    tokenHash: text('token_hash').notNull(),
    clientSummary: jsonb('client_summary').$type<Record<string, string>>().notNull().default({}),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('admin_session_token_hash_uq').on(t.tokenHash)],
);

export const adminRole = pgTable('admin_role', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const adminPermission = pgTable(
  'admin_permission',
  {
    roleId: text('role_id').notNull().references(() => adminRole.id),
    capability: text('capability').notNull(),
    level: text('level').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.capability] })],
);

export const administratorRole = pgTable(
  'administrator_role',
  {
    administratorId: uuid('administrator_id').notNull().references(() => administrator.id),
    roleId: text('role_id').notNull().references(() => adminRole.id),
  },
  (t) => [primaryKey({ columns: [t.administratorId, t.roleId] })],
);

/**
 * Append only. The database role gets INSERT and SELECT, never UPDATE or DELETE.
 * prevHash/hash form the chain whose daily head is anchored. architecture.md 14.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    /**
     * Insertion order, and the only unambiguous way to find the chain head:
     * two entries can share `created_at` to the microsecond, and random uuids
     * give no tie-break.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    administratorId: uuid('administrator_id').references(() => administrator.id),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    reason: text('reason'),
    beforeValue: jsonb('before_value'),
    afterValue: jsonb('after_value'),
    ipDigest: text('ip_digest'),
    result: text('result').notNull(),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('audit_log_hash_uq').on(t.hash),
    index('audit_log_time_idx').on(t.createdAt),
    /*
     * Declared because `seq DESC` is a read path, not just a write one: the
     * chain head is read under the writer's advisory lock on every append, and
     * the console lists the log in this order a page at a time. It exists in
     * the database from 0004; leaving it out here would let the next generated
     * migration drop it and turn both into a sort of the whole table.
     */
    index('audit_log_seq_idx').on(t.seq.desc()),
    /** One target's history, newest first -- how the console reads the log. */
    index('audit_log_target_idx').on(t.targetType, t.targetId, t.seq.desc()),
  ],
);

/**
 * A2A tasks (agent-first-proposal.md 7.6, 7.8). The SDK keeps tasks in one
 * function instance's memory; this is the store every instance shares
 * (lib/application/a2a/task-store.ts). Scoped by tenant and calling workspace
 * -- null for an anonymous caller. `history` and `artifacts` carry the bodies
 * and are cleared at `body_purge_at` (proposal 10).
 */
export const a2aTask = pgTable(
  'a2a_task',
  {
    id: text('id').primaryKey(),
    contextId: text('context_id').notNull(),
    workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    apiKeyId: uuid('api_key_id'),
    tenant: text('tenant').notNull().default(''),
    skill: text('skill'),
    state: text('state').notNull(),
    status: jsonb('status').$type<Record<string, unknown>>().notNull().default({}),
    history: jsonb('history').$type<unknown[]>().notNull().default([]),
    artifacts: jsonb('artifacts').$type<unknown[]>().notNull().default([]),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    workflowRunId: text('workflow_run_id'),
    bodyPurgeAt: timestamp('body_purge_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('a2a_task_owner_idx').on(t.workspaceId, t.tenant, t.updatedAt.desc()),
    index('a2a_task_purge_idx').on(t.bodyPurgeAt),
  ],
);

/**
 * Workbench conversations (agent-first-proposal.md 4.4, 12): one thread of
 * the signed-in owner's exchanges with the re0 Agent. The turns live in
 * `agent_message`; a conversation is a title and its workspace.
 */
export const agentConversation = pgTable(
  'agent_conversation',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_conversation_workspace_idx').on(t.workspaceId, t.updatedAt.desc())],
);

/**
 * One turn of a workbench conversation: the owner's question, or what the
 * server showed in reply -- bound claims, their sources, the pending actions
 * it proposed, a listing. Never the planner's own text, which is not shown
 * to anyone (playground/agent.ts).
 */
export const agentMessage = pgTable(
  'agent_message',
  {
    id: uuid('id').primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => agentConversation.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agent_message_conversation_idx').on(t.conversationId, t.createdAt)],
);

/**
 * A pending action (agent-first-proposal.md 5.2, 7.6, 12): what the Agent
 * or an A2A caller asked to do with side effects, written down instead of
 * done. Only the signed-in owner can confirm it, from the Dashboard; the
 * server then runs it once, as that person, and audits it.
 *
 * `params` is frozen at creation and `params_digest` is its hash: a
 * confirmation names the digest it was shown, so a card that went stale
 * confirms nothing, and changed parameters are a new row. `state` moves
 * once out of `pending` -- to `confirmed` (executed), `failed` (confirmed
 * but refused when it ran), `rejected` or `expired` -- by a conditional
 * update, which is what makes confirmation one-shot. A linked A2A task
 * follows: `INPUT_REQUIRED` while pending, `FAILED` on rejection or expiry.
 */
export const agentAction = pgTable(
  'agent_action',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    /** `create_asset`, `refresh_asset`, `create_channel`, `move_asset` (proposal 5.1). */
    tool: text('tool').notNull(),
    params: jsonb('params').$type<Record<string, unknown>>().notNull(),
    paramsDigest: text('params_digest').notNull(),
    /** What the confirmation card says, written by the server from the params: never model text. */
    summary: jsonb('summary').$type<Record<string, unknown>>().notNull(),
    estimatedCalls: integer('estimated_calls').notNull().default(0),
    estimatedBytes: bigint('estimated_bytes', { mode: 'number' }),
    makesPublic: boolean('makes_public').notNull().default(false),
    state: text('state')
      .$type<'pending' | 'confirmed' | 'failed' | 'rejected' | 'expired'>()
      .notNull()
      .default('pending'),
    /** Who asked: the workbench (a signed-in user) or an A2A caller. */
    origin: text('origin').$type<'workbench' | 'a2a'>().notNull(),
    requestedBy: uuid('requested_by').references(() => user.id, { onDelete: 'set null' }),
    apiKeyId: uuid('api_key_id'),
    conversationId: uuid('conversation_id').references(() => agentConversation.id, { onDelete: 'set null' }),
    a2aTaskId: text('a2a_task_id').references(() => a2aTask.id, { onDelete: 'set null' }),
    confirmedBy: uuid('confirmed_by').references(() => user.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** What running it produced (ids, the build operation), server-written. */
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_action_workspace_idx').on(t.workspaceId, t.state, t.createdAt.desc()),
    index('agent_action_task_idx').on(t.a2aTaskId),
    index('agent_action_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.state} = 'pending'`),
    check(
      'agent_action_state_check',
      sql`${t.state} in ('pending', 'confirmed', 'failed', 'rejected', 'expired')`,
    ),
  ],
);

/**
 * A2A push-notification configs (agent-first-proposal.md 7.6, 7.8). The
 * callback URL passed the source-fetch SSRF checks when it was registered
 * and is checked again before every send; the token and any credentials are
 * sealed (`sealCredential`), never stored in the clear.
 */
export const a2aPushConfig = pgTable(
  'a2a_push_config',
  {
    id: text('id').notNull(),
    /*
     * No foreign key: a config sent inline with SendMessage is saved by the
     * SDK before the task row exists. Configs are scoped by workspace and
     * tenant, and sent only for tasks that exist.
     */
    taskId: text('task_id').notNull(),
    workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    tenant: text('tenant').notNull().default(''),
    url: text('url').notNull(),
    /** `{token, authentication}` sealed; null when the caller sent neither. */
    secret: text('secret'),
    wireVersion: text('wire_version').notNull().default('1.0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.id] })],
);

// ------------------------------------------------------- A2A client (P4)

/**
 * External A2A Agents a workspace registered (agent-first-proposal.md 7.9).
 * The card was fetched through the push-callback SSRF checks and is kept as
 * a snapshot: the interfaces re0 can use (JSON-RPC and HTTP+JSON, A2A 1.0 or
 * 0.3), the skills, the security schemes reduced to what re0 can send. A
 * re-fetch replaces the snapshot; a delegation proposed against the old one
 * fails as stale if its endpoint is gone.
 */
export const externalAgent = pgTable(
  'external_agent',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
    cardUrl: text('card_url').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    providerName: text('provider_name'),
    version: text('version'),
    /** `AgentEndpoint[]`, in the order re0 prefers them. */
    endpoints: jsonb('endpoints').$type<Record<string, unknown>[]>().notNull(),
    skills: jsonb('skills').$type<Record<string, unknown>[]>().notNull().default([]),
    /** Scheme name -> `SchemeSnapshot`. */
    securitySchemes: jsonb('security_schemes').$type<Record<string, unknown>>().notNull().default({}),
    securityRequirements: jsonb('security_requirements').$type<unknown[]>().notNull().default([]),
    /** The whole card as fetched, in A2A 1.0 JSON. */
    card: jsonb('card').$type<Record<string, unknown>>().notNull(),
    cardDigest: text('card_digest').notNull(),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_agent_card_uq').on(t.workspaceId, t.cardUrl),
    check('external_agent_status_ck', sql`${t.status} in ('active', 'disabled')`),
  ],
);

/**
 * The credential sent to one external Agent: sealed with `sealCredential`
 * under the `agent` purpose, opened only at send time. `suffix` is the one
 * part ever shown again. `version` goes up on every rotation, and a pending
 * delegation names the version it was shown, so a rotated credential is not
 * sent on a card that showed the old one.
 */
export const externalAgentCredential = pgTable(
  'external_agent_credential',
  {
    agentId: uuid('agent_id')
      .primaryKey()
      .references(() => externalAgent.id, { onDelete: 'cascade' }),
    id: uuid('id').notNull(),
    kind: text('kind').$type<'bearer' | 'api_key'>().notNull(),
    sealed: text('sealed').notNull(),
    suffix: text('suffix'),
    version: integer('version').notNull().default(1),
    updatedBy: uuid('updated_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('external_agent_credential_kind_ck', sql`${t.kind} in ('bearer', 'api_key')`)],
);

/**
 * One confirmed delegation (proposal 7.9): the SendMessage re0 sent as an
 * A2A client and the remote task it started. `state` is the remote task's
 * state name, `MESSAGE` when the Agent answered with a message, or
 * `SEND_FAILED`. `status_message` and `output` are the external Agent's
 * words -- untrusted, shown as data -- and are cleared at `body_purge_at`
 * with the sent text in the action's params (proposal 10).
 */
export const agentDelegation = pgTable(
  'agent_delegation',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    actionId: uuid('action_id').references(() => agentAction.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references(() => externalAgent.id, { onDelete: 'set null' }),
    /** The agent's name when this was sent: the record outlives the registration. */
    agentName: text('agent_name').notNull(),
    conversationId: uuid('conversation_id').references(() => agentConversation.id, { onDelete: 'set null' }),
    skill: text('skill'),
    endpointUrl: text('endpoint_url').notNull(),
    remoteTaskId: text('remote_task_id'),
    remoteContextId: text('remote_context_id'),
    state: text('state').notNull(),
    statusMessage: text('status_message'),
    /** `{ text, data }` parts of the artifacts or the reply, clipped (OUTPUT_MAX_CHARS). */
    output: jsonb('output').$type<Record<string, unknown>[]>().notNull().default([]),
    error: text('error'),
    bodyPurgeAt: timestamp('body_purge_at', { withTimezone: true }).notNull(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('agent_delegation_workspace_idx').on(t.workspaceId, t.createdAt.desc()),
    uniqueIndex('agent_delegation_action_uq').on(t.actionId),
    index('agent_delegation_purge_idx').on(t.bodyPurgeAt),
  ],
);

// ---------------------------------------------------------------- creators (P3)

/**
 * An article's working copy (agent-first-proposal.md 6.5, 12). A draft is
 * not part of the version line: only publishing copies it into the
 * asset's `editor` source and builds a version. `publish_at` set is a
 * scheduled publication the queue drain carries out.
 */
export const postDraft = pgTable(
  'post_draft',
  {
    assetId: uuid('asset_id')
      .primaryKey()
      .references(() => asset.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    summary: text('summary'),
    body: text('body').notNull().default(''),
    publishAt: timestamp('publish_at', { withTimezone: true }),
    /** Where publishing puts the post, and whether it is `paid` there; null keeps it where it is. */
    channelId: uuid('channel_id').references(() => channel.id, { onDelete: 'set null' }),
    access: text('access').$type<'free' | 'paid'>().notNull().default('free'),
    updatedBy: uuid('updated_by').references(() => user.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  /** The drain's "which scheduled posts are due". */
  (t) => [index('post_draft_due_idx').on(t.publishAt).where(sql`${t.publishAt} is not null`)],
);

/**
 * An uploaded file an asset carries beside its text (proposal 6.5, 6.6, 12;
 * the proposal's `audio_media`, widened to article images): the object in
 * the private bucket, what it is, and its SHA-256, which a version's digest
 * covers. `ready` rows count toward the workspace's capacity; a replaced
 * episode file is `replaced` and no longer counts. Bytes are served only
 * through short-lived signed URLs issued per request to entitled readers
 * (`app/media/[mediaId]`), never as a download.
 */
export const assetMedia = pgTable(
  'asset_media',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => asset.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'image' | 'audio'>().notNull(),
    objectKey: text('object_key').notNull(),
    mime: text('mime').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    durationMs: integer('duration_ms'),
    /** An image's caption: indexed in place of the image (proposal 6.5). */
    caption: text('caption'),
    state: text('state').$type<'pending' | 'ready' | 'replaced'>().notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('asset_media_asset_idx').on(t.assetId, t.kind, t.createdAt.desc()),
    index('asset_media_workspace_idx').on(t.workspaceId).where(sql`${t.state} = 'ready'`),
    check('asset_media_kind_ck', sql`${t.kind} in ('image', 'audio')`),
    check('asset_media_state_ck', sql`${t.state} in ('pending', 'ready', 'replaced')`),
  ],
);

/**
 * A reader's comment on an asset in a channel (proposal 6.8). Not an asset:
 * no version, no chunk, never retrieved, never evidence, never anchored.
 * One level of replies (`parent_id` names a top-level comment). `state`:
 * `visible`; `hidden` by the creator or by the content check (`hidden_reason`
 * says which); `deleted` by its author or blanked when the author's account
 * goes; `removed` by the platform.
 */
export const comment = pgTable(
  'comment',
  {
    id: uuid('id').primaryKey(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => asset.id, { onDelete: 'cascade' }),
    authorUserId: uuid('author_user_id').references(() => user.id, { onDelete: 'set null' }),
    /** A self-reference, so its foreign key (cascading) lives in the migration only. */
    parentId: uuid('parent_id'),
    body: text('body').notNull(),
    state: text('state').$type<'visible' | 'hidden' | 'deleted' | 'removed'>().notNull().default('visible'),
    hiddenReason: text('hidden_reason').$type<'creator' | 'scan'>(),
    findings: jsonb('findings').$type<string[]>().notNull().default([]),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('comment_asset_idx').on(t.assetId, t.createdAt),
    /** The rate limit counts an author's recent comments. */
    index('comment_author_idx').on(t.authorUserId, t.createdAt.desc()),
    index('comment_parent_idx').on(t.parentId),
    check('comment_state_ck', sql`${t.state} in ('visible', 'hidden', 'deleted', 'removed')`),
  ],
);

/** A reader's report of a comment; the console resolves it (proposal 6.8). */
export const commentReport = pgTable(
  'comment_report',
  {
    id: uuid('id').primaryKey(),
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comment.id, { onDelete: 'cascade' }),
    reporterUserId: uuid('reporter_user_id').references(() => user.id, { onDelete: 'set null' }),
    reason: text('reason').notNull(),
    resolution: text('resolution'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('comment_report_once_uq').on(t.commentId, t.reporterUserId),
    index('comment_report_open_idx').on(t.createdAt).where(sql`${t.resolvedAt} is null`),
  ],
);

/** One passage behind a twin answer: its marker number and citation, and its text when the answer degraded. */
export interface TwinPassage {
  ref: number;
  chunkId: string;
  publicId: string;
  versionLabel: string;
  sourceUrl: string;
  documentTitle: string;
  section: string | null;
  text: string | null;
}

/**
 * One answer of a channel's AI twin to a signed-in reader (proposal 6.3,
 * 6.7): the question, the bound claims and the asset versions they cite.
 * Kept so the creator can mark one 作者确认 and so an unanswered one can
 * land in the pending-questions list. The asker is never shown.
 */
export const twinAnswer = pgTable(
  'twin_answer',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    askerUserId: uuid('asker_user_id').references(() => user.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    outcome: text('outcome').$type<'answer' | 'degraded' | 'no_context'>().notNull(),
    claims: jsonb('claims').$type<{ claim: string; chunkIds: string[] }[]>().notNull().default([]),
    /** The asset versions the answer stood on, first the one most cited. */
    versions: jsonb('versions')
      .$type<{ assetId: string; publicId: string; title: string; versionId: string; label: string }[]>()
      .notNull()
      .default([]),
    /**
     * Evidence rules 5 and 6 (requirement.md 5.1): the passages the claims
     * cite, numbered as the page marks them, or -- for a degraded answer --
     * every passage the reader was billed for, with its text.
     */
    passages: jsonb('passages').$type<TwinPassage[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('twin_answer_channel_idx').on(t.channelId, t.createdAt.desc())],
);

/**
 * 作者确认 (proposal 6.7): the creator vouches for one twin answer. Bound to
 * the version the answer used, so after the asset updates the mark still
 * shows, naming that version.
 */
export const answerEndorsement = pgTable(
  'answer_endorsement',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    /** The twin answer endorsed. */
    answerRef: uuid('answer_ref')
      .notNull()
      .references(() => twinAnswer.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id').references(() => assetVersion.id, { onDelete: 'set null' }),
    versionLabel: text('version_label'),
    endorsedBy: uuid('endorsed_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('answer_endorsement_answer_uq').on(t.answerRef)],
);

/**
 * The pending-questions list (待答列表, proposal 6.7): a twin question it
 * could not answer, a reader's direct "ask the author", or a comment the
 * creator moved here. Answering publishes a `qa` asset in the channel;
 * the asker's name appears on it only with `asker_name_consent`.
 */
export const channelQuestion = pgTable(
  'channel_question',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    askerUserId: uuid('asker_user_id').references(() => user.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    source: text('source').$type<'twin_unanswered' | 'direct' | 'comment'>().notNull(),
    state: text('state').$type<'open' | 'answered' | 'dismissed'>().notNull().default('open'),
    commentId: uuid('comment_id').references(() => comment.id, { onDelete: 'set null' }),
    twinAnswerId: uuid('twin_answer_id').references(() => twinAnswer.id, { onDelete: 'set null' }),
    answerAssetId: uuid('answer_asset_id').references(() => asset.id, { onDelete: 'set null' }),
    askerNameConsent: boolean('asker_name_consent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (t) => [
    index('channel_question_channel_idx').on(t.channelId, t.state, t.createdAt.desc()),
    check('channel_question_source_ck', sql`${t.source} in ('twin_unanswered', 'direct', 'comment')`),
    check('channel_question_state_ck', sql`${t.state} in ('open', 'answered', 'dismissed')`),
  ],
);

/**
 * An immutable channel plan (proposal 6.9, 12): one billing interval at
 * one price and one platform fee rate. A price change is a new row; a
 * subscription stays on the row it was sold at, so it affects new
 * subscriptions only. `retired_at` stops a row being sold.
 */
export const channelPlanVersion = pgTable(
  'channel_plan_version',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    interval: text('interval').$type<'month' | 'year'>().notNull(),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull().default('USD'),
    /** The platform's fee on this version, in basis points (2000 = 20%). */
    feeRateBps: integer('fee_rate_bps').notNull(),
    /** Unused while prices are non-catalogue; kept for a catalogue price later. */
    providerPriceId: text('provider_price_id'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('channel_plan_version_channel_idx').on(t.channelId, t.interval, t.effectiveFrom.desc()),
    check('channel_plan_version_interval_ck', sql`${t.interval} in ('month', 'year')`),
    check('channel_plan_version_price_ck', sql`${t.priceMinor} > 0`),
    check('channel_plan_version_fee_ck', sql`${t.feeRateBps} between 0 and 10000`),
  ],
);

/**
 * A reader's subscription to a channel (proposal 6.9, 12). Bound to the
 * user; their personal workspace (`workspace_id`) is what reads `paid`
 * assets. Access is `status` in (active, past_due, canceled) with
 * `current_period_end` still ahead -- so a cancellation keeps access to
 * the period's end and an expiry needs no event to take effect; `refunded`
 * and `paused` grant nothing.
 */
export const channelSubscription = pgTable(
  'channel_subscription',
  {
    id: uuid('id').primaryKey(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channel.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    planVersionId: uuid('plan_version_id')
      .notNull()
      .references(() => channelPlanVersion.id),
    status: text('status')
      .$type<'active' | 'past_due' | 'canceled' | 'refunded' | 'paused'>()
      .notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    provider: text('provider').notNull().default('paddle'),
    providerSubscriptionId: text('provider_subscription_id'),
    providerCustomerId: text('provider_customer_id'),
    /** When the provider says this state was true; an older event never overwrites a newer one. */
    observedAt: timestamp('observed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('channel_subscription_provider_uq').on(t.provider, t.providerSubscriptionId),
    /** The access predicate's lookup, run inside every non-owner read of a paid asset. */
    index('channel_subscription_access_idx').on(t.workspaceId, t.channelId, t.currentPeriodEnd),
    index('channel_subscription_user_idx').on(t.userId, t.createdAt.desc()),
    index('channel_subscription_channel_idx').on(t.channelId, t.status),
    check(
      'channel_subscription_status_ck',
      sql`${t.status} in ('active', 'past_due', 'canceled', 'refunded', 'paused')`,
    ),
  ],
);

/**
 * The channel-commerce settings the console owns (proposal 6.9, 13.2):
 * the minimum price of any one transaction, the platform fee on new plan
 * versions, the payout hold and the payout threshold. Immutable rows like
 * `retrieval_config`; the newest is in force, none means the defaults
 * (`lib/domain/commerce-config.ts`). Settings rather than constants so the
 * open fee-basis answer can be applied without a deploy.
 */
export const commerceConfig = pgTable(
  'commerce_config',
  {
    id: uuid('id').primaryKey(),
    minPriceMinor: integer('min_price_minor').notNull(),
    feeRateBps: integer('fee_rate_bps').notNull(),
    payoutHoldDays: integer('payout_hold_days').notNull(),
    payoutThresholdMinor: integer('payout_threshold_minor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('commerce_config_time_idx').on(t.createdAt.desc())],
);

/**
 * In-app notifications (proposal 6.5, 6.8): a new post for a subscriber, a
 * comment for the creator, a reply for the replied-to reader, a question.
 * `payload` carries ids and short titles, never a comment body.
 */
export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_user_idx').on(t.userId, t.createdAt.desc())],
);

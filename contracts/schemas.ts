import { z } from 'zod';

/**
 * Shared enums and payload schemas. Authoritative for REST, MCP, SDK and the web app.
 * Domain invariants live in lib/domain; this file is the wire contract only.
 */

// --- Asset state. requirement.md 6.2: three independent axes, never merged. ---

export const lifecycleStatusSchema = z.enum([
  'draft',
  'submitted',
  'reviewing',
  'changes_requested',
  'published',
  'suspended',
  'archived',
]);
export const indexStatusSchema = z.enum([
  'pending',
  'processing',
  'ready',
  'failed',
  'stale',
  'deleting',
]);
export const claimStatusSchema = z.enum([
  'pending',
  'verified',
  'failed',
  'expired',
  'revoked',
]);

export const sourceTypeSchema = z.enum([
  'github',
  'website',
  'markdown',
  'pdf',
  'notion',
]);

/** requirement.md 7.3.2 */
export const claimMethodSchema = z.enum([
  'github_permission',
  'dns_txt',
  'well_known',
]);

/** requirement.md 6.4 */
export const anchorStatusSchema = z.enum(['pending', 'anchored', 'unavailable']);

// --- Asset ID. requirement.md 6.1 ---

/**
 * `/owner/repo`, `/websites/slug`, `/docs/slug`, `/notion/slug`, optional
 * `/version`. The slug namespaces nest up to four levels
 * (`/websites/ethereum/whitepaper`), so two to six segments in all; which
 * trailing segments are an asset and which are a version is decided by
 * what exists (lib/domain/asset.ts `assetIdCandidates`).
 */
export const assetIdSchema = z
  .string()
  .max(256)
  .regex(/^\/[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){1,5}$/i, {
    message: 'asset id must look like /owner/name, /websites/slug/sub-slug or /owner/name/version',
  });

/**
 * A policy list entry (lib/domain/policy.ts `parsePolicyEntry`): an asset
 * id, optionally `/…/*` to cover what nests under it; an organisation as
 * `/owner/*`; or a domain such as `docs.example.com`.
 */
export const assetIdPatternSchema = z
  .string()
  .max(258)
  .regex(
    /^(\/[a-z0-9][a-z0-9._-]*((\/[a-z0-9][a-z0-9._-]*){1,5}(\/\*)?|\/\*)|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62})$/i,
    {
      message:
        'policy entry must be an asset id (optionally ending in /*), an organisation as /owner/*, or a domain',
    },
  );

// --- Retrieval. Two-stage: resolve-asset-id then query-docs. ---

/**
 * Query-first, name-optional. architecture.md 9.6 and 12.1: on a platform of
 * user-uploaded assets the display name carries no routing signal, so the
 * caller passes the question and the server searches the content-derived
 * profile. `assetName` survives as an optional hint for Context7-style
 * callers that do know a name.
 */
export const resolveAssetInputSchema = z.object({
  query: z.string().min(1).max(2000),
  assetName: z.string().min(1).max(200).optional(),
});

/**
 * Why this candidate matched. The asset's name cannot be trusted to say so
 * (architecture.md 9.6), and without evidence the calling agent guesses --
 * a wrong pick plus a retry costs more than the bytes here ever will.
 */
export const candidateEvidenceSchema = z.object({
  matchedTitles: z.array(z.string()),
  matchedTerms: z.array(z.string()),
});

export const assetCandidateSchema = z.object({
  assetId: assetIdSchema,
  title: z.string(),
  description: z.string().nullable(),
  version: z.string(),
  /**
   * Every label `query-docs` will accept after this id, newest first and
   * `version` among them (requirement.md 9.2). Without the list an agent can
   * only ever ask the current version: a superseded one stays queryable, but
   * nothing told the caller its label.
   */
  versions: z.array(z.string()),
  trustScore: z.number().int().min(0).max(100),
  benchmarkScore: z.number().int().min(0).max(100),
  chunks: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  evidence: candidateEvidenceSchema,
});

export const resolveAssetOutputSchema = z.object({
  results: z.array(assetCandidateSchema),
  requestId: z.string(),
});

export const queryDocsInputSchema = z.object({
  assetId: assetIdSchema,
  query: z.string().min(1).max(2000),
  maxTokens: z.number().int().min(256).max(64_000).default(4000),
  format: z.enum(['json', 'txt']).default('json'),
});

export const citationSchema = z.object({
  sourceUrl: z.string().url(),
  documentTitle: z.string(),
  section: z.string().nullable(),
  lines: z.tuple([z.number().int(), z.number().int()]).nullable(),
  /** 'faq' for a chunk of an owner-written FAQ entry (lib/domain/faq.ts); absent for a page of the source. */
  kind: z.enum(['faq']).optional(),
});

export const chunkResultSchema = z.object({
  chunkId: z.string(),
  text: z.string(),
  score: z.number(),
  tokens: z.number().int().nonnegative(),
  citation: citationSchema,
});

export const usageSchema = z.object({
  callsUsed: z.number().int().nonnegative(),
  planAllowanceRemaining: z.number().int().nonnegative(),
  addonBalanceRemaining: z.number().int().nonnegative(),
});

export const queryDocsOutputSchema = z.object({
  assetId: assetIdSchema,
  version: z.string(),
  chunks: z.array(chunkResultSchema),
  usage: usageSchema,
  requestId: z.string(),
});

// --- Usage and requests. architecture.md 6.3, 11.1. ---

export const usageBucketSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  calls: z.number().int().nonnegative(),
  /** asset-build-billing.md 8: build calls, apart from retrieval. */
  buildCalls: z.number().int().nonnegative(),
});

export const usageOverviewSchema = z.object({
  buckets: z.array(usageBucketSchema),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  callsThisPeriod: z.number().int().nonnegative(),
  retrievalCallsThisPeriod: z.number().int().nonnegative(),
  buildCallsThisPeriod: z.number().int().nonnegative(),
  returnedTokensThisPeriod: z.number().int().nonnegative(),
  planAllowance: z.number().int().nonnegative(),
  addonBalanceRemaining: z.number().int().nonnegative(),
  requestId: z.string(),
});

/** One request's summary. The query text never appears here (17.1). */
export const requestLogRowSchema = z.object({
  requestId: z.string(),
  operation: z.string(),
  assetPublicId: z.string().nullable(),
  entrypoint: z.string().nullable(),
  statusCode: z.number().int(),
  latencyMs: z.number().int().nullable(),
  createdAt: z.string().datetime(),
});

export const requestListSchema = z.object({
  requests: z.array(requestLogRowSchema),
  requestId: z.string(),
});

// --- Publisher revenue. publisher-revenue-share.md stage 2. ---

export const publisherPeriodEarningSchema = z.object({
  periodId: z.string().regex(/^\d{4}-\d{2}$/),
  locked: z.boolean(),
  attributableCalls: z.number().int().nonnegative(),
  /** Null until the period locks: no pool exists to allocate from yet. */
  amountMinor: z.number().int().nonnegative().nullable(),
});

export const publisherEarningsSchema = z.object({
  account: z
    .object({
      taxStatus: z.string(),
      agreementVersion: z.string().nullable(),
      providerAccountLinked: z.boolean(),
    })
    .nullable(),
  periods: z.array(publisherPeriodEarningSchema),
  accruedMinor: z.number().int().nonnegative(),
  payoutThresholdMinor: z.number().int().positive(),
  holdDays: z.number().int().positive(),
  requestId: z.string(),
});

// --- Policy. architecture.md 10. ---

export const policyReasonSchema = z.enum([
  'allowed',
  'source_type_disabled',
  'asset_blocked',
  'not_in_allowlist',
  'unverified_asset',
  'below_trust_threshold',
  'stale_asset',
  'below_star_threshold',
  'unlicensed_asset',
  'below_backlink_threshold',
  'below_referring_domain_threshold',
  'below_traffic_threshold',
]);

export const workspacePolicySchema = z.object({
  mode: z.enum(['quality', 'select']).nullable(),
  sourceTypes: z.record(z.string(), z.boolean()),
  quality: z.object({
    requireVerified: z.boolean(),
    minTrustScore: z.number().int().min(0).max(100).nullable(),
    maxAgeDays: z.number().int().positive().nullable(),
    minStars: z.number().int().nonnegative().nullable(),
    requireLicense: z.boolean(),
    minBacklinks: z.number().int().nonnegative().nullable(),
    minReferringDomains: z.number().int().nonnegative().nullable(),
    minOrganicTraffic: z.number().int().nonnegative().nullable(),
  }),
  blockedAssets: z.array(assetIdPatternSchema),
  exceptedAssets: z.array(assetIdPatternSchema),
  allowedAssets: z.array(assetIdPatternSchema),
});

const assetIdListPatchSchema = z.object({
  add: z.array(assetIdPatternSchema).max(200).optional(),
  remove: z.array(assetIdPatternSchema).max(200).optional(),
  clear: z.boolean().optional(),
});

/**
 * PATCH /v1/policies is incremental (architecture.md 10.1): source types
 * enable/disable, lists add/remove/clear, thresholds set or null to unset.
 * The server materialises a complete, immutable new Policy Version.
 */
export const policyPatchSchema = z.object({
  mode: z.enum(['quality', 'select', 'clear']).optional(),
  sourceTypes: z
    .object({
      enable: z.array(z.string().min(1).max(40)).max(20).optional(),
      disable: z.array(z.string().min(1).max(40)).max(20).optional(),
    })
    .optional(),
  quality: z
    .object({
      requireVerified: z.boolean().optional(),
      minTrustScore: z.number().int().min(0).max(100).nullable().optional(),
      maxAgeDays: z.number().int().positive().nullable().optional(),
      minStars: z.number().int().nonnegative().nullable().optional(),
      requireLicense: z.boolean().optional(),
      minBacklinks: z.number().int().nonnegative().nullable().optional(),
      minReferringDomains: z.number().int().nonnegative().nullable().optional(),
      minOrganicTraffic: z.number().int().nonnegative().nullable().optional(),
    })
    .optional(),
  blocked: assetIdListPatchSchema.optional(),
  excepted: assetIdListPatchSchema.optional(),
  allowed: assetIdListPatchSchema.optional(),
});

export const policyResponseSchema = z.object({
  policyVersionId: z.string().nullable(),
  policy: workspacePolicySchema,
  accessibleAssetCount: z.number().int().nonnegative(),
  requestId: z.string(),
});

// --- Claim. requirement.md 7.3 ---

export const startClaimInputSchema = z.object({
  assetId: assetIdSchema,
  method: claimMethodSchema,
});

export const claimChallengeSchema = z.object({
  claimId: z.string(),
  method: claimMethodSchema,
  status: claimStatusSchema,
  /** Only returned once, at creation. */
  challengeToken: z.string().optional(),
  dnsRecordName: z.string().optional(),
  dnsRecordValue: z.string().optional(),
  wellKnownUrl: z.string().url().optional(),
  expiresAt: z.string().datetime(),
});

export const claimCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  state: z.enum(['ok', 'pending', 'failed']),
});

export const verifyClaimOutputSchema = z.object({
  claimId: z.string(),
  status: claimStatusSchema,
  checks: z.array(claimCheckSchema),
  requestId: z.string(),
});

// --- Anchors. requirement.md 6.4. Never inlined into context responses. ---

/**
 * Everything a stranger needs to rebuild a public version's leaf.
 *
 * aptos-anchoring-proposal.md 5 requires a public asset to return its
 * preimage; without it a proof is unusable, because there is nothing to hash.
 * The fields are listed in the order 4.2.1 frames them, and `publishedAt` is
 * the exact string that was hashed rather than a re-rendering of the timestamp.
 *
 * Public assets only. A private version's preimage is salted and belongs to
 * whoever owns it (6.4); nothing serves one, so nothing needs a shape for it.
 */
export const anchorPreimageSchema = z.object({
  domainSeparator: z.string(),
  leafSchemaVersion: z.number().int(),
  assetId: z.string(),
  versionId: z.string(),
  sourceDigest: z.string(),
  contentMerkleRoot: z.string(),
  publishedAt: z.string(),
  /**
   * Always empty, and a literal so it stays that way: a preimage with a salt to
   * hide is not served from an endpoint that asks for nothing (proposal 3.2).
   */
  salt: z.literal(''),
});

export const anchorSchema = z.object({
  subjectType: z.enum(['version', 'audit_head', 'earning_statement']),
  subjectId: z.string(),
  status: anchorStatusSchema,
  network: z.string().nullable(),
  txHash: z.string().nullable(),
  blockTime: z.string().datetime().nullable(),
  leafSchemaVersion: z.number().int().nullable(),
});

export type ResolveAssetInput = z.infer<typeof resolveAssetInputSchema>;
export type ResolveAssetOutput = z.infer<typeof resolveAssetOutputSchema>;
export type QueryDocsInput = z.infer<typeof queryDocsInputSchema>;
export type QueryDocsOutput = z.infer<typeof queryDocsOutputSchema>;
export type AssetCandidate = z.infer<typeof assetCandidateSchema>;
export type WorkspacePolicyView = z.infer<typeof workspacePolicySchema>;
export type PolicyPatch = z.infer<typeof policyPatchSchema>;
export type PolicyResponse = z.infer<typeof policyResponseSchema>;
export type ChunkResult = z.infer<typeof chunkResultSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type ClaimChallenge = z.infer<typeof claimChallengeSchema>;
export type VerifyClaimOutput = z.infer<typeof verifyClaimOutputSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type AnchorPreimage = z.infer<typeof anchorPreimageSchema>;

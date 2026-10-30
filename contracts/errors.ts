/**
 * Stable error codes. Authoritative for REST, MCP, SDK, CLI and the web app.
 * See architecture.md 17 and requirement.md 11.
 *
 * Codes are part of the public contract: never rename or repurpose one.
 * Adding a code is a minor change; changing a code's meaning is a breaking change.
 */
export const ERROR_CODES = [
  'invalid_request',
  'asset_not_found',
  'asset_not_ready',
  'asset_suspended',
  'asset_size_exceeded',
  'access_denied',
  'access_rule_blocked',
  'quota_exceeded',
  'invalid_api_key',
  'api_key_limit_exceeded',
  'query_too_large',
  'no_relevant_context',
  'source_fetch_failed',
  'parse_failed',
  'index_failed',
  'review_required',
  'claim_verification_failed',
  'subscription_required',
  'provider_unavailable',
  'anchor_pending',
  'rate_limited',
  'not_implemented',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Claim failure reasons. See requirement.md 7.3.8. */
export const CLAIM_FAILURE_REASONS = [
  'insufficient_permission',
  'account_not_linked',
  'source_mismatch',
  'challenge_not_found',
  'challenge_expired',
  'already_claimed',
  'claim_in_progress',
  'retry_limit_exceeded',
] as const;

export type ClaimFailureReason = (typeof CLAIM_FAILURE_REASONS)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    /** Safe for end users. Never include source permission detail, DNS payloads or fetched content. */
    message: string;
    requestId: string;
    /** Only set on claim endpoints. */
    reason?: ClaimFailureReason;
  };
}

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  asset_not_found: 404,
  asset_not_ready: 409,
  asset_suspended: 409,
  asset_size_exceeded: 413,
  access_denied: 403,
  access_rule_blocked: 403,
  quota_exceeded: 429,
  invalid_api_key: 401,
  api_key_limit_exceeded: 403,
  query_too_large: 413,
  no_relevant_context: 404,
  source_fetch_failed: 502,
  parse_failed: 422,
  index_failed: 500,
  review_required: 409,
  claim_verification_failed: 422,
  subscription_required: 402,
  provider_unavailable: 503,
  anchor_pending: 202,
  rate_limited: 429,
  not_implemented: 501,
  internal_error: 500,
};

export function httpStatusFor(code: ErrorCode): number {
  return DEFAULT_STATUS[code];
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly reason?: ClaimFailureReason,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

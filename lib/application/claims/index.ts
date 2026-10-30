/**
 * Ownership claim. requirement.md 7.3, architecture.md 5.4.
 *
 * The question is not "who are you" but "do you control this source".
 * A key placed in re0.json grants nothing: a config file can be written by
 * forks, pull requests and mirrors, so write access is not control.
 *
 * asset.ownerWorkspaceId has exactly two write paths: a verified claim, or an
 * admin ruling on a dispute. Ingestion, review and refresh never touch it.
 * Route Handlers, pages and server actions may only enter through this layer.
 */
export { CLAIM_TTL_MS as CHALLENGE_TTL_MS } from '@/lib/domain/claim';
export type { ClaimCheckView as ClaimCheck } from '@/lib/domain/claim';
export { assertMethodSupported, publicFailureMessage } from './rules';
export { startClaim, type StartClaimInput, type StartedClaim } from './start';
export {
  verifyClaim,
  type GithubGrant,
  type VerifyClaimInput,
  type VerifyClaimResult,
} from './verify';
export {
  beginGithubGrant,
  claimPagePath,
  completeGithubGrant,
  peekGrantHandshake,
  type BeginGithubGrantInput,
  type BeginGithubGrantResult,
  type CompleteGithubGrantInput,
} from './github-grant';
export {
  releaseOwnership,
  type ReleaseOwnershipInput,
  type ReleaseOwnershipResult,
} from './release';
export {
  claimForClaimant,
  claimTarget,
  listWorkspaceClaims,
  ownershipForAssets,
  publicClaimStatus,
  type ClaimantClaimView,
  type ClaimTarget,
  type PublicClaimStatus,
  type WorkspaceClaimRow,
} from './views';
export {
  claimDetail,
  revokeClaim,
  ruleDispute,
  type ClaimActor,
  type ClaimAuditEntry,
  type ConsoleClaimDetail,
  type DisputeDecision,
  type RevokeClaimInput,
  type RevokeClaimResult,
  type RuleDisputeInput,
  type RuleDisputeResult,
} from './admin';

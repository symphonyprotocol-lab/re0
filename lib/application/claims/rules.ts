/**
 * Claim rules that need the contracts but no database: which methods a
 * source admits, and the one sentence each failure code may say.
 */
import { AppError, type ClaimFailureReason } from '@/contracts/errors';
import type { ClaimMethod, SourceType } from '@/lib/domain';
import { claimMethodsFor, requiresClaim } from '@/lib/domain';

export function assertMethodSupported(sourceType: SourceType, method: ClaimMethod): void {
  if (!requiresClaim(sourceType)) {
    throw new AppError(
      'claim_verification_failed',
      'this source type does not use claims; the creator is the owner',
      'source_mismatch',
    );
  }
  if (!claimMethodsFor(sourceType).includes(method)) {
    throw new AppError(
      'claim_verification_failed',
      'verification method is not available for this source type',
      'source_mismatch',
    );
  }
}

/**
 * Failure output must stay minimal: no source permission detail, no DNS payload,
 * no fetched content. For an asset the caller cannot see, the response must be
 * indistinguishable from "not found" so claims cannot probe private assets.
 * requirement.md 7.3.7.
 */
export function publicFailureMessage(reason: ClaimFailureReason): string {
  switch (reason) {
    case 'insufficient_permission':
      return 'Your account needs admin or maintain permission on this repository.';
    case 'account_not_linked':
      return 'Link a GitHub account that can access this repository, then retry.';
    case 'source_mismatch':
      return 'The verified source does not match this asset. Check the target and retry.';
    case 'challenge_not_found':
      return 'The challenge was not found at the expected location.';
    case 'challenge_expired':
      return 'The challenge expired. Start a new claim to get a fresh one.';
    case 'already_claimed':
      return 'This asset already has an owner. Open a dispute for admin review.';
    case 'claim_in_progress':
      return 'Another claim is in progress for this asset. Try again after it ends.';
    case 'retry_limit_exceeded':
      return 'Too many attempts. Wait for the cooldown to end.';
  }
}

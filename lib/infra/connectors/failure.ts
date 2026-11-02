/**
 * A knowledge source that could not be turned into text. `code` is what the
 * knowledge page shows (localized); `message` is for our logs.
 */
export type ProcessingFailureCode =
  | 'source_missing'
  | 'parse_failed'
  | 'empty_text'
  | 'unsupported_format'
  | 'embedding_unavailable'
  | 'source_unreachable'
  | 'source_forbidden'
  | 'source_too_large'
  | 'rate_limited'
  | 'github_not_connected'
  | 'github_repo_not_found'
  | 'domain_unverified'
  | 'transcription_unavailable'
  | 'simulated';

export class ProcessingFailure extends Error {
  constructor(
    readonly code: ProcessingFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessingFailure';
  }
}

/**
 * The failure path on demand, for walking it through by hand: a source whose
 * file name or title contains 「失败」 fails after it is claimed, so the hold
 * is refunded like any real failure (8.4 step 2). Only `next dev` and the
 * test runner have the switch; a production build (`NODE_ENV=production`,
 * Preview included) processes such a file like any other.
 */
export function simulatedFailureFor(...names: readonly (string | null | undefined)[]): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return names.some((name) => typeof name === 'string' && name.includes('失败'));
}

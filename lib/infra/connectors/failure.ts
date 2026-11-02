/**
 * A knowledge source that could not be turned into text. `code` is what the
 * knowledge page shows (localized); `message` is for our logs.
 */
export type ProcessingFailureCode =
  | 'source_missing'
  | 'parse_failed'
  | 'empty_text'
  | 'unsupported_format'
  | 'embedding_unavailable';

export class ProcessingFailure extends Error {
  constructor(
    readonly code: ProcessingFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProcessingFailure';
  }
}

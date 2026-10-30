/**
 * The platform's own sources: an article or a Q&A written in re0
 * (`editor`), and an episode's title and show notes (`audio`).
 * agent-first-proposal.md 6.5-6.7.
 *
 * There is nothing to fetch. The application composed the one document when
 * the owner published (lib/application/editorial), and it sits on the
 * source row's config; this hands it to the pipeline like any other file.
 * An episode's audio is never read here -- it is not transcribed (6.6) --
 * and an article's images are represented by their captions only.
 */
import { EMPTY_SOURCE_CONFIG, IngestionFailure } from '@/lib/domain/ingestion';
import { editorialSourceConfigOf } from '@/lib/domain/library';
import type { SourceSnapshot } from './types';

export function fetchEditorialSnapshot(input: { config: Record<string, unknown> }): SourceSnapshot {
  const document = editorialSourceConfigOf(input.config);
  if (!document) {
    throw new IngestionFailure('source_empty', 'fetch-snapshot', 'nothing has been published yet');
  }
  return {
    files: [{ path: document.path, url: document.url, content: document.markdown, format: 'markdown' }],
    config: EMPTY_SOURCE_CONFIG,
    revision: null,
    lastModifiedAt: null,
    /* The creator declares their own rights (requirement.md 7.1); nothing machine-readable to score. */
    hasLicense: false,
    stale: false,
  };
}

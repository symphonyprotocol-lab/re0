/**
 * The connector registry: one location in, one immutable snapshot out.
 *
 * The application layer knows only this function. Which provider a source type
 * happens to use, and what it costs to talk to it, stays inside the adapters --
 * architecture.md 4 keeps provider detail out of everything above
 * `lib/infrastructure`.
 */
import { IngestionFailure, pathIncluded } from '@/lib/domain/ingestion';
import {
  indexDepthOf,
  parseScopeApplies,
  parseScopeIsEmpty,
  parseScopeOf,
  type BuildableSourceType,
} from '@/lib/domain/asset';
import { objectStore } from '@/lib/infrastructure/objects/store';
import { fetchEditorialSnapshot } from './editor';
import { fetchGithubSnapshot } from './github';
import { fetchMarkdownSnapshot } from './markdown';
import { fetchNotionSnapshot } from './notion';
import { fetchPdfSnapshot } from './pdf';
import type { PageRenderer } from './render';
import { fetchWebSnapshot } from './web';
import type { SourceSnapshot } from './types';

export type { FetchedFile, SourceSnapshot } from './types';
export type { PageRenderer } from './render';

export interface FetchSnapshotInput {
  type: BuildableSourceType;
  location: string;
  /** `source.config`: what the source row carries beyond a location. */
  config?: Record<string, unknown>;
  /**
   * A credential resolved by the caller for this one fetch -- a person's
   * Notion grant, for a source imported under their connection. Never
   * stored here and never logged; absent, a connector that needs one falls
   * back to the platform's own configuration.
   */
  credential?: string;
  /**
   * The rendering fallback for website sources, resolved by the caller from
   * the console (`manage-render-config.ts`); null is "off". Absent reads the
   * deployment's variables.
   */
  renderer?: PageRenderer | null;
}

export async function fetchSnapshot(input: FetchSnapshotInput): Promise<SourceSnapshot> {
  const snapshot = await fetchUnscoped(input);
  return applyParseScope(input, snapshot);
}

/**
 * The owner's parse scope (`source.config.folders` and friends, named as in
 * `re0.json`; requirement.md 7.2), applied on top of whatever the source's
 * own file said. Same rule as the repository's file (`pathIncluded`):
 * exclusions win, `folders` narrows, root documents stay. A snapshot the
 * scope empties fails as `source_empty` rather than publishing nothing.
 */
function applyParseScope(input: FetchSnapshotInput, snapshot: SourceSnapshot): SourceSnapshot {
  if (!parseScopeApplies(input.type)) return snapshot;
  const scope = parseScopeOf(input.config ?? {});
  if (parseScopeIsEmpty(scope)) return snapshot;
  const rules = {
    ...snapshot.config,
    folders: scope.folders,
    excludeFolders: [...snapshot.config.excludeFolders, ...scope.excludeFolders],
    excludeFiles: [...snapshot.config.excludeFiles, ...scope.excludeFiles],
  };
  const files = snapshot.files.filter((file) => pathIncluded(file.path, rules));
  if (files.length === 0) {
    throw new IngestionFailure(
      'source_empty',
      'fetch-snapshot',
      'the parse scope leaves no document to index',
    );
  }
  return { ...snapshot, files };
}

async function fetchUnscoped(input: FetchSnapshotInput): Promise<SourceSnapshot> {
  switch (input.type) {
    case 'github':
      return fetchGithubSnapshot({ location: input.location });
    case 'website':
      return fetchWebSnapshot({
        location: input.location,
        indexDepth: indexDepthOf(input.config ?? {}),
        renderer: input.renderer,
      });
    case 'notion':
      return fetchNotionSnapshot({ location: input.location, token: input.credential });
    case 'pdf':
      return fetchPdfSnapshot({ config: input.config ?? {}, store: objectStore() });
    case 'markdown':
      return fetchMarkdownSnapshot({ config: input.config ?? {}, store: objectStore() });
    case 'editor':
    case 'audio':
      return fetchEditorialSnapshot({ config: input.config ?? {} });
    default:
      throw new IngestionFailure(
        'source_unsupported',
        'validate-source',
        `no connector for ${String(input.type)}`,
      );
  }
}

/**
 * Whether a source type can be fetched with the current configuration.
 *
 * Answered before a refresh is queued so the console can refuse at the point
 * the operator is looking at the asset, rather than leaving a row in the
 * queue that fails minutes later for a reason that was knowable up front.
 */
export function connectorConfigured(type: BuildableSourceType): boolean {
  return type === 'notion' ? Boolean(process.env.NOTION_INGESTION_TOKEN) : true;
}

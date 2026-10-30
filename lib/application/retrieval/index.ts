import type { QueryDocsInput, QueryDocsOutput, ResolveLibraryInput, ResolveLibraryOutput } from '@/contracts/schemas';
import { resolveLibrary } from './resolve-library';
import { queryDocs as queryDocsUseCase } from './query-docs';

/**
 * The single retrieval implementation. REST, MCP and the web playground all
 * call these -- none of them may reimplement authorization, recall or metering.
 * architecture.md 1.1, 9.2 and 9.5.
 *
 * Order is fixed (architecture.md 9.2):
 *   authenticate -> resolve plan and quota -> load library and pin version
 *   -> enforce visibility -> apply workspace policy -> reserve one call
 *   -> FTS + vector recall within the pinned version -> fuse -> rerank
 *   -> dedupe and safety filter -> trim to maxTokens -> append usage event
 */

export interface CallerContext {
  workspaceId: string | null;
  apiKeyId: string | null;
  requestId: string;
  anonymous: boolean;
  /**
   * What the key grants, when a key authenticated the call. Absent for the
   * session and anonymous callers, which the scope gate lets through.
   */
  scopes?: readonly string[];
  /**
   * Which door: `rest`, `mcp`, `web` or `a2a`. Recorded on the usage event and the
   * request log. Absent means "rest if a key, else web", the pre-MCP reading.
   */
  entrypoint?: 'rest' | 'mcp' | 'web' | 'a2a';
}

export async function resolveLibraryId(
  caller: CallerContext,
  input: ResolveLibraryInput,
): Promise<ResolveLibraryOutput> {
  return resolveLibrary(caller, input);
}

export async function queryDocs(
  caller: CallerContext,
  input: QueryDocsInput,
): Promise<QueryDocsOutput> {
  return queryDocsUseCase(caller, input);
}

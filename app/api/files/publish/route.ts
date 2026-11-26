import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { filesScope, publishFailure } from '@/lib/http/files';
import { publishCheck, publishFile } from '@/lib/services/workspace-publish';

/* The checks read the whole file: a PDF's text layer may take its parse time (WORKSPACE_PARSE_MS). */
export const maxDuration = 120;

/**
 * Publishing a file's original (docs/design/agent-workspace-p4.md §2.6): the
 * signed-in owner on the web only -- no MCP tool reaches this.
 * `GET ?path=&revision=` → the version and every check, for the dialog;
 * `POST {path, revision?, title?, indexable?}` → the public file, or 422
 * `checks_failed` with the checks.
 */
export async function GET(request: NextRequest) {
  const scope = await filesScope(request, 'read');
  if (scope instanceof Response) return scope;
  const params = request.nextUrl.searchParams;
  try {
    return json(await publishCheck(scope, { path: params.get('path') ?? '', revision: params.get('revision') ?? undefined }));
  } catch (error) {
    return publishFailure(error);
  }
}

export async function POST(request: NextRequest) {
  const scope = await filesScope(request, 'write');
  if (scope instanceof Response) return scope;
  const input = await body(request);
  try {
    return json(await publishFile(scope, { path: String(input.path ?? ''), revision: typeof input.revision === 'string' ? input.revision : undefined, title: input.title, indexable: input.indexable === true }), 201);
  } catch (error) {
    return publishFailure(error);
  }
}

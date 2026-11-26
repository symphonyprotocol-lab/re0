import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { filesScope, publishFailure } from '@/lib/http/files';
import { unpublish, updatePublication } from '@/lib/services/workspace-publish';

/* The checks read the whole file: a PDF's text layer may take its parse time (WORKSPACE_PARSE_MS). */
export const maxDuration = 120;

/** `PATCH {to_current?, title?, indexable?}`: the link to the file's current version (checked again), or a new title or indexing; the URL stays. */
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const scope = await filesScope(request, 'write');
  if (scope instanceof Response) return scope;
  const { id } = await context.params;
  const input = await body(request);
  try {
    return json(await updatePublication(scope, id, { toCurrent: input.to_current === true, title: input.title, indexable: typeof input.indexable === 'boolean' ? input.indexable : undefined }));
  } catch (error) {
    return publishFailure(error);
  }
}

/** `DELETE`: stops publishing; the link is gone at once. */
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const scope = await filesScope(request, 'write');
  if (scope instanceof Response) return scope;
  const { id } = await context.params;
  try {
    await unpublish(scope, id);
    return json({ ok: true });
  } catch (error) {
    return publishFailure(error);
  }
}

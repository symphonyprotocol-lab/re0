import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { filesFailure, filesScope } from '@/lib/http/files';
import { restoreEntry } from '@/lib/services/workspace';

/** `{trashId}` takes something out of the trash; `{path, revision}` makes an older version the newest, as `ws_restore` does. */
export async function POST(request: NextRequest) {
  const scope = await filesScope(request, 'write');
  if (scope instanceof Response) return scope;
  const input = await body(request);
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  try {
    return json(await restoreEntry(scope, { path: text(input.path), trashId: text(input.trashId), revision: text(input.revision) }));
  } catch (error) {
    return filesFailure(error);
  }
}

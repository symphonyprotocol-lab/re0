import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { filesFailure, filesScope } from '@/lib/http/files';
import { trashEntry } from '@/lib/services/workspace';

/** `{path}` → the file or folder (with what is in it) to the trash, as `ws_delete` does. */
export async function POST(request: NextRequest) {
  const scope = await filesScope(request, 'write');
  if (scope instanceof Response) return scope;
  const input = await body(request);
  try {
    return json(await trashEntry(scope, { path: String(input.path ?? '') }));
  } catch (error) {
    return filesFailure(error);
  }
}

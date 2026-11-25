import type { NextRequest } from 'next/server';
import { body, fail, json } from '@/lib/http/respond';
import { filesFailure, filesScope } from '@/lib/http/files';
import { setIndexMode } from '@/lib/services/workspace-index';

/** `{path, mode, maxCost?}` → a folder's or file's index mode (on / off / inherit), as `ws_index` sets it. */
export async function POST(request: NextRequest) {
  const scope = await filesScope(request, 'write');
  if (scope instanceof Response) return scope;
  const input = await body(request);
  if (input.mode !== 'on' && input.mode !== 'off' && input.mode !== 'inherit') return fail('invalid_mode', 422);
  try {
    return json(await setIndexMode(scope, { path: String(input.path ?? ''), mode: input.mode, maxCost: typeof input.maxCost === 'number' ? input.maxCost : undefined }));
  } catch (error) {
    return filesFailure(error);
  }
}

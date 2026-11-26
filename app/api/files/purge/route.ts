import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { filesFailure, filesScope } from '@/lib/http/files';
import { purgeTrashed } from '@/lib/services/workspace';

/** `{ids}` → those trash entries (and what was deleted with a folder among them) deleted for good. Only here: MCP can only trash. */
export async function POST(request: NextRequest) {
  const scope = await filesScope(request, 'write');
  if (scope instanceof Response) return scope;
  const input = await body(request);
  const ids = Array.isArray(input.ids) ? input.ids.filter((id): id is string => typeof id === 'string').slice(0, 500) : [];
  try {
    return json(await purgeTrashed(scope, ids));
  } catch (error) {
    return filesFailure(error);
  }
}

import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { filesFailure, filesScope } from '@/lib/http/files';
import { estimateIndex } from '@/lib/services/workspace-index';

/** `?path=` → what indexing the text files there would cost now: files, files already indexed, tokens, credits. */
export async function GET(request: NextRequest) {
  const scope = await filesScope(request, 'read');
  if (scope instanceof Response) return scope;
  try {
    return json(await estimateIndex(scope, request.nextUrl.searchParams.get('path') ?? '/'));
  } catch (error) {
    return filesFailure(error);
  }
}

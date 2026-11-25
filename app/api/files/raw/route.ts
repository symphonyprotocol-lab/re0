import type { NextRequest } from 'next/server';
import { filesFailure, filesScope } from '@/lib/http/files';
import { json } from '@/lib/http/respond';
import { streamVersion, UploadError, versionAt } from '@/lib/services/workspace-upload';

/** A 100 MB file streams for a while. */
export const maxDuration = 300;

/** `?path=&revision=` → the file (or that version of it) as a download, byte for byte, text or binary. */
export async function GET(request: NextRequest) {
  const scope = await filesScope(request, 'read');
  if (scope instanceof Response) return scope;
  const params = request.nextUrl.searchParams;
  try {
    const version = await versionAt(scope, params.get('path') ?? '', params.get('revision') ?? undefined);
    return await streamVersion(scope.workspaceId, version);
  } catch (error) {
    if (error instanceof UploadError) return json({ error: error.code }, error.status);
    return filesFailure(error);
  }
}

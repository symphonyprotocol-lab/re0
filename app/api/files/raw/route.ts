import type { NextRequest } from 'next/server';
import { filesFailure, filesScope } from '@/lib/http/files';
import { fileText } from '@/lib/services/workspace';
import { nameOf } from '@/lib/domain/workspace';

/** `?path=&revision=` → the file (or that version of it) as a download, byte for byte. */
export async function GET(request: NextRequest) {
  const scope = await filesScope(request, 'read');
  if (scope instanceof Response) return scope;
  const params = request.nextUrl.searchParams;
  try {
    const file = await fileText(scope, params.get('path') ?? '', params.get('revision') ?? undefined);
    const name = nameOf(file.path);
    return new Response(file.text, {
      headers: {
        'content-type': `${file.media_type ?? 'text/plain'}; charset=utf-8`,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return filesFailure(error);
  }
}

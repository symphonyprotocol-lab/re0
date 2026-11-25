import type { NextRequest } from 'next/server';
import { body, json } from '@/lib/http/respond';
import { filesFailure, filesScope } from '@/lib/http/files';
import { createUpload } from '@/lib/services/workspace-upload';

/** `{path, size, ifNoneMatch?}` → an upload URL for the web's upload button (the browser then PUTs the file, or its parts, to it). */
export async function POST(request: NextRequest) {
  const scope = await filesScope(request, 'write');
  if (scope instanceof Response) return scope;
  const input = await body(request);
  try {
    return json(await createUpload(scope, { path: String(input.path ?? ''), size: input.size, ifNoneMatch: input.ifNoneMatch === '*' ? '*' : undefined }), 201);
  } catch (error) {
    return filesFailure(error);
  }
}

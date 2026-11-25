import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { receivePart, UploadError } from '@/lib/services/workspace-upload';
import { WorkspaceError } from '@/lib/services/workspace';

/** Stitching the last part of a 100 MB upload reads the parts twice and writes the file once. */
export const maxDuration = 300;

const STATUS: Partial<Record<WorkspaceError['code'], number>> = { not_found: 404, conflict: 409, exists: 409, insufficient_credits: 402, limit_reached: 429, too_large: 413, quota_exceeded: 413, is_a_directory: 409, workspace_not_allowed: 403 };

/**
 * `PUT /api/files/upload/<token>[?part=n]`: the bytes of an upload made by
 * `ws_upload_url` or the web (lib/services/workspace-upload.ts). The token
 * in the path is the only credential. Errors come back as `{error, message}`
 * for whoever runs curl to read.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    return json(await receivePart(token, { part: request.nextUrl.searchParams.get('part'), contentLength: request.headers.get('content-length'), body: request.body }));
  } catch (error) {
    if (error instanceof UploadError) return json({ error: error.code, message: error.message }, error.status);
    if (error instanceof WorkspaceError) return json({ error: error.code, message: error.message, ...error.details }, STATUS[error.code] ?? 422);
    console.error('workspace upload failed', error instanceof Error ? error.message : error);
    return json({ error: 'failed', message: 'The upload could not be saved; ask for a new upload URL and try again.' }, 500);
  }
}

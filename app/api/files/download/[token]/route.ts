import type { NextRequest } from 'next/server';
import { json } from '@/lib/http/respond';
import { openDownload, UploadError } from '@/lib/services/workspace-upload';

/** A 100 MB file streams for a while. */
export const maxDuration = 300;

/** `GET /api/files/download/<token>`: one version of one file, from a URL `ws_download_url` signed (lib/services/workspace-upload.ts). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    return await openDownload(token);
  } catch (error) {
    if (error instanceof UploadError) return json({ error: error.code, message: error.message }, error.status);
    throw error;
  }
}

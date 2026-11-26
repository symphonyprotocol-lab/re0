import type { NextRequest } from 'next/server';
import { clientIp } from '@/lib/http/client-ip';
import { serveDownload } from '@/lib/services/workspace-publish';

export const dynamic = 'force-dynamic';

/**
 * `/f/<id>/raw`: a published file's pinned bytes (docs/design/agent-workspace-p4.md
 * §2.5) -- an attachment, typed from the published extension, nosniff,
 * sandboxed, never cached: every download is counted, limited and checked
 * against the publication's state when it starts.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return serveDownload(id, clientIp(request.headers));
}

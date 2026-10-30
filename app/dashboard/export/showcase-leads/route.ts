/**
 * GET /dashboard/export/showcase-leads?asset=<id> -- CSV of a page's
 * leads, for its owner. Session-gated: a workspace exports its own leads
 * and nothing else; the use case scopes the read to the workspace.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { showcaseLeadsCsv } from '@/lib/application/showcase';
import { surfaceEnabled } from '@/lib/domain/surfaces';
import { currentSession } from '@/lib/http/session';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  /* agent-first-proposal.md 3.6: shared pages are offline and their leads are deleted. */
  if (!surfaceEnabled('showcase')) return new NextResponse(null, { status: 404 });
  const session = await currentSession();
  if (!session) return new NextResponse('sign in to export leads', { status: 401 });
  const assetId = request.nextUrl.searchParams.get('asset') ?? '';
  if (!/^[0-9a-f-]{36}$/.test(assetId)) return new NextResponse('unknown asset', { status: 404 });
  const csv = await showcaseLeadsCsv({ workspaceId: session.workspace.id, assetId });
  return new NextResponse(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="showcase-leads-${assetId.slice(0, 8)}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
}

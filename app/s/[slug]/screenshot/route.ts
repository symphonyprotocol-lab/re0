/**
 * A page's screenshot: the object key is not a URL anyone can open, so the page
 * links here and this redirects to a short-lived signed URL. Only a visible
 * page's assets are served; the rest are a 404.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { showcaseAssetKeyFor } from '@/lib/application/showcase';
import { currentSession } from '@/lib/http/session';
import { showcaseGateFor } from '@/lib/http/showcase-gate';
import { PREVIEW_PARAM, wantsPreview } from '../lookup';
import { isObjectStoreConfigured, objectStore } from '@/lib/infrastructure/objects/store';

const TTL_SECONDS = 300;

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params;
  const preview = wantsPreview(new URL(request.url).searchParams.get(PREVIEW_PARAM));
  const session = preview ? await currentSession().catch(() => null) : null;
  const asset = await showcaseAssetKeyFor(slug, 'screenshot', { ownerWorkspaceId: session?.workspace.id ?? null });
  if (!asset) return new NextResponse(null, { status: 404 });
  if (!asset.owner && (await showcaseGateFor(request.cookies, asset.gate)) !== 'open') return new NextResponse(null, { status: 403 });
  const key = asset.key;
  if (!isObjectStoreConfigured()) return new NextResponse(null, { status: 503 });
  return NextResponse.redirect(await objectStore().signedUrl(key, TTL_SECONDS), {
    status: 302,
    headers: { 'cache-control': 'private, max-age=240' },
  });
}

/**
 * GET /media/{id} -- one article image or episode file, for a reader who may
 * read its asset in full right now (agent-first-proposal.md 6.5, 6.6, 6.10).
 *
 * Redirects to a short-lived signed URL issued for this one request, so the
 * bytes never pass through the app and a copied link stops working within
 * minutes. Anyone else -- a non-subscriber for a paid asset, a stranger for
 * one in no channel -- gets a 404, the same as for a file that does not
 * exist (architecture.md 5.2). Never a download: no `Content-Disposition:
 * attachment` is asked of the store, and the player hides its download
 * control.
 */
import { NextResponse } from 'next/server';
import { mediaUrlFor } from '@/lib/application/editorial';
import { optionalSession } from '@/lib/http/session';

export async function GET(_request: Request, context: { params: Promise<{ mediaId: string }> }): Promise<Response> {
  const { mediaId } = await context.params;
  const session = await optionalSession();
  const signed = await mediaUrlFor(session?.workspace.id ?? null, mediaId);
  if (!signed) return new NextResponse(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  return NextResponse.redirect(signed.url, { status: 302, headers: { 'cache-control': 'private, no-store' } });
}

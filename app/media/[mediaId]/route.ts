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
 *
 * A session-less caller goes through the anonymous reading limit first
 * (lib/http/reading-limit.ts, architecture.md 11.2): every answer here signs
 * a URL whose egress the platform pays, so a loop is refused, not served.
 */
import { NextResponse } from 'next/server';
import { mediaUrlFor } from '@/lib/application/editorial';
import { anonymousRead } from '@/lib/http/reading-limit';
import { optionalSession } from '@/lib/http/session';

export async function GET(request: Request, context: { params: Promise<{ mediaId: string }> }): Promise<Response> {
  const { mediaId } = await context.params;
  const session = await optionalSession();
  if (!session) {
    const verdict = await anonymousRead(request.headers);
    if (!verdict.allowed) {
      return new NextResponse(null, { status: 429, headers: { 'cache-control': 'no-store', 'retry-after': String(verdict.retryAfterSeconds) } });
    }
  }
  const signed = await mediaUrlFor(session?.workspace.id ?? null, mediaId);
  if (!signed) return new NextResponse(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  return NextResponse.redirect(signed.url, { status: 302, headers: { 'cache-control': 'private, no-store' } });
}

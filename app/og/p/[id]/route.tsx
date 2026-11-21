import type { NextRequest } from 'next/server';
import { postOpenGraphImage } from '@/lib/og/post-image';

/**
 * A post's link preview, `/og/p/<id>?v=<version>` (lib/og/post-image.tsx).
 * A plain route rather than an `opengraph-image` file beside the page: Next
 * hashes that file's path inside a route group, and the page names this
 * URL itself, with the version that tells platforms the picture changed.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return postOpenGraphImage((await params).id, request.nextUrl.searchParams.get('v'));
}

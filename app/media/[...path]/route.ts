import type { NextRequest } from 'next/server';
import { streamBlob } from '@/lib/infra/blob';

/**
 * Avatars out of the private Blob store. Avatars are shown to anyone who sees
 * the Ree or the user, so this serves only the `avatars/` prefix, and the
 * pathname carries a random id, so it caches for good.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const segments = (await context.params).path;
  const pathname = segments.map(decodeURIComponent).join('/');
  if (segments[0] !== 'avatars' || segments.length !== 3 || pathname.includes('..')) {
    return new Response(null, { status: 404 });
  }
  const blob = await streamBlob(pathname);
  if (!blob) return new Response(null, { status: 404 });
  return new Response(blob.stream, {
    headers: {
      'content-type': blob.contentType ?? 'image/webp',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

import type { NextRequest } from 'next/server';
import { streamBlob, streamBlobRange } from '@/lib/infra/blob';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Files out of the private Blob store that are meant to be seen: avatars,
 * shown to anyone who sees the Ree or the user, and (step 7) exported
 * introduction MP4s, which the owner downloads and shares. Both pathnames
 * carry random ids and never change, so they cache for good. Videos pass
 * byte ranges through for seeking; `?download=1` saves instead of playing.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const segments = (await context.params).path;
  /* Route params arrive decoded; decoding again would throw on a literal '%'. */
  const pathname = segments.join('/');
  if (segments.length !== 3 || pathname.includes('..')) return new Response(null, { status: 404 });

  if (segments[0] === 'videos') {
    const [, reeId, file] = segments;
    if (!ID.test(reeId!) || !file!.endsWith('.mp4') || !ID.test(file!.slice(0, -4))) return new Response(null, { status: 404 });
    const blob = await streamBlobRange(pathname, request.headers.get('range'));
    if (!blob) return new Response(null, { status: 404 });
    blob.headers.set('content-type', 'video/mp4');
    blob.headers.set('cache-control', 'public, max-age=31536000, immutable');
    blob.headers.set('x-content-type-options', 'nosniff');
    if (request.nextUrl.searchParams.get('download') === '1') blob.headers.set('content-disposition', 'attachment; filename="re0-introduction.mp4"');
    return new Response(blob.body, { status: blob.status, headers: blob.headers });
  }

  if (segments[0] !== 'avatars') return new Response(null, { status: 404 });
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

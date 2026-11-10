import type { NextRequest } from 'next/server';
import { REE_IMAGE_EXTENSIONS } from '@/lib/constants';
import { isAvatarPath, isReeCoverPath } from '@/lib/domain/ree';
import { streamBlob, streamBlobRange } from '@/lib/infra/blob';
import { currentUser } from '@/lib/http/session';
import { coverVisibleTo } from '@/lib/services/public-rees';
import { exportVisibleTo, narrationVisibleTo } from '@/lib/services/video';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Files out of the private Blob store that are meant to be seen: avatars,
 * shown to anyone who sees the Ree or the user, and (step 7) exported
 * introduction MP4s, which the owner downloads and shares. Both pathnames
 * carry random ids. Video access follows the Ree’s current publication status. Videos pass
 * byte ranges through for seeking; `?download=1` saves instead of playing.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const segments = (await context.params).path;
  /* Route params arrive decoded; decoding again would throw on a literal '%'. */
  const pathname = segments.join('/');
  /*
   * Each segment must be a plain name: the Blob SDK pastes the pathname into
   * a URL, where a decoded `%2e%2e`, `/`, `\\`, `?` or `#` would address a
   * different object than the one checked below.
   */
  if (segments.length !== 3 || segments.some((segment) => /[%/\\?#]/.test(segment)) || pathname.includes('..')) {
    return new Response(null, { status: 404 });
  }

  if (segments[0] === 'ree-covers') {
    const reeId = segments[1]!;
    if (!isReeCoverPath(pathname, reeId)) return new Response(null, { status: 404 });
    const viewer = await currentUser();
    if (!(await coverVisibleTo(reeId, pathname, viewer?.id ?? null))) return new Response(null, { status: 404 });
    const blob = await streamBlob(pathname);
    if (!blob?.contentType || !Object.hasOwn(REE_IMAGE_EXTENSIONS, blob.contentType)) return new Response(null, { status: 404 });
    return new Response(blob.stream, {
      headers: {
        'content-type': blob.contentType,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  if (segments[0] === 'video-narration') {
    const [, reeId, file] = segments;
    if (!ID.test(reeId!) || !file!.endsWith('.wav') || !ID.test(file!.slice(0, -4))) return new Response(null, { status: 404 });
    const viewer = await currentUser();
    if (!(await narrationVisibleTo(reeId!, file!.slice(0, -4), viewer?.id ?? null))) return new Response(null, { status: 404 });
    const blob = await streamBlobRange(pathname, request.headers.get('range'));
    if (!blob) return new Response(null, { status: 404 });
    blob.headers.set('content-type', 'audio/wav');
    blob.headers.set('cache-control', 'private, no-store');
    blob.headers.set('x-content-type-options', 'nosniff');
    return new Response(blob.body, { status: blob.status, headers: blob.headers });
  }

  if (segments[0] === 'videos') {
    const [, reeId, file] = segments;
    if (!ID.test(reeId!) || !file!.endsWith('.mp4') || !ID.test(file!.slice(0, -4))) return new Response(null, { status: 404 });
    /* Only a finished export: an upload that landed after its export was cancelled or abandoned is never served. */
    const viewer = await currentUser();
    if (!(await exportVisibleTo(reeId!, file!.slice(0, -4), viewer?.id ?? null))) return new Response(null, { status: 404 });
    const blob = await streamBlobRange(pathname, request.headers.get('range'));
    if (!blob) return new Response(null, { status: 404 });
    blob.headers.set('content-type', 'video/mp4');
    blob.headers.set('cache-control', 'private, no-store');
    blob.headers.set('x-content-type-options', 'nosniff');
    if (request.nextUrl.searchParams.get('download') === '1') blob.headers.set('content-disposition', 'attachment; filename="re0-introduction.mp4"');
    return new Response(blob.body, { status: blob.status, headers: blob.headers });
  }

  /* Public on purpose (avatars show to anyone who sees the Ree), so only the exact uploader shape and only images. */
  if (segments[0] !== 'avatars' || !isAvatarPath(pathname)) return new Response(null, { status: 404 });
  const blob = await streamBlob(pathname);
  if (!blob?.contentType || !Object.hasOwn(REE_IMAGE_EXTENSIONS, blob.contentType)) return new Response(null, { status: 404 });
  return new Response(blob.stream, {
    headers: {
      'content-type': blob.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

import { ImageResponse } from 'next/og';
import { isShowcaseExpired } from '@/lib/domain/showcase';
import { surfaceEnabled } from '@/lib/domain/surfaces';
import { showcaseLookup } from './lookup';

/**
 * The card a chat app or social feed shows for a shared link: the name, the
 * tagline and the page's accent. Text only, so it needs no font or image
 * fetch beyond what `next/og` ships; the page's own logo would need an
 * absolute, signed URL that a crawler may not be allowed to follow.
 */
export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  if (!surfaceEnabled('showcase')) return new Response(null, { status: 404 });
  const { slug } = await params;
  const found = await showcaseLookup(slug, false);
  const page = found.kind === 'page' ? found.page : null;
  const name = page?.document.content.name ?? 'Re0';
  const gated = Boolean(page && (page.gate.hasPassword || isShowcaseExpired(page.gate.expiresAt)));
  const tagline = gated ? '' : (page?.document.content.tagline ?? '');
  const accent = page?.accent ?? '#111111';
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '72px 88px',
          background: '#ffffff',
          color: '#031a1e',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', width: 120, height: 10, background: accent, borderRadius: 5, marginBottom: 40 }} />
        <div style={{ display: 'flex', fontSize: 72, fontWeight: 700, lineHeight: 1.1 }}>{name}</div>
        {tagline ? (
          <div style={{ display: 'flex', fontSize: 34, color: '#50686d', marginTop: 28, lineHeight: 1.35 }}>{tagline}</div>
        ) : null}
      </div>
    ),
    size,
  );
}

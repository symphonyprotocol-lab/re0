import { ImageResponse } from 'next/og';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { publicReeBySlug } from '@/lib/services/public-rees';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'RE0';

/**
 * Glyphs for the card's own text, subset by Google Fonts' `text=` so a
 * Chinese name does not render as boxes. Without the network, the default
 * font is used.
 */
async function fontFor(text: string): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch(`https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@700&text=${encodeURIComponent(text)}`, { signal: AbortSignal.timeout(3_000) }).then((response) => response.text());
    const url = /src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/.exec(css)?.[1];
    return url ? await fetch(url, { signal: AbortSignal.timeout(3_000) }).then((response) => response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** The link preview of a public page (rebuild-proposal.md 2.6 "分享链接"), drawn per Ree by `next/og`; step 7 swaps in the video's first frame. */
export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const ree = await publicReeBySlug((await params).slug);
  const name = ree?.name ?? 'RE0';
  const description = (ree?.description ?? '').slice(0, 120);
  const price = ree ? `${QUERY_BASE_FEE + ree.queryFee} credits / answer` : '';
  const facts = ree ? `${ree.sources} sources · ${ree.answers} answers` : '';
  const font = await fontFor(`RE0${name}${description}${price}${facts}`);
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: 'linear-gradient(135deg, #0b1a4a 0%, #091135 55%, #123a7a 100%)', color: 'white', fontFamily: font ? 'Noto Sans SC' : undefined }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 30, fontWeight: 700 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: '#127ee3', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 14, height: 14, borderRadius: 7, background: 'white' }} />
          </div>
          RE0
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.1 }}>{name}</div>
          {description && <div style={{ fontSize: 30, opacity: 0.75, lineHeight: 1.4 }}>{description}</div>}
        </div>
        <div style={{ display: 'flex', gap: 24, fontSize: 26, opacity: 0.85 }}>
          {price && <div style={{ padding: '10px 20px', borderRadius: 999, background: 'rgba(255,255,255,0.12)' }}>{price}</div>}
          {facts && <div style={{ padding: '10px 20px', borderRadius: 999, background: 'rgba(255,255,255,0.12)' }}>{facts}</div>}
        </div>
      </div>
    ),
    { ...size, fonts: font ? [{ name: 'Noto Sans SC', data: font, weight: 700, style: 'normal' }] : undefined },
  );
}

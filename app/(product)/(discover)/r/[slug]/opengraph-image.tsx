import { ImageResponse } from 'next/og';
import { BrandMark } from '@/components/ui/brand-mark';
import { QUERY_BASE_FEE } from '@/lib/constants';
import { publicReeBySlug } from '@/lib/services/public-rees';
import { introsFor } from '@/lib/services/video';
import type { IntroProps } from '@/lib/domain/video';
import { AVATAR_COLORS, mix, PALETTES } from '@/video/theme';

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

/**
 * The introduction's first frame (step 7, 8.4 "Open Graph 图换成视频首帧"):
 * shot 1 as the composition draws it on frame 0 -- template, accent, name
 * and positioning -- laid out on the preview's 1200×630. Satori cannot run
 * the composition itself, so this mirrors `Opening` in video/intro.tsx.
 */
function firstFrame(video: IntroProps, color: string, font: boolean) {
  const palette = PALETTES[video.template] ?? PALETTES.editorial;
  const tone = AVATAR_COLORS[color] ?? AVATAR_COLORS.default!;
  const ink = color === 'default' ? video.accent : tone.ink;
  const u = 630 / 720;
  const ring = mix(video.accent, palette.background, 0.16);
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative', background: palette.background, fontFamily: font ? 'Noto Sans SC' : undefined }}>
      <div style={{ position: 'absolute', width: 540, height: 540, right: -100, top: -200, borderRadius: 999, border: `2px solid ${ring}` }} />
      <div style={{ position: 'absolute', width: 760, height: 760, left: -300, bottom: -430, borderRadius: 999, border: `2px dashed ${ring}` }} />
      <div style={{ position: 'absolute', top: 36 * u, left: 44 * u, right: 44 * u, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 30 * u, fontWeight: 700, color: palette.watermark(video.accent) }}>RE0</span>
        <span style={{ fontSize: 13 * u, letterSpacing: 2 * u, color: palette.faint }}>YOUR KNOWLEDGE. A NEW VOICE.</span>
      </div>
      <span style={{ fontSize: 14 * u, letterSpacing: 3 * u, color: palette.faint }}>MEET YOUR KNOWLEDGE COMPANION</span>
      <div style={{ marginTop: 22 * u, width: 112 * u, height: 112 * u, borderRadius: 34 * u, border: `2px solid ${tone.border}`, background: color === 'default' ? mix(video.accent, '#ffffff', 0.1) : tone.background, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width={62 * u} height={62 * u} viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth={1.8} strokeLinecap="round">
          <circle cx="12" cy="12" r="3" fill={ink} stroke="none" />
          <path d="M8.3 5.1a7.8 7.8 0 0 1 10.6 10.6M15.7 18.9A7.8 7.8 0 0 1 5.1 8.3" />
          <circle cx="6" cy="6" r="1.7" fill={ink} stroke="none" />
          <circle cx="18" cy="18" r="1.7" fill={ink} stroke="none" />
        </svg>
      </div>
      <div style={{ marginTop: 22 * u, fontSize: 68 * u, fontWeight: 700, color: palette.title }}>{video.scenes.opening.name}</div>
      <div style={{ marginTop: 22 * u, width: 0.22 * 820 * u, height: 4 * u, borderRadius: 4, background: video.accent }} />
      <div style={{ marginTop: 22 * u, fontSize: 30 * u, color: palette.body }}>{video.scenes.opening.position}</div>
      <div style={{ position: 'absolute', bottom: 34 * u, left: 44 * u, right: 44 * u, display: 'flex', gap: 10 * u }}>
        {[3, 4, 5, 3].map((seconds, index) => (
          <div key={index} style={{ flexGrow: seconds, height: 4 * u, borderRadius: 4, background: index === 0 ? video.accent : mix(palette.faint, palette.background, 0.35) }} />
        ))}
      </div>
    </div>
  );
}

/** The link preview of a public page (rebuild-proposal.md 2.6 "分享链接"), drawn per Ree by `next/og`: the video's first frame once it has one. */
export default async function OpenGraphImage({ params }: { params: Promise<{ slug: string }> }) {
  const ree = await publicReeBySlug((await params).slug);
  const video = ree ? ((await introsFor([ree.id])).get(ree.id) ?? null) : null;
  if (ree && video) {
    const text = `RE0${video.scenes.opening.name}${video.scenes.opening.position}MEETYOURKNOWLEDGECOMPANIONANEWVOICE.`;
    const font = await fontFor(text);
    return new ImageResponse(firstFrame(video, ree.color, Boolean(font)), { ...size, fonts: font ? [{ name: 'Noto Sans SC', data: font, weight: 700, style: 'normal' }] : undefined });
  }
  const name = ree?.name ?? 'RE0';
  const description = (ree?.description ?? '').slice(0, 120);
  const price = ree ? `${QUERY_BASE_FEE + ree.queryFee} credits / answer` : '';
  const facts = ree ? `${ree.sources} sources · ${ree.answers} answers` : '';
  const font = await fontFor(`RE0${name}${description}${price}${facts}`);
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, background: 'linear-gradient(135deg, #0b1a4a 0%, #091135 55%, #123a7a 100%)', color: 'white', fontFamily: font ? 'Noto Sans SC' : undefined }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, fontSize: 30, fontWeight: 700 }}>
          <BrandMark size={48} />
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

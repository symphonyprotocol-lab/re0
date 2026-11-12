import { ImageResponse } from 'next/og';
import { BrandMark } from '@/components/ui/brand-mark';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'RE0 — Your knowledge, a voice of its own';

/**
 * The site's link preview, for every page without its own (a public Ree
 * has lib/og/ree-image.tsx). English only, so the built-in font covers it
 * and the image renders once at build time with no font fetch. The navy
 * and blue are the Ree card's and globals.css's.
 */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 72, position: 'relative', background: 'linear-gradient(135deg, #0b1a4a 0%, #091135 55%, #123a7a 100%)', color: 'white' }}>
        <div style={{ position: 'absolute', width: 620, height: 620, right: -160, top: -240, borderRadius: 999, border: '2px solid rgba(119,183,250,0.28)' }} />
        <div style={{ position: 'absolute', width: 820, height: 820, right: -380, bottom: -520, borderRadius: 999, border: '2px dashed rgba(119,183,250,0.22)' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 36, fontWeight: 700 }}>
            <BrandMark size={56} />
            RE0
          </div>
          <div style={{ fontSize: 18, letterSpacing: 4, color: 'rgba(255,255,255,0.55)' }}>KNOWLEDGE, GIVEN A VOICE</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          <div style={{ display: 'flex', flexDirection: 'column', fontSize: 76, fontWeight: 700, lineHeight: 1.08 }}>
            <span>Your knowledge,</span>
            <span style={{ color: '#77b7fa' }}>a voice of its own.</span>
          </div>
          <div style={{ fontSize: 30, lineHeight: 1.4, color: 'rgba(255,255,255,0.75)', maxWidth: 900 }}>
            Create a Ree, give it your documents, audio, repositories and pages. It answers only from that knowledge, with citations.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 18, fontSize: 24, color: 'rgba(255,255,255,0.85)' }}>
          {['Answers with citations', 'Publish for others to ask', 're0.io'].map((label) => (
            <div key={label} style={{ padding: '10px 22px', borderRadius: 999, background: 'rgba(255,255,255,0.12)' }}>{label}</div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}

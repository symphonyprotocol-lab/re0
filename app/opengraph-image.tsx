import { ImageResponse } from 'next/og';
import { messagesFor } from '@/lib/i18n/dictionary';

/**
 * The card a chat app or a social feed shows for any page that has no card of
 * its own: the mark, the name and the one-line description. Text and vector
 * only, so it needs no font or image fetch beyond what `next/og` ships -- the
 * same restraint as app/s/[slug]/opengraph-image.tsx. One image for both
 * languages, in English: the card is rendered once and cached, not per
 * visitor, and the English line is the wider fallback (lib/i18n/locale.ts).
 */
export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Re0';

const BRAND = '#127ee3';
const INK = '#091135';
const MUTED = '#36394a';

export default function Image() {
  const t = messagesFor('en');
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
          color: INK,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 28, marginBottom: 44 }}>
          <svg viewBox="0 0 32 32" width="96" height="96" aria-hidden>
            <rect width="32" height="32" rx="8" fill={BRAND} />
            <g fill="#ffffff" stroke="#ffffff" strokeWidth="1" strokeLinejoin="round">
              <path d="M17.25 8.91 A 7.2 7.2 0 1 0 23.2 16" fill="none" strokeWidth="3" />
              <circle cx="17.25" cy="8.91" r="1.5" stroke="none" />
              <path d="M23.2 11.4 L 25.75 16 L 20.65 16 Z" />
              <circle cx="16" cy="16" r="2.5" stroke="none" />
            </g>
          </svg>
          <div style={{ display: 'flex', fontSize: 84, fontWeight: 700, letterSpacing: '-0.02em' }}>
            {t.meta.siteName}
          </div>
        </div>
        <div style={{ display: 'flex', fontSize: 40, fontWeight: 600, lineHeight: 1.25, maxWidth: 1000 }}>
          {t.footer.tagline}
        </div>
        <div style={{ display: 'flex', fontSize: 28, lineHeight: 1.4, color: MUTED, marginTop: 24, maxWidth: 1000 }}>
          {t.meta.description}
        </div>
        <div style={{ display: 'flex', fontSize: 24, color: BRAND, marginTop: 56 }}>re0.io</div>
      </div>
    ),
    size,
  );
}

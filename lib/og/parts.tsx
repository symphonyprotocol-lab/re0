import { AVATAR_COLORS } from '@/video/theme';

/*
 * What the site's and the posts' link previews share (1200×630, `next/og`):
 * a white ground with the brand's faint rings, the ink and blue of
 * globals.css, and a Ree's avatar as the feed draws it. Satori takes flex
 * layouts and inline styles only.
 */

export const OG_SIZE = { width: 1200, height: 630 };

export const PAPER = {
  background: '#ffffff',
  ink: '#14213d',
  body: '#4b5f80',
  muted: '#7b8ba6',
  accent: '#127ee3',
  soft: '#f5f8fe',
  tint: '#e9f2fd',
  line: '#e0eafa',
  dashed: '#bfd3f0',
  ring: 'rgba(18,126,227,0.13)',
} as const;

/** The two rings in the corner, as on the Ree card, on white. */
export function Rings() {
  return (
    <>
      <div style={{ position: 'absolute', width: 620, height: 620, right: -200, top: -330, borderRadius: 999, border: `2px solid ${PAPER.ring}` }} />
      <div style={{ position: 'absolute', width: 820, height: 820, right: -420, bottom: -600, borderRadius: 999, border: `2px dashed ${PAPER.ring}` }} />
    </>
  );
}

/**
 * A Ree's avatar: its image (already a data URL: satori fails the whole
 * card on an image it cannot load) or the Ree mark on its color.
 * `ring` draws a border in that color, for avatars stacked on each other.
 */
export function ReeTile({ color, image, size, ring }: { color: string; image?: string | null; size: number; ring?: string }) {
  const tone = AVATAR_COLORS[color] ?? AVATAR_COLORS.default!;
  const radius = Math.round(size * 0.3);
  const border = `${ring ? 3 : 1.5}px solid ${ring ?? tone.border}`;
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={image} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: radius, border, objectFit: 'cover', flexShrink: 0 }} />;
  }
  return (
    <div style={{ width: size, height: size, borderRadius: radius, background: tone.background, border, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24" fill="none" stroke={tone.ink} strokeWidth={1.8} strokeLinecap="round">
        <circle cx="12" cy="12" r="3" fill={tone.ink} stroke="none" />
        <path d="M8.3 5.1a7.8 7.8 0 0 1 10.6 10.6M15.7 18.9A7.8 7.8 0 0 1 5.1 8.3" />
        <circle cx="6" cy="6" r="1.7" fill={tone.ink} stroke="none" />
        <circle cx="18" cy="18" r="1.7" fill={tone.ink} stroke="none" />
      </svg>
    </div>
  );
}

/** A small rounded label. */
export function Chip({ children, size = 20, color = PAPER.body, background = PAPER.soft }: { children: string; size?: number; color?: string; background?: string }) {
  return <div style={{ display: 'flex', fontSize: size, padding: `${Math.round(size * 0.3)}px ${Math.round(size * 0.85)}px`, borderRadius: 999, background, color }}>{children}</div>;
}

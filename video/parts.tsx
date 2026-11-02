/**
 * Pieces every shot shares: the template's backdrop, the RE0 watermark, the
 * Ree's avatar, line icons, the closing QR code and the crossfade around
 * each cut. Sizes are in units of the frame's short side over 720, so
 * landscape and portrait share one type scale.
 */
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { AbsoluteFill, Easing, Img, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { VIDEO_TRANSITION_FRAMES } from '@/lib/constants';
import { AVATAR_COLORS, MONO, mix, type Palette } from './theme';

export function useUnit(): number {
  const { width, height } = useVideoConfig();
  return Math.min(width, height) / 720;
}

const HALF = VIDEO_TRANSITION_FRAMES / 2;

/**
 * One shot on the timeline, crossfading over 0.4 s across each of its cuts
 * (half before, half after), so the four still add up to exactly 15 s. The
 * first shot is fully drawn on frame 0 -- the link preview is that frame --
 * and the last holds to the end.
 */
export function ShotFade({ first, last, length, children }: { first: boolean; last: boolean; length: number; children: ReactNode }) {
  const frame = useCurrentFrame();
  const opacity = Math.min(
    first ? 1 : interpolate(frame, [0, VIDEO_TRANSITION_FRAMES], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    last ? 1 : interpolate(frame, [length - VIDEO_TRANSITION_FRAMES, length], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  );
  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
}

/** Where a shot's sequence starts and how long it runs, the crossfade margins included. */
export function shotSpan(start: number, end: number, total: number): { from: number; durationInFrames: number; first: boolean; last: boolean } {
  const first = start === 0;
  const last = end === total;
  const from = first ? 0 : start - HALF;
  const until = last ? total : end + HALF;
  return { from, durationInFrames: until - from, first, last };
}

/**
 * The template's grid -- dots, or lines for the blueprint -- as one SVG image
 * with a pattern: the web renderer draws images exactly as the Player does,
 * while radial gradients and layered `background-size` gradients it does not.
 */
function gridImage(kind: Palette['grid'], step: number, width: number, height: number): string {
  const cell =
    kind === 'lines'
      ? `<path d="M ${step} 0 L 0 0 0 ${step}" fill="none" stroke="rgba(70, 110, 160, 0.28)" stroke-width="1"/>`
      : `<circle cx="${step / 2}" cy="${step / 2}" r="${step / 24}" fill="${kind === 'faint-dots' ? '#e4dccb' : '#b9cbe3'}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><pattern id="g" width="${step}" height="${step}" patternUnits="userSpaceOnUse">${cell}</pattern></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The template's backdrop: its colour, a grid, and two slow outlined circles in the accent. */
export function Backdrop({ palette, accent }: { palette: Palette; accent: string }) {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const u = useUnit();
  const step = Math.round(40 * u);
  const grid = useMemo(() => gridImage(palette.grid, step, width, height), [palette.grid, step, width, height]);
  const ring = mix(accent, palette.background, 0.16);
  const big = Math.max(width, height);
  return (
    <AbsoluteFill style={{ backgroundColor: palette.background, overflow: 'hidden' }}>
      <Img src={grid} style={{ position: 'absolute', inset: 0, width, height, opacity: palette.grid === 'faint-dots' ? 0.5 : palette.grid === 'lines' ? 1 : 0.75 }} />
      <div
        style={{
          position: 'absolute',
          width: big * 0.42,
          height: big * 0.42,
          right: -big * 0.08,
          top: -big * 0.16,
          borderRadius: '50%',
          border: `${Math.max(1, 2 * u)}px solid ${ring}`,
          translate: `0px ${interpolate(frame, [0, durationInFrames], [0, 24 * u])}px`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: big * 0.6,
          height: big * 0.6,
          left: -big * 0.24,
          bottom: -big * 0.34,
          borderRadius: '50%',
          border: `${Math.max(1, 2 * u)}px dashed ${ring}`,
          rotate: `${interpolate(frame, [0, durationInFrames], [0, 18])}deg`,
        }}
      />
    </AbsoluteFill>
  );
}

/** The top line (prototype `.video-watermark`) and a four-part progress strip at the bottom. */
export function Chrome({ palette, accent, music, shot }: { palette: Palette; accent: string; music: boolean; shot: number }) {
  const u = useUnit();
  const inset = 44 * u;
  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', top: 36 * u, left: inset, right: inset, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 30 * u, letterSpacing: -1 * u, color: palette.watermark(accent) }}>RE0</span>
        <span style={{ fontFamily: MONO, fontSize: 13 * u, letterSpacing: 2 * u, color: palette.faint }}>YOUR KNOWLEDGE. A NEW VOICE.</span>
      </div>
      <div style={{ position: 'absolute', bottom: 34 * u, left: inset, right: inset, display: 'flex', alignItems: 'center', gap: 10 * u }}>
        {[3, 4, 5, 3].map((seconds, index) => (
          <div
            key={index}
            style={{ flex: seconds, height: 4 * u, borderRadius: 4 * u, backgroundColor: index <= shot ? accent : mix(palette.faint, palette.background, 0.35) }}
          />
        ))}
        {music && <Glyph name="music" color={palette.faint} size={22 * u} />}
      </div>
    </AbsoluteFill>
  );
}

const GLYPHS: Record<string, string> = {
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  sparkle: 'M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
};

/** A line icon with its colour written into the SVG (an icon drawn as an image cannot inherit `currentColor`). */
export function Glyph({ name, color, size, style }: { name: keyof typeof GLYPHS; color: string; size: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', ...style }}>
      <path d={GLYPHS[name]} />
    </svg>
  );
}

/** The Ree's avatar, or its mark on its colour (components/ui/ree-avatar.tsx). */
export function Avatar({ url, color, accent, size }: { url: string | null; color: string; accent: string; size: number }) {
  const tone = AVATAR_COLORS[color] ?? AVATAR_COLORS.default!;
  const ink = color === 'default' ? accent : tone.ink;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        overflow: 'hidden',
        border: `${Math.max(1, size / 48)}px solid ${tone.border}`,
        backgroundColor: color === 'default' ? mix(accent, '#ffffff', 0.1) : tone.background,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      }}
    >
      {url ? (
        <Img src={url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke={ink} strokeWidth={1.8} strokeLinecap="round">
          <circle cx="12" cy="12" r="3" fill={ink} stroke="none" />
          <path d="M8.3 5.1a7.8 7.8 0 0 1 10.6 10.6M15.7 18.9A7.8 7.8 0 0 1 5.1 8.3" />
          <circle cx="6" cy="6" r="1.7" fill={ink} stroke="none" />
          <circle cx="18" cy="18" r="1.7" fill={ink} stroke="none" />
        </svg>
      )}
    </div>
  );
}

/** The public page as a QR code, drawn as an SVG image from the module matrix. */
export function QrCode({ url, size, ink }: { url: string; size: number; ink: string }) {
  const src = useMemo(() => {
    const code = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const count = code.modules.size;
    let path = '';
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (code.modules.get(row, column)) path += `M${column + 2} ${row + 2}h1v1h-1z`;
      }
    }
    const side = count + 4;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#ffffff"/><path d="${path}" fill="${ink}"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }, [url, ink]);
  return <Img src={src} style={{ width: size, height: size, borderRadius: size * 0.06 }} />;
}

/** The entrance used across shots: fade and rise over `duration` frames from `delay`. */
export function useEntrance(delay: number, duration = 12): { opacity: number; translate: string } {
  const frame = useCurrentFrame();
  const u = useUnit();
  const progress = interpolate(frame, [delay, delay + duration], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return { opacity: progress, translate: `0px ${(1 - progress) * 24 * u}px` };
}

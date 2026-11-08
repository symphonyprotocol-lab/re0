/**
 * Colours and type for the narrated videos, their posters and link
 * previews. Colours are mixed here rather than with CSS `color-mix()`, and
 * the backgrounds use only what the web renderer paints (linear gradients,
 * borders, images).
 */

export const SANS = '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", -apple-system, "Segoe UI", Roboto, sans-serif';
export const SERIF = 'Georgia, "Songti SC", "Noto Serif SC", "STSong", serif';
export const MONO = '"SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

/** The still poster of an introduction (cards and the link preview): a light page with the accent. */
export const POSTER = {
  background: '#f2f6ff',
  title: '#314d75',
  body: '#7f97b8',
  faint: '#a2b4cd',
  watermark: (accent: string) => accent,
};

function channels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** `share` of `a` over `b`, as `rgb()`: the same result as CSS `color-mix(in srgb, a share, b)`. */
export function mix(a: string, b: string, share: number): string {
  const [ar, ag, ab] = channels(a);
  const [br, bg, bb] = channels(b);
  const at = (x: number, y: number) => Math.round(x * share + y * (1 - share));
  return `rgb(${at(ar, br)}, ${at(ag, bg)}, ${at(ab, bb)})`;
}

/** The six Ree colours (components/ui/ree-avatar.tsx) for a Ree without an uploaded avatar. */
export const AVATAR_COLORS: Record<string, { background: string; ink: string; border: string }> = {
  default: { background: '#eef4ff', ink: '#127ee3', border: '#e0eafa' },
  lilac: { background: '#f1edfb', ink: '#9275bf', border: '#e8e1f5' },
  sand: { background: '#f9f4ec', ink: '#a18a60', border: '#eee7da' },
  sage: { background: '#eaf4f0', ink: '#5b8e7e', border: '#dfebe5' },
  rose: { background: '#faf0f0', ink: '#b47e81', border: '#f2e5e5' },
  slate: { background: '#edf0f6', ink: '#7589a9', border: '#e0e6ef' },
};

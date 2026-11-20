/**
 * Fonts for the `next/og` cards. Satori's built-in font is Latin only and
 * has no bold, so a card with Chinese, or one that wants real weights,
 * fetches Noto Sans SC from Google Fonts, subset by `text=` to the glyphs
 * it draws (tens of KB for a card, where the whole face is ~8 MB a weight
 * and satori cannot read woff2). Without the network, null: a caller draws
 * a card that needs no font instead of one with boxes for letters.
 */

export const OG_FONT_FAMILY = 'Noto Sans SC';

export type OgFont = { name: string; data: ArrayBuffer; weight: 400 | 700; style: 'normal' };

const TIMEOUT_MS = 3_000;

async function subset(text: string, weight: 400 | 700): Promise<ArrayBuffer> {
  const query = `family=${encodeURIComponent(OG_FONT_FAMILY)}:wght@${weight}&text=${encodeURIComponent(text)}`;
  const css = await fetch(`https://fonts.googleapis.com/css2?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then((response) => {
    if (!response.ok) throw new Error(`fonts.googleapis.com ${response.status}`);
    return response.text();
  });
  const url = /src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/.exec(css)?.[1];
  if (!url) throw new Error('no font in the stylesheet');
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then((response) => {
    if (!response.ok) throw new Error(`font ${response.status}`);
    return response.arrayBuffer();
  });
}

/** The glyphs of `text` (each once) in the given weights, or null if any could not be fetched. */
export async function ogFonts(text: string, weights: readonly (400 | 700)[] = [400, 700]): Promise<OgFont[] | null> {
  /* With the ellipsis satori's lineClamp may draw, whether or not the text has one. */
  const glyphs = [...new Set(`${text.replace(/\s/g, '')}…`)].join('') + ' ';
  try {
    const data = await Promise.all(weights.map((weight) => subset(glyphs, weight)));
    return weights.map((weight, index) => ({ name: OG_FONT_FAMILY, data: data[index]!, weight, style: 'normal' }));
  } catch {
    return null;
  }
}

/** Every string in a card's tree, for the subset: what `ogFonts` needs to be given. */
export function textOf(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    const element = node as { type: unknown; props: { children?: unknown } };
    if (typeof element.type === 'function') return textOf((element.type as (props: unknown) => unknown)(element.props));
    return textOf(element.props.children);
  }
  return '';
}

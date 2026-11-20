import { createHash } from 'node:crypto';
import { plainOf, redact } from '@/lib/domain/public-qa';

/*
 * The words on a link preview (`next/og`), before layout: satori's
 * `lineClamp` draws the ellipsis, but it cuts at the last glyph that fits,
 * mid-word in English, and every glyph it may draw is fetched in the font
 * subset (lib/og/font.ts). So text is laid out here first, by an estimate
 * of each word's width, and cut after the last whole word of its last
 * line; the clamp ends whatever the estimate let through, and the subset
 * stays small.
 */

const WIDE = /[\u1100-\u11FF\u2E80-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]/;

/**
 * The width of `text` in ems, roughly, for Noto Sans SC: CJK and
 * full-width 1, Latin about half (measured against satori's layout of
 * it: bold sets Latin about 2% wider than regular).
 */
export function ems(text: string, bold = false): number {
  let width = 0;
  for (const char of text) {
    if (WIDE.test(char)) {
      width += 1;
      continue;
    }
    const latin = char === ' ' ? 0.28 : /[ijlt.,'’:;!|()[\]]/.test(char) ? 0.3 : /[A-Z0-9%@#&mwMW]/.test(char) ? 0.62 : 0.52;
    width += latin * (bold ? 1.05 : 1.03);
  }
  return width;
}

/** Words (a run of non-space, non-CJK characters, with the spaces after it) and single CJK characters, in order. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let word = '';
  for (const char of text) {
    if (WIDE.test(char)) {
      if (word) out.push(word);
      out.push(char);
      word = '';
    } else if (char === ' ' || !word.endsWith(' ')) {
      word += char;
    } else {
      out.push(word);
      word = char;
    }
  }
  if (word) out.push(word);
  return out;
}

/**
 * `text` (whitespace folded) as it fits `lines` lines of `perLine` ems:
 * whole if it does, else cut after the last whole word of the last line --
 * anywhere in CJK, which has no words -- with room left for "…". A word
 * longer than a line is cut by its characters.
 */
export function fitLines(text: string, perLine: number, lines: number, bold = false): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const all = tokens(line);
  const cut: string[] = [];
  let row = 1;
  let width = 0;
  for (const [index, token] of all.entries()) {
    const size = ems(token.trimEnd(), bold);
    /* The last line keeps an em for the ellipsis, unless this is the last word. */
    const room = row === lines && index < all.length - 1 ? perLine - 1 : perLine;
    if (width + size <= room) {
      cut.push(token);
      width += ems(token, bold);
      continue;
    }
    if (row < lines && size <= perLine) {
      row += 1;
      cut.push(token);
      width = ems(token, bold);
      continue;
    }
    if (width === 0 || size > perLine) {
      /* A word longer than a line: what fits of it, by its characters. */
      for (const char of token) {
        const next = ems(char, bold);
        if (width + next > perLine - 1) break;
        cut.push(char);
        width += next;
      }
    }
    return `${cut.join('').replace(/[\s,，、。.:：;；·-]+$/u, '')}…`;
  }
  return line;
}

/** One line of at most `budget` ems (`fitLines` with one line). */
export function fitText(text: string, budget: number, bold = false): string {
  return fitLines(text, budget, 1, bold);
}

/**
 * An answer as the preview quotes it: plain text (no Markdown), no
 * citation markers, and what could identify a person replaced as in an
 * asker's question -- answers are not redacted when written (they keep
 * their sources' links), and a link is no use in an image anyway.
 */
export function coverExcerpt(markdown: string, lang: 'zh' | 'en'): string {
  return redact(plainOf(markdown).replace(/ ?\[\d{1,3}\]/g, ''), lang).replace(/\s+/g, ' ').trim();
}

/**
 * What the post's preview shows, as a short hash for its URL (`?v=`): the
 * question, the language, how many Rees answered and which answer leads.
 * A new answer, a different first answer or an edit gives a new URL, so a
 * platform that fetches the page again also fetches the image again; more
 * helpful votes that leave the order alone keep it.
 */
export function coverVersion(input: { question: string; lang: string; answers: number; firstAnswerId: string | null; firstText?: string | null }): string {
  return createHash('sha256')
    .update(JSON.stringify([input.question, input.lang, input.answers, input.firstAnswerId, input.firstText ?? null]))
    .digest('base64url')
    .slice(0, 12);
}

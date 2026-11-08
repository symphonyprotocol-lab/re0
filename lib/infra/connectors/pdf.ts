/**
 * PDFs with a usable text layer, parsed locally (pdf.js through unpdf's
 * serverless build: no canvas, no worker). The whole document is checked
 * first; if any page fails a check, the caller sends the whole file to
 * Firecrawl instead, so one document never mixes two parsers:
 *
 * - unreadable: pdf.js cannot open the file or a page (corrupt, encrypted).
 * - font_failed: a font on the page could not be loaded, so its text is
 *   silently missing (CJK fonts that need pdf.js's predefined CMaps, broken
 *   embedded fonts).
 * - image_page: the page has almost no text but paints an image (a scan).
 * - garbled: replacement, private-use and control characters make up too
 *   much of the text (fonts without a usable ToUnicode map).
 * - no_text: no page has any text at all (text drawn as outlines, say).
 *
 * Otherwise each page is rebuilt as Markdown from its text items: lines by
 * baseline, paragraphs by line gaps, headings by font size, and headers,
 * footers and page numbers that repeat at the same place removed. Pages keep
 * their physical numbers; blank pages are dropped after numbering.
 */
import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import type { Section } from '@/lib/domain/knowledge';
import { ProcessingFailure } from './failure';

/** A page with fewer non-whitespace characters than this that paints an image is a scan. */
const IMAGE_PAGE_MAX_CHARS = 30;
/** Above this share of bad characters (U+FFFD, private use, controls) the text layer is unusable. */
const GARBLED_SHARE_MAX = 0.05;
/** A single page is judged garbled on its own only with at least this many characters. */
const GARBLED_PAGE_MIN_CHARS = 50;
/** Items whose baselines differ by less than this share of the font size are one line. */
const LINE_Y_TOLERANCE = 0.5;
/** A gap between items wider than this share of the font size gets a space. */
const WORD_GAP = 0.15;
/** A line gap this many times the document's usual gap starts a new paragraph. */
const PARAGRAPH_GAP_RATIO = 1.4;
/**
 * The usual gap (baseline to baseline, share of the font size) is capped
 * here: with few lines, the median gap may be a paragraph gap. Single-spaced
 * text sits near 1.2; double-spaced text then reads as one line per paragraph.
 */
const LINE_GAP_MAX = 1.5;
/** Font size against the body median: at least this ratio is `##`, ... */
const HEADING_RATIO = 1.2;
/** ... and at least this ratio is `#`. */
const TITLE_RATIO = 1.6;
/** Longer lines are emphasised body text, not headings. */
const HEADING_MAX_CHARS = 100;
/** Lines this close to the top or bottom edge (share of page height) can be headers or footers. */
const EDGE_BAND = 0.12;
/** How many lines at each edge are header and footer candidates. */
const EDGE_LINES = 2;
/** Header and footer detection needs at least this many pages ... */
const REPEAT_MIN_PAGES = 3;
/** ... and the same text (digits aside) at the same place on at least this share of them. */
const REPEAT_SHARE = 0.6;

export type PdfFallback = 'unreadable' | 'font_failed' | 'image_page' | 'garbled' | 'no_text';
export type PdfTextLayer = { sections: Section[] } | { fallback: PdfFallback; page?: number };

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

interface Line {
  text: string;
  /** Baseline, PDF units from the bottom of the page. */
  y: number;
  x: number;
  end: number;
  /** Character-weighted font size. */
  size: number;
  chars: number;
}

interface PageLines {
  number: number;
  height: number;
  lines: Line[];
}

const BAD_CHARACTER = /[�-\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­]/g;
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/u;
const BULLET = /^[•●▪◦‣∙○■□◆◇➢►]\s*/u;
const NUMBERED = /^(?:\d{1,3}|[a-zA-Z])[.)]\s|^[(（]\d{1,3}[)）]/u;
const PAGE_NUMBER = /^(?:(?:page|p\.)\s*)?[-–—]?\s*(?:\d{1,4}|[ivxlc]{1,7})\s*[-–—]?(?:\s*(?:of|\/)\s*\d{1,4})?$|^第\s*\d{1,4}\s*页(?:\s*[,，/]?\s*共\s*\d{1,4}\s*页)?$/iu;

const nonWhitespace = (text: string): number => text.replace(/\s+/g, '').length;
const badCharacters = (text: string): number => text.match(BAD_CHARACTER)?.length ?? 0;

/** Text items in content-stream order, grouped into lines by baseline. */
function toLines(items: readonly TextItem[], bottom: number): Line[] {
  const lines: Line[] = [];
  let current: Line | undefined;
  let weighted = 0;
  for (const item of items) {
    if (!item.str) continue;
    const [, , c = 0, d = 0, x = 0, baseline = 0] = item.transform;
    const y = baseline - bottom;
    const size = Math.hypot(c, d) || item.height || 1;
    const chars = nonWhitespace(item.str);
    const sameLine = current && Math.abs(y - current.y) <= LINE_Y_TOLERANCE * Math.max(size, current.size) && x >= current.x - size;
    if (!current || !sameLine) {
      current = { text: '', y, x, end: x, size, chars: 0 };
      weighted = 0;
      lines.push(current);
    }
    const before = current.text.at(-1) ?? '';
    const after = item.str[0] ?? '';
    const gap = x - current.end;
    if (current.text && gap > WORD_GAP * size && !/\s/.test(before) && !/\s/.test(after) && !(CJK.test(before) && CJK.test(after))) {
      current.text += ' ';
    }
    current.text += item.str;
    current.end = Math.max(current.end, x + item.width);
    if (chars > 0) {
      weighted += size * chars;
      current.chars += chars;
      current.size = weighted / current.chars;
    }
  }
  return lines
    .map((line) => ({ ...line, text: line.text.replace(CONTROL, '').replace(/\s+/g, ' ').trim() }))
    .filter((line) => line.text.length > 0);
}

/** The character-weighted median of `value` over `lines`. */
function weightedMedian(lines: readonly Line[], value: (line: Line) => number): number {
  const sorted = [...lines].sort((a, b) => value(a) - value(b));
  const total = sorted.reduce((sum, line) => sum + line.chars, 0);
  let seen = 0;
  for (const line of sorted) {
    seen += line.chars;
    if (seen * 2 >= total) return value(line);
  }
  return value(sorted.at(-1)!);
}

/** Header, footer and page-number lines: near an edge, and repeated on most pages or a bare number. */
function stripMargins(pages: PageLines[]): void {
  const edgeLines = (page: PageLines): Line[] => {
    const byHeight = [...page.lines].sort((a, b) => b.y - a.y);
    const top = byHeight.slice(0, EDGE_LINES).filter((line) => line.y >= page.height * (1 - EDGE_BAND));
    const bottom = byHeight.slice(-EDGE_LINES).filter((line) => line.y <= page.height * EDGE_BAND);
    return [...new Set([...top, ...bottom])];
  };
  const key = (line: Line): string => `${Math.round(line.y)}|${line.text.toLowerCase().replace(/\d+/g, '#')}`;
  const seenOn = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const line of edgeLines(page)) {
      const pagesWith = seenOn.get(key(line)) ?? new Set<number>();
      pagesWith.add(page.number);
      seenOn.set(key(line), pagesWith);
    }
  }
  const repeats = pages.length >= REPEAT_MIN_PAGES;
  for (const page of pages) {
    const margins = new Set(edgeLines(page).filter((line) =>
      PAGE_NUMBER.test(line.text) || (repeats && seenOn.get(key(line))!.size >= REPEAT_SHARE * pages.length)));
    page.lines = page.lines.filter((line) => !margins.has(line));
  }
}

/** Joins two lines of one paragraph: no space inside CJK text or after a line-end hyphen. */
function joinLines(left: string, right: string): string {
  const last = left.at(-1) ?? '';
  if (CJK.test(last) && CJK.test(right[0] ?? '')) return left + right;
  if (/[A-Za-z]-$/.test(left) && /^[a-z]/.test(right)) return left + right;
  return `${left} ${right}`;
}

function pageMarkdown(lines: readonly Line[], body: number, gap: number): string {
  const blocks: { text: string; listItem: boolean }[] = [];
  let previous: Line | undefined;
  let previousLevel = 0;
  for (const line of lines) {
    const ratio = line.size / body;
    const level = line.text.length <= HEADING_MAX_CHARS && /[\p{L}\p{N}]/u.test(line.text)
      ? ratio >= TITLE_RATIO ? 1 : ratio >= HEADING_RATIO ? 2 : 0
      : 0;
    const drop = previous ? previous.y - line.y : 0;
    const listItem = level === 0 && (BULLET.test(line.text) || NUMBERED.test(line.text));
    const text = line.text.replace(BULLET, '- ');
    const continues = previous !== undefined && blocks.length > 0 && level === previousLevel && !listItem
      && drop > 0 && drop <= PARAGRAPH_GAP_RATIO * gap * Math.max(line.size, previous.size);
    if (continues) {
      const block = blocks.at(-1)!;
      block.text = joinLines(block.text, text);
    } else {
      blocks.push({ text: level > 0 ? `${'#'.repeat(level)} ${text}` : text, listItem });
    }
    previous = line;
    previousLevel = level;
  }
  // Consecutive list items stay one list; every other block is its own paragraph.
  return blocks.map((block, at) => (at === 0 ? '' : block.listItem && blocks[at - 1]!.listItem ? '\n' : '\n\n') + block.text).join('');
}

/** Reads the text layer, or says why Firecrawl should parse the file instead. */
export async function pdfTextLayer(bytes: Uint8Array): Promise<PdfTextLayer> {
  const { OPS } = await getResolvedPDFJS();
  const imageOps = new Set<number>([
    OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup,
    OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat,
  ]);
  /*
   * pdf.js detaches the buffer it parses, and Firecrawl may still need the
   * bytes, so each document gets a copy. This one skips images (no decoding)
   * and is used for text and fonts; `withImages` opens only for near-empty pages.
   */
  const open = (options: { maxImageSize?: number }) => getDocumentProxy(new Uint8Array(bytes), { verbosity: 0, ...options });
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await open({ maxImageSize: 1 });
  } catch {
    return { fallback: 'unreadable' };
  }
  let withImages: typeof pdf | undefined;
  try {
    const pages: PageLines[] = [];
    let chars = 0;
    let bad = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const operators = await page.getOperatorList();
      const fonts = new Set(operators.fnArray.flatMap((fn, at) => fn === OPS.setFont ? [String(operators.argsArray[at]?.[0])] : []));
      // A font pdf.js failed to load resolves to its error message instead of a font object.
      if ([...fonts].some((font) => page.commonObjs.has(font) && typeof page.commonObjs.get(font) === 'string')) {
        return { fallback: 'font_failed', page: number };
      }
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join('');
      const pageChars = nonWhitespace(text);
      const pageBad = badCharacters(text);
      if (pageChars >= GARBLED_PAGE_MIN_CHARS && pageBad > GARBLED_SHARE_MAX * pageChars) return { fallback: 'garbled', page: number };
      if (pageChars < IMAGE_PAGE_MAX_CHARS) {
        withImages ??= await open({});
        const imagePage = await withImages.getPage(number);
        const painted = await imagePage.getOperatorList();
        imagePage.cleanup();
        if (painted.fnArray.some((fn) => imageOps.has(fn))) return { fallback: 'image_page', page: number };
      }
      chars += pageChars;
      bad += pageBad;
      const [, y0 = 0, , y1 = 0] = page.view;
      const items = content.items.filter((item): item is typeof item & TextItem => 'str' in item);
      pages.push({ number, height: Math.abs(y1 - y0), lines: toLines(items, Math.min(y0, y1)) });
      page.cleanup();
    }
    if (bad > GARBLED_SHARE_MAX * chars) return { fallback: 'garbled' };
    // No page has any text, yet none is a scan by the rules above (text drawn as outlines, say): let OCR try.
    if (chars === 0) return { fallback: 'no_text' };

    stripMargins(pages);
    const lines = pages.flatMap((page) => page.lines);
    if (lines.length === 0) throw new ProcessingFailure('empty_text', 'The PDF has no text');
    const body = weightedMedian(lines, (line) => line.size);
    const gaps = pages.flatMap((page) => page.lines.slice(1).flatMap((line, at) => {
      const previous = page.lines[at]!;
      const drop = previous.y - line.y;
      return drop > 0 && Math.abs(line.size - body) <= 0.1 * body && Math.abs(previous.size - body) <= 0.1 * body ? [drop / body] : [];
    })).sort((a, b) => a - b);
    const gap = Math.min(gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)]! : LINE_GAP_MAX, LINE_GAP_MAX);
    const sections = pages
      .map((page) => ({ text: pageMarkdown(page.lines, body, gap), locator: { page: page.number } }))
      .filter((section) => section.text.length > 0);
    if (sections.length === 0) throw new ProcessingFailure('empty_text', 'The PDF has no text');
    return { sections };
  } catch (error) {
    if (error instanceof ProcessingFailure) throw error;
    return { fallback: 'unreadable' };
  } finally {
    await Promise.allSettled([pdf.loadingTask.destroy(), withImages?.loadingTask.destroy()]);
  }
}

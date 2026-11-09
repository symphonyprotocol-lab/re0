/**
 * PDFs with a usable text layer, parsed locally (pdf.js through unpdf's
 * serverless build: no canvas, no worker). The whole document is checked
 * first; if any page fails a check, the caller sends the whole file to
 * Firecrawl instead, so one document never mixes two parsers:
 *
 * - unreadable: pdf.js cannot open the file or a page (corrupt, encrypted).
 * - font_failed: a font on the page could not be loaded, so its text is
 *   silently missing (a broken embedded font, or a CJK font whose predefined
 *   CMap is not on disk; see `pdfjsAssets`).
 * - image_page: images cover most of the page and almost no text sits
 *   between the header and footer bands (a scan, stamped or not).
 * - garbled: replacement, private-use and control characters make up too
 *   much of the text (fonts without a usable ToUnicode map).
 * - no_text: nothing is left to index (no text at all, text drawn as
 *   outlines, or only headers and page numbers).
 * - budget: the file has too many pages or took too long to read here.
 *
 * Otherwise each page is rebuilt as Markdown from its text items: lines by
 * baseline, paragraphs by line gaps, headings by font size, and headers,
 * footers and page numbers that repeat at the same place removed. Pages keep
 * their physical numbers; blank pages are dropped after numbering.
 *
 * pdf.js runs on the request's own thread, so the reader yields to the event
 * loop after every page and stops at a time and page budget.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import type { Section } from '@/lib/domain/knowledge';

/** A page with fewer non-whitespace characters than this outside its header and footer bands ... */
const IMAGE_PAGE_MAX_CHARS = 30;
/** ... whose images cover at least this share of its area is a scan. */
const IMAGE_COVERAGE_MIN = 0.5;
/** Image coverage is measured on a grid of this many cells per side. */
const COVERAGE_GRID = 24;
/** Above this share of bad characters (U+FFFD, private use, controls) the text layer is unusable. */
const GARBLED_SHARE_MAX = 0.05;
/** A single page is judged garbled on its own only with at least this many characters. */
const GARBLED_PAGE_MIN_CHARS = 50;
/** Local reading stops after this long; Firecrawl gets the rest of the caller's deadline. */
export const LOCAL_BUDGET_MS = 60_000;
/** Longer documents go straight to Firecrawl. */
const LOCAL_MAX_PAGES = 1_000;
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
/** A bare number at an edge is a page number only when this many pages carry one there, rising with the page. */
const PAGE_NUMBER_MIN_PAGES = 2;

export type PdfFallback = 'unreadable' | 'font_failed' | 'image_page' | 'garbled' | 'no_text' | 'budget';
export type PdfTextLayer = { sections: Section[] } | { fallback: PdfFallback; page?: number };

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  dir?: string;
}

interface Line {
  text: string;
  /** Baseline, PDF units from the bottom of the page. */
  y: number;
  x: number;
  /** Character-weighted font size. */
  size: number;
  chars: number;
}

interface PageLines {
  number: number;
  height: number;
  lines: Line[];
}

const BAD_CHARACTER = /[�-\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F­]/g;
const CJK = /[⺀-鿿가-힯豈-﫿＀-￯　-〿]/u;
const BULLET = /^[•●▪◦‣∙○■□◆◇➢►]\s*/u;
const NUMBERED = /^(?:\d{1,3}|[a-zA-Z])[.)]\s|^[(（]\d{1,3}[)）]/u;
/** A page number that says so: "Page 3", "p. 3", "3 of 12", "3 / 12", "- 3 -", "第 3 页". */
const MARKED_PAGE_NUMBER = /^(?:(?:page|p\.)\s*\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?|\d{1,4}\s*(?:of|\/)\s*\d{1,4}|[-–—]\s*\d{1,4}\s*[-–—])$|^第\s*\d{1,4}\s*页(?:\s*[,，/]?\s*共\s*\d{1,4}\s*页)?$/iu;
/** A number alone, arabic or a well-formed roman numeral. */
const BARE_NUMBER = /^(?:\d{1,4}|(?=[mdclxvi])m{0,3}(?:c[md]|d?c{0,3})(?:x[cl]|l?x{0,3})(?:i[xv]|v?i{0,3}))$/iu;
/** Markdown a body line must not start: an ATX heading, a code fence, a block quote. */
const MARKDOWN_PREFIX = /^(#|`{3}|~{3}|>)/;

const nonWhitespace = (text: string): number => text.replace(/\s+/g, '').length;
const badCharacters = (text: string): number => text.match(BAD_CHARACTER)?.length ?? 0;
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * pdf.js's predefined CMaps (for non-embedded CJK fonts) and standard font
 * data, from the installed `pdfjs-dist` at the version unpdf bundles. unpdf
 * finds them only through `import.meta.resolve`, which the Next server bundle
 * does not keep, so they are passed explicitly; `next.config.mjs` traces the
 * folders into the functions that parse documents. Without them, such fonts
 * fail to load and the file goes to Firecrawl as `font_failed`.
 */
let assets: { cMapUrl?: string; cMapPacked?: boolean; standardFontDataUrl?: string } | undefined;
function pdfjsAssets(): NonNullable<typeof assets> {
  if (assets) return assets;
  const root = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');
  const cmaps = path.join(root, 'cmaps');
  const fonts = path.join(root, 'standard_fonts');
  if (existsSync(cmaps) && existsSync(fonts)) {
    assets = { cMapUrl: `${cmaps}${path.sep}`, cMapPacked: true, standardFontDataUrl: `${fonts}${path.sep}` };
  } else {
    console.warn('pdfjs-dist cmaps or standard_fonts are missing; PDFs with predefined CMap fonts will go to Firecrawl');
    assets = {};
  }
  return assets;
}

/**
 * Text items grouped into lines: items on the current line's baseline join
 * it even when drawn out of order, and each line reads left to right. Only
 * the current line is compared, so columns drawn one after the other stay
 * apart.
 */
function toLines(items: readonly TextItem[], bottom: number): Line[] {
  const groups: { y: number; size: number; rtl: boolean; items: { str: string; x: number; width: number; size: number }[] }[] = [];
  for (const item of items) {
    if (!item.str) continue;
    const [, , c = 0, d = 0, x = 0, baseline = 0] = item.transform;
    const y = baseline - bottom;
    const size = Math.hypot(c, d) || item.height || 1;
    const current = groups.at(-1);
    if (current && Math.abs(y - current.y) <= LINE_Y_TOLERANCE * Math.max(size, current.size)) {
      current.items.push({ str: item.str, x, width: item.width, size });
      current.rtl ||= item.dir === 'rtl';
    } else {
      groups.push({ y, size, rtl: item.dir === 'rtl', items: [{ str: item.str, x, width: item.width, size }] });
    }
  }
  const lines: Line[] = [];
  for (const group of groups) {
    // Right-to-left text comes in reading order already; sorting it by x would reverse it.
    const sorted = group.rtl ? group.items : [...group.items].sort((a, b) => a.x - b.x);
    let text = '';
    let end = -Infinity;
    let weighted = 0;
    let chars = 0;
    for (const item of sorted) {
      const before = text.at(-1) ?? '';
      const after = item.str[0] ?? '';
      if (text && item.x - end > WORD_GAP * item.size && !/\s/.test(before) && !/\s/.test(after) && !(CJK.test(before) && CJK.test(after))) {
        text += ' ';
      }
      text += item.str;
      end = Math.max(end, item.x + item.width);
      const itemChars = nonWhitespace(item.str);
      weighted += item.size * itemChars;
      chars += itemChars;
    }
    text = text.replace(CONTROL, '').replace(/\s+/g, ' ').trim();
    if (text) lines.push({ text, y: group.y, x: Math.min(...sorted.map((item) => item.x)), size: chars > 0 ? weighted / chars : group.size, chars });
  }
  return lines;
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

/** Non-whitespace characters on lines between the header and footer bands. */
function bodyChars(page: PageLines): number {
  return page.lines
    .filter((line) => line.y > page.height * EDGE_BAND && line.y < page.height * (1 - EDGE_BAND))
    .reduce((sum, line) => sum + line.chars, 0);
}

/** The value of a bare page number (arabic or roman), or NaN. */
function numberValue(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  const digits: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const values = [...text.toLowerCase()].map((letter) => digits[letter] ?? NaN);
  return values.reduce((sum, value, at) => sum + (value < (values[at + 1] ?? 0) ? -value : value), 0);
}

/**
 * Header, footer and page-number lines, among the lines nearest each edge.
 * A line goes when it says it is a page number ("Page 3 of 12"), when the
 * same text (digits aside) sits at the same place on most pages, or when it
 * is a bare number and other pages carry bare numbers at the same place that
 * rise with the page. A lone number on a one-page invoice stays.
 */
function stripMargins(pages: PageLines[]): void {
  const edgeLines = (page: PageLines): Line[] => {
    const byHeight = [...page.lines].sort((a, b) => b.y - a.y);
    const top = byHeight.slice(0, EDGE_LINES).filter((line) => line.y >= page.height * (1 - EDGE_BAND));
    const bottom = byHeight.slice(-EDGE_LINES).filter((line) => line.y <= page.height * EDGE_BAND);
    return [...new Set([...top, ...bottom])];
  };
  const place = (line: Line): string => String(Math.round(line.y));
  const key = (line: Line): string => `${place(line)}|${line.text.toLowerCase().replace(/\d+/g, '#')}`;
  const seenOn = new Map<string, Set<number>>();
  const numbersAt = new Map<string, { page: number; value: number }[]>();
  for (const page of pages) {
    for (const line of edgeLines(page)) {
      if (BARE_NUMBER.test(line.text)) {
        numbersAt.set(place(line), [...numbersAt.get(place(line)) ?? [], { page: page.number, value: numberValue(line.text) }]);
        continue;
      }
      const pagesWith = seenOn.get(key(line)) ?? new Set<number>();
      pagesWith.add(page.number);
      seenOn.set(key(line), pagesWith);
    }
  }
  const pageNumberPlaces = new Set([...numbersAt].flatMap(([at, numbers]) =>
    numbers.length >= PAGE_NUMBER_MIN_PAGES && numbers.every((number, index) => index === 0 || number.value > numbers[index - 1]!.value) ? [at] : []));
  const repeats = pages.length >= REPEAT_MIN_PAGES;
  for (const page of pages) {
    const margins = new Set(edgeLines(page).filter((line) => BARE_NUMBER.test(line.text)
      ? pageNumberPlaces.has(place(line))
      : MARKED_PAGE_NUMBER.test(line.text) || (repeats && seenOn.get(key(line))!.size >= REPEAT_SHARE * pages.length)));
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
    const bullet = level === 0 && BULLET.test(line.text);
    const listItem = bullet || (level === 0 && NUMBERED.test(line.text));
    // A bullet glyph becomes our list marker; any other text that reads as Markdown is escaped.
    const text = bullet ? line.text.replace(BULLET, '- ') : line.text.replace(MARKDOWN_PREFIX, '\\$1');
    const continues = previous !== undefined && blocks.length > 0 && level === previousLevel && !listItem
      && drop > 0 && drop <= PARAGRAPH_GAP_RATIO * gap * Math.max(line.size, previous.size);
    if (continues) {
      const block = blocks.at(-1)!;
      block.text = joinLines(block.text, line.text);
    } else {
      blocks.push({ text: level > 0 ? `${'#'.repeat(level)} ${line.text}` : text, listItem });
    }
    previous = line;
    previousLevel = level;
  }
  // Consecutive list items stay one list; every other block is its own paragraph.
  return blocks.map((block, at) => (at === 0 ? '' : block.listItem && blocks[at - 1]!.listItem ? '\n' : '\n\n') + block.text).join('');
}

type Matrix = [number, number, number, number, number, number];
const multiply = (m: Matrix, n: readonly number[]): Matrix => {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = n;
  return [a * m[0] + b * m[2], a * m[1] + b * m[3], c * m[0] + d * m[2], c * m[1] + d * m[3], e * m[0] + f * m[2] + m[4], e * m[1] + f * m[3] + m[5]];
};

/**
 * The share of the page `view` that painted images cover: each image is the
 * unit square under the current transform, tracked through save, restore,
 * transform and form XObjects, and their union is measured on a grid.
 */
function imageCoverage(
  operators: { fnArray: number[]; argsArray: unknown[][] },
  view: readonly number[],
  OPS: Record<string, number>,
): number {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = view;
  const left = Math.min(x0, x1);
  const bottom = Math.min(y0, y1);
  const width = Math.abs(x1 - x0) || 1;
  const height = Math.abs(y1 - y0) || 1;
  const covered = new Set<number>();
  const paint = (m: Matrix): void => {
    const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
    const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
    for (let row = 0; row < COVERAGE_GRID; row += 1) {
      const y = bottom + ((row + 0.5) / COVERAGE_GRID) * height;
      if (y < Math.min(...ys) || y > Math.max(...ys)) continue;
      for (let column = 0; column < COVERAGE_GRID; column += 1) {
        const x = left + ((column + 0.5) / COVERAGE_GRID) * width;
        if (x >= Math.min(...xs) && x <= Math.max(...xs)) covered.add(row * COVERAGE_GRID + column);
      }
    }
  };
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  operators.fnArray.forEach((fn, at) => {
    const args = operators.argsArray[at] ?? [];
    switch (fn) {
      case OPS.save: case OPS.beginGroup: case OPS.beginAnnotation:
        stack.push(ctm);
        break;
      case OPS.restore: case OPS.endGroup: case OPS.endAnnotation: case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        ctm = multiply(ctm, args as number[]);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args[0]) || ArrayBuffer.isView(args[0])) ctm = multiply(ctm, Array.from(args[0] as ArrayLike<number>));
        break;
      case OPS.paintImageXObject: case OPS.paintInlineImageXObject: case OPS.paintImageMaskXObject:
        paint(ctm);
        break;
      case OPS.paintImageXObjectRepeat: {
        const [, scaleX = 1, scaleY = 1, positions = []] = args as [unknown, number, number, ArrayLike<number>];
        for (let i = 0; i + 1 < positions.length; i += 2) paint(multiply(ctm, [scaleX, 0, 0, scaleY, positions[i]!, positions[i + 1]!]));
        break;
      }
      case OPS.paintImageMaskXObjectRepeat: {
        const [, a = 1, b = 0, c = 0, d = 1, positions = []] = args as [unknown, number, number, number, number, ArrayLike<number>];
        for (let i = 0; i + 1 < positions.length; i += 2) paint(multiply(ctm, [a, b, c, d, positions[i]!, positions[i + 1]!]));
        break;
      }
      case OPS.paintInlineImageXObjectGroup:
        for (const entry of (args[1] ?? []) as { transform?: number[] }[]) paint(multiply(ctm, entry.transform ?? []));
        break;
      case OPS.paintImageMaskXObjectGroup:
        for (const entry of (args[0] ?? []) as { transform?: number[] }[]) paint(multiply(ctm, entry.transform ?? []));
        break;
      default:
    }
  });
  return covered.size / (COVERAGE_GRID * COVERAGE_GRID);
}

/**
 * Reads the text layer, or says why Firecrawl should parse the file instead.
 * `deadline` (epoch ms) caps local reading together with `LOCAL_BUDGET_MS`.
 */
export async function pdfTextLayer(bytes: Uint8Array, { deadline = Infinity }: { deadline?: number } = {}): Promise<PdfTextLayer> {
  const stopAt = Math.min(deadline, Date.now() + LOCAL_BUDGET_MS);
  const { OPS } = await getResolvedPDFJS();
  /*
   * pdf.js detaches the buffer it parses, and Firecrawl may still need the
   * bytes, so each document gets a copy. This one skips images (no decoding)
   * and is used for text and fonts; `withImages` opens only for pages with
   * little body text, to measure how much of them images cover.
   */
  const open = (options: { maxImageSize?: number }) =>
    getDocumentProxy(new Uint8Array(bytes), { verbosity: 0, disableFontFace: true, ...pdfjsAssets(), ...options });
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await open({ maxImageSize: 1 });
  } catch {
    return { fallback: 'unreadable' };
  }
  let withImages: typeof pdf | undefined;
  try {
    if (pdf.numPages > LOCAL_MAX_PAGES) return { fallback: 'budget' };
    const pages: PageLines[] = [];
    let chars = 0;
    let bad = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      if (Date.now() > stopAt) return { fallback: 'budget', page: number };
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
      chars += pageChars;
      bad += pageBad;
      const [, y0 = 0, , y1 = 0] = page.view;
      const items = content.items.filter((item): item is typeof item & TextItem => 'str' in item);
      const lines: PageLines = { number, height: Math.abs(y1 - y0), lines: toLines(items, Math.min(y0, y1)) };
      pages.push(lines);
      page.cleanup();
      /*
       * A stamp or Bates number in the margin does not make a scan readable:
       * only text between the bands counts. A logo or a figure leaves most
       * of the page free, so it does not count as a scan either.
       */
      if (bodyChars(lines) < IMAGE_PAGE_MAX_CHARS) {
        withImages ??= await open({});
        const imagePage = await withImages.getPage(number);
        const painted = await imagePage.getOperatorList();
        const coverage = imageCoverage(painted, imagePage.view, OPS);
        imagePage.cleanup();
        if (coverage >= IMAGE_COVERAGE_MIN) return { fallback: 'image_page', page: number };
      }
      await yieldToEventLoop();
    }
    if (bad > GARBLED_SHARE_MAX * chars) return { fallback: 'garbled' };
    // No page has any text, yet none is a scan by the rules above (text drawn as outlines, say): let OCR try.
    if (chars === 0) return { fallback: 'no_text' };

    stripMargins(pages);
    const lines = pages.flatMap((page) => page.lines);
    // Only headers, footers and page numbers: whatever the body is, it is not in the text layer.
    if (lines.length === 0) return { fallback: 'no_text' };
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
    if (sections.length === 0) return { fallback: 'no_text' };
    return { sections };
  } catch {
    return { fallback: 'unreadable' };
  } finally {
    await Promise.allSettled([pdf.loadingTask.destroy(), withImages?.loadingTask.destroy()]);
  }
}

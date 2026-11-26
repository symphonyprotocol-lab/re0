/**
 * What may be published as an original, and the checks a file passes first
 * (docs/design/agent-workspace-p4.md §2.4). Pure: the bytes come in, a verdict
 * goes out. The type is the extension's, never the client's word, and only
 * these extensions: text and data, PDF, the macro-free Office formats, and
 * four image formats. Everything that can run, render as a page or hide
 * other files (HTML, SVG, scripts, executables, archives, audio, video, code)
 * stays private.
 */
import { inflateSync } from 'node:zlib';
import JSZip from 'jszip';

export type PublishCategory = 'text' | 'pdf' | 'office' | 'image';

/** The published extensions and the type each is served as. */
export const PUBLISH_TYPES: Readonly<Record<string, { category: PublishCategory; mediaType: string }>> = {
  txt: { category: 'text', mediaType: 'text/plain' },
  md: { category: 'text', mediaType: 'text/markdown' },
  csv: { category: 'text', mediaType: 'text/csv' },
  tsv: { category: 'text', mediaType: 'text/tab-separated-values' },
  json: { category: 'text', mediaType: 'application/json' },
  yaml: { category: 'text', mediaType: 'application/yaml' },
  yml: { category: 'text', mediaType: 'application/yaml' },
  /* Served as an attachment with nosniff and a sandbox: a browser never renders it as a page. */
  xml: { category: 'text', mediaType: 'application/xml' },
  log: { category: 'text', mediaType: 'text/plain' },
  pdf: { category: 'pdf', mediaType: 'application/pdf' },
  docx: { category: 'office', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { category: 'office', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { category: 'office', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  png: { category: 'image', mediaType: 'image/png' },
  jpg: { category: 'image', mediaType: 'image/jpeg' },
  jpeg: { category: 'image', mediaType: 'image/jpeg' },
  gif: { category: 'image', mediaType: 'image/gif' },
  webp: { category: 'image', mediaType: 'image/webp' },
};

export function publishTypeOf(path: string): { category: PublishCategory; mediaType: string; extension: string } | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = name.slice(dot + 1).toLowerCase();
  const type = PUBLISH_TYPES[extension];
  return type ? { ...type, extension } : null;
}

/** One check as the dialog lists it: what was looked at, whether it passed, and (when not) what was found. */
export interface PublishCheck {
  key: 'type' | 'size' | 'account' | 'count' | 'blocked' | 'active_content' | 'image' | 'secrets' | 'text';
  ok: boolean;
  detail?: string;
}

/* ------------------------------------------------------------------ PDF */

/** Names whose presence makes a PDF refuse: scripts, launch actions, attached files, rich media and XFA forms. */
const PDF_ACTIVE = new Set(['javascript', 'js', 'launch', 'embeddedfile', 'embeddedfiles', 'richmedia', 'xfa']);

/** A PDF name token's text, `#xx` escapes undone (so `/J#61vaScript` is caught), lowered. */
function pdfNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/\/([^\s/[\]<>(){}%]+)/g)) {
    const raw = match[1]!;
    names.add(raw.replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).toLowerCase());
  }
  return names;
}

/**
 * The active content a PDF holds, or null when it holds none: names in the
 * file as written, and in every Flate-compressed stream (object streams can
 * hide dictionaries), inflated up to `inflateMax` bytes in all. A stream that
 * does not inflate is skipped; one past the budget makes the whole file fail,
 * since what it hides cannot be told.
 */
export function pdfActiveContent(bytes: Uint8Array, inflateMax: number): string | null {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return 'not_a_pdf';
  const hit = (text: string) => [...pdfNames(text)].find((name) => PDF_ACTIVE.has(name)) ?? null;
  const direct = hit(buffer.toString('latin1'));
  if (direct) return direct;
  let budget = inflateMax;
  let at = 0;
  for (;;) {
    const start = buffer.indexOf('stream', at, 'latin1');
    if (start < 0) break;
    let body = start + 'stream'.length;
    if (buffer[body] === 0x0d) body += 1;
    if (buffer[body] === 0x0a) body += 1;
    const end = buffer.indexOf('endstream', body, 'latin1');
    if (end < 0) break;
    at = end + 'endstream'.length;
    /* "endstream" itself contains "stream": skip a match inside it. */
    if (start >= 3 && buffer.subarray(start - 3, start).toString('latin1') === 'end') continue;
    try {
      const inflated = inflateSync(buffer.subarray(body, end), { maxOutputLength: Math.max(1, budget) });
      budget -= inflated.length;
      const found = hit(inflated.toString('latin1'));
      if (found) return found;
    } catch (error) {
      if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') return 'too_large_to_check';
      /* Not Flate, or damaged: nothing more to read in it. */
    }
    if (budget <= 0) return 'too_large_to_check';
  }
  return null;
}

/* ------------------------------------------------------------------ Office */

/** Relationship types that, pointing outside the package, fetch something when the file opens. */
const EXTERNAL_TYPES = /\/(attachedTemplate|oleObject|frame|subDocument|control)$/i;
/** The most an Office part may hold for the check to read it (a part larger than this fails the check). */
const OFFICE_PART_MAX = 8 * 1024 * 1024;

export interface OfficeVerdict {
  /** What makes it refuse, or null. */
  active: string | null;
  /** The text its parts hold, tags stripped, for the secret scan and the preview (at most `textMax` characters). */
  text: string;
}

/**
 * A docx, xlsx or pptx: a ZIP with `[Content_Types].xml`, and none of macros
 * (`vbaProject.bin`, a macro-enabled content type), ActiveX controls,
 * embedded OLE objects, or relationships that load from outside the package.
 */
export async function officeVerdict(bytes: Uint8Array, textMax: number): Promise<OfficeVerdict> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { active: 'not_a_zip', text: '' };
  }
  const names = Object.keys(zip.files);
  if (!zip.file('[Content_Types].xml')) return { active: 'not_office', text: '' };
  for (const name of names) {
    if (/(^|\/)vbaProject\.bin$/i.test(name) || /(^|\/)vbaData\.xml$/i.test(name)) return { active: 'macros', text: '' };
    if (/(^|\/)activeX\//i.test(name)) return { active: 'activex', text: '' };
    if (/(^|\/)embeddings\/[^/]*\.(bin|ole)$/i.test(name)) return { active: 'ole_object', text: '' };
  }
  const read = async (name: string): Promise<string | null> => {
    const file = zip.file(name);
    if (!file) return null;
    const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof size === 'number' && size > OFFICE_PART_MAX) throw new Error('part_too_large');
    const text = await file.async('string');
    if (text.length > OFFICE_PART_MAX) throw new Error('part_too_large');
    return text;
  };
  try {
    const types = (await read('[Content_Types].xml')) ?? '';
    if (/macroEnabled|vbaProject/i.test(types)) return { active: 'macros', text: '' };
    for (const name of names.filter((name) => name.endsWith('.rels'))) {
      const rels = (await read(name)) ?? '';
      for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
        const tag = match[0];
        if (/TargetMode\s*=\s*"External"/i.test(tag) && EXTERNAL_TYPES.test(/Type\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '')) return { active: 'external_reference', text: '' };
      }
    }
    let text = '';
    for (const name of names.filter((name) => /^(word\/document|word\/footnotes|word\/endnotes|xl\/sharedStrings|xl\/worksheets\/sheet\d+|ppt\/slides\/slide\d+|ppt\/notesSlides\/notesSlide\d+)\.xml$/i.test(name)).sort()) {
      if (text.length >= textMax) break;
      const xml = (await read(name)) ?? '';
      text += `${xml.replace(/<\/(w:p|a:p|row)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')}\n`;
    }
    return { active: null, text: text.slice(0, textMax) };
  } catch {
    return { active: 'too_large_to_check', text: '' };
  }
}

/* ------------------------------------------------------------------ text */

/** A strict UTF-8 decode, or null for anything that is not text. */
export function strictText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

/** A preview: the first `lines` lines, cut to at most `bytes` bytes on a character boundary. */
export function previewOf(text: string, lines: number, bytes: number): string {
  const head = text.split('\n').slice(0, lines).join('\n');
  const encoded = Buffer.from(head, 'utf8');
  if (encoded.length <= bytes) return head;
  return new TextDecoder().decode(encoded.subarray(0, bytes)).replace(/\uFFFD+$/, '');
}

/** A public page's title: plain text, one line, at most `max` characters; null when nothing is left. */
export function cleanTitle(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const title = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return Array.from(title).slice(0, max).join('');
}

/** `Content-Disposition` for a download: an ASCII fallback and the UTF-8 name (RFC 6266 / 8187, with `'()*!` encoded). */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const ext = encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${ext}`;
}

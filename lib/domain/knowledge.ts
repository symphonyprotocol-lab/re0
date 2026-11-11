/**
 * Knowledge as data: the six kinds and what each may be (2.1), what
 * processing reserves and charges (2.3, 8.2), the processing record, and how
 * extracted text becomes retrievable passages.
 *
 * The chunker is the old ingestion one (block-aware, heading-tracking, with a
 * small overlap), carrying a locator -- page, heading, time, file and line,
 * URL -- per passage so a citation can say where it came from.
 */
import {
  AUDIO_EXTENSIONS,
  AUDIO_MAX_BYTES,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MAX_BYTES,
  KNOWLEDGE_FOLDER_NAME_MAX,
  KNOWLEDGE_TITLE_MAX,
  KNOWLEDGE_INITIAL_HOLD,
  M4A_MAX_BYTES,
  TEXT_SOURCE_LIMITS,
} from '@/lib/constants';
import type { Locator } from '@/lib/domain/answer';

export const KNOWLEDGE_KIND_LIST = ['document', 'audio', 'github', 'page', 'site', 'text'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KIND_LIST)[number];
/** New-source UI choices. Historical pasted sources remain readable and reprocessable. */
export const ADD_KNOWLEDGE_KINDS = ['document', 'audio', 'github', 'page', 'site'] as const;
export type AddKnowledgeKind = (typeof ADD_KNOWLEDGE_KINDS)[number];
export type KnowledgeStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type DocumentFormat = (typeof DOCUMENT_EXTENSIONS)[number];
export type AudioFormat = (typeof AUDIO_EXTENSIONS)[number];

export function isKnowledgeKind(value: unknown): value is KnowledgeKind {
  return typeof value === 'string' && (KNOWLEDGE_KIND_LIST as readonly string[]).includes(value);
}

/** One line of the processing record (knowledge preview, "处理记录"). */
export interface KnowledgeActivity {
  at: string;
  code:
    | 'added'
    | 'processing'
    | 'fetched'
    | 'transcribed'
    | 'parsed'
    | 'chunked'
    | 'ready'
    | 'failed'
    | 'refresh'
    | 'interrupted'
    | 'settled'
    | 'reserved'
    | 'provider_usage'
    | 'refunded'
    | 'paused'
    | 'enabled'
    | 'renamed'
    | 'moved'
    | 'trashed'
    | 'restored';
  /** Numbers and short strings the label is filled with: pages, chars, chunks, credits, reason, folder. */
  detail?: Record<string, string | number>;
}

export function activity(code: KnowledgeActivity['code'], detail?: KnowledgeActivity['detail'], now = new Date()): KnowledgeActivity {
  return detail ? { at: now.toISOString(), code, detail } : { at: now.toISOString(), code };
}

/**
 * One part of a multi-part source, as a slice of the row's `content`: a
 * website's page, a repository's file, an audio transcript's segment. The
 * preview lists them; the text itself is stored once.
 */
export interface KnowledgeChild {
  /** A page's title or a file's path; empty for a transcript segment. */
  label: string;
  url?: string;
  path?: string;
  /** Seconds into the audio. */
  time?: number;
  end?: number;
  offset: number;
  length: number;
}

function extension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}

export function documentFormat(fileName: string): DocumentFormat | null {
  const ext = extension(fileName);
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext) ? (ext as DocumentFormat) : null;
}

export function audioFormat(fileName: string): AudioFormat | null {
  const ext = extension(fileName);
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext) ? (ext as AudioFormat) : null;
}

export const DOCUMENT_CONTENT_TYPES: Record<DocumentFormat, string[]> = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
  txt: ['text/plain'],
};

export const AUDIO_CONTENT_TYPES: Record<AudioFormat, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
};

export function validDocument(fileName: string, size: number): boolean {
  return documentFormat(fileName) !== null && size > 0 && size <= DOCUMENT_MAX_BYTES;
}

/** The largest upload of this format: M4A goes to the transcription endpoint whole. */
export function audioMaxBytes(format: AudioFormat): number {
  return format === 'm4a' ? M4A_MAX_BYTES : AUDIO_MAX_BYTES;
}

/** Why an audio file cannot be added, or null: the wrong kind or size, or an M4A too large to transcribe in one call. */
export function audioProblem(fileName: string, size: number): 'invalid_audio' | 'm4a_too_long' | null {
  const format = audioFormat(fileName);
  if (!format || !(size > 0) || size > AUDIO_MAX_BYTES) return 'invalid_audio';
  return size > audioMaxBytes(format) ? 'm4a_too_long' : null;
}

export function validAudio(fileName: string, size: number): boolean {
  return audioProblem(fileName, size) === null;
}

/** A refundable balance check, not a processing fee or a quote. Actual supplier costs grow this hold. */
export function holdFor(_kind: KnowledgeKind, _measure?: string | number): number {
  return KNOWLEDGE_INITIAL_HOLD;
}

export function validText(title: string, content: string): boolean {
  const t = title.trim();
  const c = content.trim();
  return t.length > 0 && Array.from(t).length <= TEXT_SOURCE_LIMITS.title && c.length > 0 && c.length <= TEXT_SOURCE_LIMITS.content;
}

/** A display name: 1–200 characters after trimming (prototype "修改名称"). */
export function cleanTitle(raw: unknown): string | null {
  const title = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  return title && Array.from(title).length <= KNOWLEDGE_TITLE_MAX ? title : null;
}

/** A folder name: 1–40 characters, inner whitespace collapsed (prototype `validFolderName`). */
export function cleanFolderName(raw: unknown): string | null {
  const name = typeof raw === 'string' ? raw.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  return name && Array.from(name).length <= KNOWLEDGE_FOLDER_NAME_MAX ? name : null;
}

/**
 * A stretch of extracted text with its place in the source: one PDF page, a
 * whole Markdown file, one web page, a repository file, a transcript segment.
 * `child` makes it a part the preview lists (a page, a file, a segment).
 */
export interface Section {
  text: string;
  locator: Locator;
  /** Repository files are cut by lines so passages can cite a line number. */
  byLines?: boolean;
  child?: Omit<KnowledgeChild, 'offset' | 'length'>;
}

export interface DraftChunk {
  ordinal: number;
  content: string;
  locator: Locator;
}

/* ------------------------------------------------------------------ chunker */

export const CHUNK_TARGET_TOKENS = 400;
export const CHUNK_MAX_TOKENS = 800;
export const CHUNK_OVERLAP_TOKENS = 40;
export const MAX_CHUNKS = 20_000;

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;

/** Rough token count: CJK characters count one each, everything else four characters a token. */
export function estimateTokens(value: string): number {
  let dense = 0;
  let total = 0;
  for (const character of value) {
    total += 1;
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x2e80 && code <= 0xd7ff) || (code >= 0xf900 && code <= 0xfaff)) dense += 1;
  }
  return Math.ceil(Math.max(0, total - dense) / 4) + dense;
}

interface Block {
  text: string;
  heading: string | null;
  level: number;
}

function splitBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let fence: string | null = null;
  const endParagraph = (): void => {
    const text = paragraph.join('\n').trim();
    paragraph = [];
    if (text.length > 0) blocks.push({ text, heading: null, level: 0 });
  };
  for (const line of body.split('\n')) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? '```').slice(0, 3);
      if (fence === null) {
        endParagraph();
        fence = marker;
        paragraph.push(line);
        continue;
      }
      if (line.trimStart().startsWith(fence)) {
        paragraph.push(line);
        blocks.push({ text: paragraph.join('\n'), heading: null, level: 0 });
        paragraph = [];
        fence = null;
        continue;
      }
    }
    if (fence !== null) {
      paragraph.push(line);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({ text: line.trim(), heading: (heading[2] ?? '').trim(), level: (heading[1] ?? '#').length });
      continue;
    }
    if (line.trim().length === 0) {
      endParagraph();
      continue;
    }
    paragraph.push(line);
  }
  /* An unterminated fence is still content. */
  endParagraph();
  return blocks;
}

/** A block too large for one passage, cut on line boundaries, then hard-cut. */
function fitBlock(text: string): string[] {
  if (estimateTokens(text) <= CHUNK_MAX_TOKENS) return [text];
  const pieces: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  const flush = (): void => {
    if (current.length > 0) pieces.push(current.join('\n'));
    current = [];
    tokens = 0;
  };
  for (const line of text.split('\n')) {
    const lineTokens = estimateTokens(line);
    if (lineTokens > CHUNK_MAX_TOKENS) {
      flush();
      /* A single giant line (common in PDF text): cut by characters. */
      const step = Math.max(200, Math.floor((line.length * CHUNK_TARGET_TOKENS) / lineTokens));
      for (let at = 0; at < line.length; at += step) pieces.push(line.slice(at, at + step));
      continue;
    }
    if (tokens + lineTokens > CHUNK_MAX_TOKENS) flush();
    current.push(line);
    tokens += lineTokens;
  }
  flush();
  return pieces;
}

/** One section's passages, each tagged with the heading path it sits under. */
function chunkSection(section: Section, startOrdinal: number): DraftChunk[] {
  const chunks: DraftChunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let headings: string[] = [];
  let bufferHeadings: string[] = [];

  const flush = (): void => {
    const content = buffer.join('\n\n').trim();
    buffer = [];
    bufferTokens = 0;
    if (!content) return;
    const heading = bufferHeadings.filter(Boolean).join(' › ');
    chunks.push({
      ordinal: startOrdinal + chunks.length,
      content,
      locator: heading ? { ...section.locator, heading } : { ...section.locator },
    });
  };

  for (const block of splitBlocks(section.text)) {
    if (block.heading) {
      flush();
      headings = headings.slice(0, block.level - 1);
      headings[block.level - 1] = block.heading;
      bufferHeadings = [...headings];
    }
    if (buffer.length === 0) bufferHeadings = [...headings];
    for (const piece of fitBlock(block.text)) {
      const tokens = estimateTokens(piece);
      if (bufferTokens > 0 && bufferTokens + tokens > CHUNK_TARGET_TOKENS) {
        const tail = buffer.at(-1);
        flush();
        bufferHeadings = [...headings];
        /* A short last paragraph is repeated at the head of the next passage, so a split sentence keeps its context. */
        if (tail && estimateTokens(tail) <= CHUNK_OVERLAP_TOKENS) {
          buffer.push(tail);
          bufferTokens += estimateTokens(tail);
        }
      }
      buffer.push(piece);
      bufferTokens += tokens;
    }
  }
  flush();
  return chunks;
}

export function chunkSections(sections: readonly Section[]): DraftChunk[] {
  const chunks: DraftChunk[] = [];
  for (const section of sections) {
    chunks.push(
      ...(section.byLines ? chunkLines(section.locator.path ?? '', section.text, chunks.length) : chunkSection(section, chunks.length)),
    );
    if (chunks.length >= MAX_CHUNKS) break;
  }
  return chunks.slice(0, MAX_CHUNKS);
}

/** A section's text as stored: trimmed, except a file cut by lines, whose line numbers must hold. */
function storedText(section: Section): string {
  return section.byLines ? section.text.replace(/\s+$/, '') : section.text.trim();
}

/** The extracted text a knowledge row keeps for preview and for the price: sections joined. */
export function joinedContent(sections: readonly Section[]): string {
  return assemble(sections).content;
}

/** `content` and, for sections that are parts, where each sits in it. */
export function assemble(sections: readonly Section[]): { content: string; children: KnowledgeChild[] } {
  let content = '';
  const children: KnowledgeChild[] = [];
  for (const section of sections) {
    const text = storedText(section);
    if (!text) continue;
    if (content) content += '\n\n';
    if (section.child) children.push({ ...section.child, offset: content.length, length: text.length });
    content += text;
  }
  return { content, children };
}

/**
 * A repository file as passages of consecutive lines, each citing the file
 * and the line it starts on (2.1: "引用显示文件路径与行号"). Markdown keeps
 * its heading path too.
 */
export function chunkLines(path: string, text: string, startOrdinal = 0): DraftChunk[] {
  const lines = text.split('\n');
  const chunks: DraftChunk[] = [];
  let buffer: string[] = [];
  let tokens = 0;
  let first = 1;
  const markdown = /\.(md|mdx|markdown|txt|rst)$/i.test(path);
  const headings: string[] = [];
  let bufferHeading = '';
  const flush = (): void => {
    const content = buffer.join('\n').trim();
    if (content) {
      const locator: Locator = { path, line: first };
      if (bufferHeading) locator.heading = bufferHeading;
      chunks.push({ ordinal: startOrdinal + chunks.length, content, locator });
    }
    buffer = [];
    tokens = 0;
  };
  lines.forEach((line, index) => {
    const heading = markdown ? HEADING.exec(line) : null;
    if (heading) {
      /* A new section starts a new passage, as in the prose chunker, so it cites its own line. */
      flush();
      const level = (heading[1] ?? '#').length;
      headings.length = level - 1;
      headings[level - 1] = (heading[2] ?? '').trim();
    }
    const lineTokens = estimateTokens(line);
    if (tokens > 0 && tokens + lineTokens > CHUNK_TARGET_TOKENS) flush();
    if (buffer.length === 0) {
      first = index + 1;
      bufferHeading = headings.filter(Boolean).join(' › ');
    }
    /* One enormous line (minified code): cut it, it still starts on this line. */
    if (lineTokens > CHUNK_MAX_TOKENS) {
      for (const piece of fitBlock(line)) {
        buffer.push(piece);
        first = index + 1;
        flush();
      }
      return;
    }
    buffer.push(line);
    tokens += lineTokens;
  });
  flush();
  return chunks;
}

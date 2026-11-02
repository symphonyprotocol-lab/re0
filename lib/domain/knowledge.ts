/**
 * Knowledge as data: what may be added in step 1, what processing reserves,
 * the processing record, and how extracted text becomes retrievable passages.
 *
 * The chunker is the old ingestion one (block-aware, heading-tracking, with a
 * small overlap), now carrying a locator -- page, heading -- per passage so a
 * citation can say where it came from.
 */
import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MAX_BYTES,
  KNOWLEDGE_HOLD,
  TEXT_SOURCE_LIMITS,
} from '@/lib/constants';
import { processingCost } from '@/lib/domain/credits';
import type { Locator } from '@/lib/domain/answer';

export type KnowledgeKind = 'document' | 'audio' | 'github' | 'page' | 'site' | 'text';
export type KnowledgeStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type DocumentFormat = (typeof DOCUMENT_EXTENSIONS)[number];

/** One line of the processing record (knowledge preview, "处理记录"). */
export interface KnowledgeActivity {
  at: string;
  code: 'added' | 'processing' | 'parsed' | 'chunked' | 'ready' | 'failed' | 'refresh' | 'settled' | 'refunded';
  /** Numbers and short strings the label is filled with: pages, chars, chunks, credits, reason. */
  detail?: Record<string, string | number>;
}

export function activity(code: KnowledgeActivity['code'], detail?: KnowledgeActivity['detail'], now = new Date()): KnowledgeActivity {
  return detail ? { at: now.toISOString(), code, detail } : { at: now.toISOString(), code };
}

export function documentFormat(fileName: string): DocumentFormat | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return (DOCUMENT_EXTENSIONS as readonly string[]).includes(ext) ? (ext as DocumentFormat) : null;
}

export const DOCUMENT_CONTENT_TYPES: Record<DocumentFormat, string[]> = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
  txt: ['text/plain'],
};

export function validDocument(fileName: string, size: number): boolean {
  return documentFormat(fileName) !== null && size > 0 && size <= DOCUMENT_MAX_BYTES;
}

/**
 * What processing reserves up front (8.2): a document holds a flat 20, pasted
 * text holds exactly its price since its size is known.
 */
export function holdFor(kind: 'document' | 'text', text = ''): number {
  return kind === 'text' ? processingCost(text.trim().length) : KNOWLEDGE_HOLD.document;
}

export function validText(title: string, content: string): boolean {
  const t = title.trim();
  const c = content.trim();
  return t.length > 0 && Array.from(t).length <= TEXT_SOURCE_LIMITS.title && c.length > 0 && c.length <= TEXT_SOURCE_LIMITS.content;
}

/** A stretch of extracted text with its place in the source: one PDF page, or a whole Markdown file. */
export interface Section {
  text: string;
  locator: Locator;
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
    chunks.push(...chunkSection(section, chunks.length));
    if (chunks.length >= MAX_CHUNKS) break;
  }
  return chunks.slice(0, MAX_CHUNKS);
}

/** The extracted text a knowledge row keeps for preview and for the price: sections joined. */
export function joinedContent(sections: readonly Section[]): string {
  return sections
    .map((section) => section.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

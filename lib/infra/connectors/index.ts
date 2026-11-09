/**
 * Bytes of an uploaded document to text sections, by format
 * (rebuild-proposal.md 2.1). Word is always parsed locally. A PDF is parsed
 * locally when its text layer is usable and goes to Firecrawl whole when it
 * is not (scanned pages, failed fonts, garbled text; see ./pdf.ts). Markdown
 * and plain text are read as they are. Local parsing makes no provider call,
 * so it adds no receipt to the source's cost run.
 *
 * A PDF has `PDF_PARSE_MS` in all: local reading spends at most
 * `LOCAL_BUDGET_MS` of it, and Firecrawl gets whatever is left, so a file
 * that falls back late cannot push processing past the route's limit.
 */
import { documentFormat, type Section } from '@/lib/domain/knowledge';
import { docxSections } from './docx';
import { ProcessingFailure } from './failure';
import { firecrawlSections } from './firecrawl';
import { pdfTextLayer } from './pdf';

/** Local PDF reading plus Firecrawl, inside the processing routes' 300 s `maxDuration`. */
const PDF_PARSE_MS = 120_000;
const decoder = new TextDecoder('utf-8');

export async function documentSections(bytes: Uint8Array, fileName: string): Promise<Section[]> {
  const format = documentFormat(fileName);
  if (format === 'docx') return docxSections(bytes);
  if (format === 'pdf') {
    const deadline = Date.now() + PDF_PARSE_MS;
    const layer = await pdfTextLayer(bytes, { deadline });
    if ('sections' in layer) return layer.sections;
    // The reason only, never the file name or its text.
    console.info(`pdf text layer unusable reason=${layer.fallback}${layer.page ? ` page=${layer.page}` : ''}; parsing with Firecrawl`);
    return firecrawlSections(bytes, fileName, { deadline, pages: layer.pages });
  }
  if (format === 'md' || format === 'txt') {
    return [{ text: decoder.decode(bytes).replace(/^﻿/, '').replace(/\r\n?/g, '\n'), locator: {} }];
  }
  throw new ProcessingFailure('unsupported_format', `${fileName} is not a supported document`);
}

export { ProcessingFailure };

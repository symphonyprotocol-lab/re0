/**
 * Bytes of an uploaded document to text sections, by format
 * (rebuild-proposal.md 2.1): PDF and DOCX through Firecrawl, Markdown and
 * plain text read locally as they are.
 */
import { documentFormat, type Section } from '@/lib/domain/knowledge';
import { ProcessingFailure } from './failure';
import { firecrawlSections } from './firecrawl';

const decoder = new TextDecoder('utf-8');

export async function documentSections(bytes: Uint8Array, fileName: string): Promise<Section[]> {
  const format = documentFormat(fileName);
  if (format === 'pdf' || format === 'docx') return firecrawlSections(bytes, fileName, format);
  if (format === 'md' || format === 'txt') {
    return [{ text: decoder.decode(bytes).replace(/^﻿/, '').replace(/\r\n?/g, '\n'), locator: {} }];
  }
  throw new ProcessingFailure('unsupported_format', `${fileName} is not a supported document`);
}

export { ProcessingFailure };

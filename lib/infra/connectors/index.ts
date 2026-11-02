/**
 * Bytes of an uploaded document to text sections, by format
 * (rebuild-proposal.md 2.1): PDF through pdf.js with OCR for scans, DOCX
 * through mammoth, Markdown and plain text read as they are.
 */
import { documentFormat, type Section } from '@/lib/domain/knowledge';
import { docxMarkdown } from './docx';
import { ProcessingFailure } from './failure';
import { pdfSections } from './pdf';

const decoder = new TextDecoder('utf-8');

export async function documentSections(bytes: Uint8Array, fileName: string): Promise<Section[]> {
  const format = documentFormat(fileName);
  if (format === 'pdf') return pdfSections(bytes, fileName);
  if (format === 'docx') return [{ text: await docxMarkdown(bytes, fileName), locator: {} }];
  if (format === 'md' || format === 'txt') {
    return [{ text: decoder.decode(bytes).replace(/^﻿/, '').replace(/\r\n?/g, '\n'), locator: {} }];
  }
  throw new ProcessingFailure('unsupported_format', `${fileName} is not a supported document`);
}

export { ProcessingFailure };

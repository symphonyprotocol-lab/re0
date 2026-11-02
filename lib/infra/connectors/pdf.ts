/**
 * PDF text through pdf.js (unpdf), page by page so every passage can cite its
 * page. A scan -- half or more of the pages without a text layer -- goes to
 * the OCR provider when one is configured.
 */
import { extractText, getDocumentProxy } from 'unpdf';
import type { Section } from '@/lib/domain/knowledge';
import { ProcessingFailure } from './failure';
import { pdfOcr, type PdfOcr } from './ocr';

export async function pdfPages(bytes: Uint8Array, name: string, ocr: PdfOcr | null = pdfOcr()): Promise<string[]> {
  let pages: string[];
  try {
    /* pdf.js takes ownership of the buffer and detaches it; OCR needs the bytes intact. */
    const pdf = await getDocumentProxy(bytes.slice());
    const { text } = await extractText(pdf, { mergePages: false });
    pages = (Array.isArray(text) ? text : [text]).map((page) => page.replace(/[ \t]+\n/g, '\n').trim());
  } catch (error) {
    throw new ProcessingFailure(
      'parse_failed',
      `${name} is not a readable PDF: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
  if (ocr && needsOcr(pages)) {
    const recognised = await ocr.recognize({ bytes, name });
    if (recognised.some((page) => page.length > 0)) return recognised;
  }
  return pages;
}

export function needsOcr(pages: string[]): boolean {
  const withText = pages.filter((page) => page.length > 0).length;
  return withText * 2 <= pages.length;
}

export async function pdfSections(bytes: Uint8Array, name: string, ocr?: PdfOcr | null): Promise<Section[]> {
  const pages = await pdfPages(bytes, name, ocr);
  return pages
    .map((text, at) => ({ text, locator: { page: at + 1 } }))
    .filter((section) => section.text.length > 0);
}

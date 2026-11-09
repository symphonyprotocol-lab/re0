/**
 * Word documents parsed locally: mammoth turns the .docx into semantic HTML
 * (Word heading styles become h1-h6, lists and tables stay structured), and
 * turndown with the GFM plugin turns that into Markdown for the chunker. A
 * Word file has no physical pages, so it is one section without a locator.
 */
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { Section } from '@/lib/domain/knowledge';
import { ProcessingFailure } from './failure';

/** Images are dropped without being read: base64 data URIs would only bloat the passages. */
const skipImages = mammoth.images.imgElement(async () => ({ src: '' }));

function markdownService(): TurndownService {
  const service = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '_' });
  service.use(gfm);
  service.remove(['img', 'script', 'style']);
  /*
   * GFM table cells must stay on one line, but mammoth wraps cell text in
   * paragraphs. Later rules win in turndown, so these replace the plugin's.
   */
  service.addRule('docxTableCell', {
    filter: ['th', 'td'],
    replacement: (content, node) => {
      const text = content.trim().replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|');
      return `${node.parentNode?.firstChild === node ? '| ' : ' '}${text} |`;
    },
  });
  /*
   * Word tables rarely mark a header row, and the plugin keeps such tables as
   * raw HTML. Every table becomes Markdown, its first row read as the header.
   */
  service.addRule('docxTable', {
    filter: 'table',
    replacement: (content) => {
      const rows = content.split('\n').map((row) => row.trim()).filter(Boolean);
      if (rows.length === 0) return '';
      if (!/^\|(\s*:?-+:?\s*\|)+$/.test(rows[1] ?? '')) {
        const columns = rows[0]!.split(/(?<!\\)\|/).length - 2;
        rows.splice(1, 0, `|${' --- |'.repeat(Math.max(1, columns))}`);
      }
      return `\n\n${rows.join('\n')}\n\n`;
    },
  });
  return service;
}

export async function docxSections(bytes: Uint8Array): Promise<Section[]> {
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
      { convertImage: skipImages, externalFileAccess: false },
    ));
  } catch {
    // Not a zip, or a zip without a Word document in it; the reason may quote document content.
    throw new ProcessingFailure('parse_failed', 'The Word document could not be read');
  }
  const text = markdownService().turndown(html).replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new ProcessingFailure('empty_text', 'The Word document has no text');
  return [{ text, locator: {} }];
}

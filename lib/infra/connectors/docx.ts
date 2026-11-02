/**
 * Word documents: mammoth turns the DOCX into semantic HTML (headings,
 * paragraphs, lists, tables), and the few tags it emits are rewritten as
 * Markdown so the chunker sees the document's headings.
 */
import mammoth from 'mammoth';
import { ProcessingFailure } from './failure';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name] ?? '');
}

function inline(html: string): string {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**')
      .replace(/<(em|i)>(.*?)<\/\1>/gi, '*$2*')
      .replace(/<[^>]+>/g, ''),
  ).trim();
}

/** mammoth's HTML as Markdown: headings, paragraphs, list items and table rows. */
export function htmlToMarkdown(html: string): string {
  const blocks: string[] = [];
  const pattern = /<(h[1-6]|p|li|tr)[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(pattern)) {
    const tag = match[1]!.toLowerCase();
    const body = match[2] ?? '';
    if (tag === 'tr') {
      const cells = [...body.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => inline(cell[1] ?? ''));
      if (cells.some(Boolean)) blocks.push(`| ${cells.join(' | ')} |`);
      continue;
    }
    const text = inline(body);
    if (!text) continue;
    if (tag.startsWith('h')) blocks.push(`${'#'.repeat(Number(tag[1]))} ${text}`);
    else if (tag === 'li') blocks.push(`- ${text}`);
    else blocks.push(text);
  }
  return blocks.join('\n\n');
}

export async function docxMarkdown(bytes: Uint8Array, name: string): Promise<string> {
  try {
    const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    return htmlToMarkdown(value);
  } catch (error) {
    throw new ProcessingFailure(
      'parse_failed',
      `${name} is not a readable Word document: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }
}

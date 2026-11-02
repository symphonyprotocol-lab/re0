import { describe, expect, it } from 'vitest';
import { chunkSections, holdFor, validDocument, validText } from '@/lib/domain/knowledge';
import { htmlToMarkdown } from '@/lib/infra/connectors/docx';
import { pdfSections } from '@/lib/infra/connectors/pdf';
import { handbookPages, makePdf } from '../fixtures/pdf';

describe('knowledge rules', () => {
  it('holds 20 for a document and the exact price for text (8.2)', () => {
    expect(holdFor('document')).toBe(20);
    expect(holdFor('text', 'a'.repeat(1001))).toBe(2);
  });

  it('accepts PDF, DOCX, MD and TXT up to 20 MB', () => {
    expect(validDocument('a.pdf', 1)).toBe(true);
    expect(validDocument('a.DOCX', 1)).toBe(true);
    expect(validDocument('a.exe', 1)).toBe(false);
    expect(validDocument('a.md', 20 * 1024 * 1024 + 1)).toBe(false);
    expect(validText('t', 'c')).toBe(true);
    expect(validText('t'.repeat(101), 'c')).toBe(false);
  });

  it('chunks under headings and keeps the page locator', () => {
    const chunks = chunkSections([
      { text: '# Guide\n\n## Setup\n\nInstall it.\n\n## Use\n\nRun it.', locator: { page: 3 } },
    ]);
    expect(chunks.map((chunk) => chunk.locator)).toEqual([
      { page: 3, heading: 'Guide' },
      { page: 3, heading: 'Guide › Setup' },
      { page: 3, heading: 'Guide › Use' },
    ]);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual([0, 1, 2]);
  });

  it('splits a long section into bounded passages', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i} ${'word '.repeat(40)}`).join('\n\n');
    const chunks = chunkSections([{ text: long, locator: {} }]);
    expect(chunks.length).toBeGreaterThan(10);
    expect(Math.max(...chunks.map((chunk) => chunk.content.length))).toBeLessThan(5000);
  });
});

describe('connectors', () => {
  it('reads a 30-page PDF page by page', async () => {
    const sections = await pdfSections(makePdf(handbookPages()), 'handbook.pdf', null);
    expect(sections).toHaveLength(30);
    expect(sections[2]!.locator).toEqual({ page: 3 });
    expect(sections[2]!.text).toContain('Refunds are issued to the original payment method within 14 days');
  });

  it('turns mammoth HTML into Markdown', () => {
    expect(htmlToMarkdown('<h1>Title</h1><p>Hello <strong>world</strong> &amp; more</p><ul><li>One</li></ul><table><tr><td>a</td><td>b</td></tr></table>')).toBe(
      '# Title\n\nHello **world** & more\n\n- One\n\n| a | b |',
    );
  });
});

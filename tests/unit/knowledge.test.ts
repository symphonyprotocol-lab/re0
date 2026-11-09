import { describe, expect, it } from 'vitest';
import { ADD_KNOWLEDGE_KINDS, chunkSections, holdFor, validDocument, validText } from '@/lib/domain/knowledge';

describe('knowledge rules', () => {
  it('exposes five new source choices while retaining historical text support', () => {
    expect(ADD_KNOWLEDGE_KINDS).toEqual(['document', 'audio', 'github', 'page', 'site']);
  });

  it('reserves a refundable balance check independently of source type or text size', () => {
    expect(holdFor('document')).toBe(1);
    expect(holdFor('text', 'a'.repeat(1001))).toBe(1);
    expect(holdFor('audio', 100 * 1024 * 1024)).toBe(1);
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

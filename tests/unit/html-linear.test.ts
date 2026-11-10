import { describe, expect, it } from 'vitest';
import { htmlLinks, htmlTitle, htmlToMarkdown, isNoIndex, normalizeMarkup } from '@/lib/infra/connectors/html';
import { PAGE_MAX_BYTES } from '@/lib/constants';

/** Markup that never closes made the regex walk quadratic: 200 KB took seconds. A full page must stay well under one. */
const HOSTILE = ['<script>', '<!--', '<p>x', '<p><b>x', '<a ', '<a href="x', '<p-x>', '<li><em>', '<meta property="og:title" content="', '<<<<'];

describe('html walk on hostile markup', () => {
  for (const unit of HOSTILE) {
    it(`stays linear on ${JSON.stringify(unit)} × 5 MB`, () => {
      const html = `<html><body>${unit.repeat(Math.floor(PAGE_MAX_BYTES / unit.length))}`;
      const started = performance.now();
      htmlToMarkdown(html);
      htmlLinks(html, new URL('https://example.com/'));
      htmlTitle(html);
      isNoIndex(html);
      expect(performance.now() - started).toBeLessThan(3000);
    });
  }

  it('keeps ordinary pages as they were', () => {
    const markdown = htmlToMarkdown(`<html><body><main><h1>Title</h1><p>One <b>bold</b> and a &lt; b</p><p>Two, unclosed
      <p>Three</p><pre>if (a<b) {}</pre><!-- gone --><script>gone()</script><ul><li>item</li></ul>
      <p>${'long text '.repeat(30)}</p></main></body></html>`);
    expect(markdown).toContain('# Title');
    expect(markdown).toContain('One **bold** and a < b');
    expect(markdown).toContain('Two, unclosed');
    expect(markdown).toContain('Three');
    expect(markdown).toContain('```\nif (a<b) {}\n```');
    expect(markdown).toContain('- item');
    expect(markdown).not.toContain('gone');
    expect(normalizeMarkup('<p>a<p>b</div></p>')).toBe('<p>a</p><p>b</div></p>');
  });
});

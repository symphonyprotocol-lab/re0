import { describe, expect, it } from 'vitest';
import { htmlLinks, htmlTitle, htmlToMarkdown, isNoIndex, normalizeMarkup } from '@/lib/infra/connectors/html';

/**
 * Markup that never closes made the regex walk quadratic: 200 KB took
 * seconds. Asserted as growth, not wall-clock, so a slow runner does not
 * flake: 4× the input must cost well under the 16× a quadratic walk would.
 */
const HOSTILE = ['<script>', '<!--', '<p>x', '<p><b>x', '<a ', '<a href="x', '<p-x>', '<li><em>', '<meta property="og:title" content="', '<<<<'];
const SMALL = 1024 * 1024;
const LARGE = 4 * SMALL;
/** Below this a timing is mostly noise; the ratio uses it as the floor. */
const FLOOR_MS = 25;

function page(unit: string, bytes: number): string {
  return `<html><body>${unit.repeat(Math.floor(bytes / unit.length))}`;
}

let salt = 0;

/** One full read of a page, as the web connector does it; the best of two runs. */
function walk(html: string): number {
  let best = Infinity;
  for (let run = 0; run < 2; run += 1) {
    /* A different page each run (one trailing character), so the normalisation cache does not answer. */
    const copy = `${html}${(salt += 1) % 2 ? 'a' : 'b'}${salt}`;
    const started = performance.now();
    htmlToMarkdown(copy);
    htmlLinks(copy, new URL('https://example.com/'));
    htmlTitle(copy);
    isNoIndex(copy);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('html walk on hostile markup', () => {
  for (const unit of HOSTILE) {
    it(`grows linearly on ${JSON.stringify(unit)}`, () => {
      walk(page(unit, SMALL / 4)); // warm the JIT
      const small = walk(page(unit, SMALL));
      const large = walk(page(unit, LARGE));
      expect(large / Math.max(small, FLOOR_MS), `${Math.round(small)} ms → ${Math.round(large)} ms`).toBeLessThan(8);
      /* Backstop only: a 4 MB page in well under a function's budget even on a slow runner. */
      expect(large).toBeLessThan(20_000);
    }, 120_000);
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

  it('normalises a page once however many helpers read it', () => {
    const html = page('<p>x', SMALL);
    const first = normalizeMarkup(html);
    expect(normalizeMarkup(html)).toBe(first);
    expect(normalizeMarkup('<p>other')).toBe('<p>other</p>');
  });
});

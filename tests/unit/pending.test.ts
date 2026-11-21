/**
 * Every place a post waits -- a Ree answering, the AI general answer, a
 * review, a summary -- shows the same animated line (pending.tsx): three
 * dots bouncing in turn, then the words. They used a spinner whose
 * animation was scoped to other pages, so they stood still.
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Pending } from '@/components/posts/pending';

describe('Pending', () => {
  it('draws three dots, hidden from screen readers, then the words as a status', () => {
    const html = renderToStaticMarkup(createElement(Pending, { label: 'AI 正在写一个通用回答…' }));
    expect(html).toBe('<span class="pending" role="status"><span class="pending-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>AI 正在写一个通用回答…</span></span>');
  });

  it('animates the dots everywhere, and keeps them still with reduced motion', () => {
    const css = readFileSync('components/posts/posts.css', 'utf8');
    expect(css).toMatch(/\.pending-dots i \{[^}]*animation: pending-dot/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.pending-dots i \{\s*animation: none;/);
  });

  it('replaces the still spinners on the post page, the cards, the AI answer and 试问', () => {
    for (const file of ['components/posts/post-detail.tsx', 'components/posts/post-card.tsx', 'components/posts/ai-answer.tsx', 'components/rees/ree-try.tsx']) {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('<Pending label=');
      expect(source).not.toMatch(/is-gathering">\s*<i className="spinner" \/>/);
    }
  });
});

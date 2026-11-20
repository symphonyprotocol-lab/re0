/**
 * An icon given a class for something else (`flex-none`) loses the default
 * `size-4`; with nothing else sizing it, an svg renders at 300×150 -- the
 * share page's "把它，带进对话。" dialog had a chat icon as wide as its card.
 * Every Icon carries `data-icon`, and globals.css sizes such an icon 1rem in
 * `@layer base` at zero specificity, so page rules, utilities and width or
 * height attributes still win.
 */
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Icon } from '@/components/ui/icons';

describe('Icon sizing', () => {
  it('marks every icon, whatever class it is given, and keeps size-4 as the default class', () => {
    expect(renderToStaticMarkup(createElement(Icon, { name: 'chat' }))).toMatch(/<svg data-icon="" [^>]*class="size-4"/);
    expect(renderToStaticMarkup(createElement(Icon, { name: 'chat', className: 'flex-none' }))).toMatch(/<svg data-icon="" [^>]*class="flex-none"/);
  });

  it('falls back to 1rem in the base layer, only for icons without width or height attributes', () => {
    const css = readFileSync('app/globals.css', 'utf8');
    const base = css.slice(css.indexOf('@layer base {'), css.indexOf('@layer components {'));
    expect(base).toMatch(/:where\(svg\[data-icon\]:not\(\[width\]\):not\(\[height\]\)\)\s*\{\s*width: 1rem;\s*height: 1rem;\s*\}/);
  });
});

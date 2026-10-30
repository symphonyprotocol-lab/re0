/**
 * What the editor's toolbar does to a textarea (components/creator/markdown-editor.tsx),
 * as plain text arithmetic: a selection and a format in, the one replacement
 * to make and the selection to leave behind out. Only the Markdown the
 * reading page renders (components/creator/markdown.tsx) is offered.
 */

export type MarkdownFormat = 'bold' | 'italic' | 'heading' | 'bullet' | 'ordered' | 'quote' | 'code' | 'link';

/** Replace `value[start, end)` with `text`, then select `[selectStart, selectEnd)` of the result. */
export type TextEdit = { start: number; end: number; text: string; selectStart: number; selectEnd: number };

const INLINE: Partial<Record<MarkdownFormat, string>> = { bold: '**', italic: '*' };
const LIST_MARK = /^\s*(\d+\.|[-*])\s+/;
/** Per line format: what says a line has it, and how to give it (`at` counts the non-blank lines). */
const LINE_PREFIX = {
  /* The button makes a level-2 heading; a line at another level is moved to it, not stripped. */
  heading: { test: /^##\s+/, add: (line: string) => `## ${line.replace(/^#{1,6}\s+/, '')}` },
  bullet: { test: /^\s*[-*]\s+/, add: (line: string) => `- ${line.replace(LIST_MARK, '')}` },
  ordered: { test: /^\s*\d+\.\s+/, add: (line: string, at: number) => `${at + 1}. ${line.replace(LIST_MARK, '')}` },
  quote: { test: /^>\s?/, add: (line: string) => `> ${line}` },
} as const;

/**
 * The edit a toolbar button makes. `placeholder` is the word inserted when
 * nothing is selected, left selected so typing replaces it.
 */
export function formatEdit(value: string, start: number, end: number, format: MarkdownFormat, placeholder: string): TextEdit {
  if (format === 'heading' || format === 'bullet' || format === 'ordered' || format === 'quote') return lineEdit(value, start, end, format);
  const selected = value.slice(start, end);
  if (format === 'link') {
    const label = selected || placeholder;
    const text = `[${label}](https://)`;
    /* With a label in hand the address is what is left to type; without one, the label is. */
    return selected
      ? { start, end, text, selectStart: start + label.length + 3, selectEnd: start + text.length - 1 }
      : { start, end, text, selectStart: start + 1, selectEnd: start + 1 + label.length };
  }
  if (format === 'code' && selected.includes('\n')) {
    const before = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
    const text = `${before}\`\`\`\n${selected}\n\`\`\`\n`;
    const open = start + before.length + 4;
    return { start, end, text, selectStart: open, selectEnd: open + selected.length };
  }
  const marker = INLINE[format] ?? '`';
  const outside = value.slice(start - marker.length, start) === marker && value.slice(end, end + marker.length) === marker;
  /* `*` inside `**`: italic is not already on just because bold is. */
  const bolded = marker === '*' && value[start - 2] === '*' && value[end + 1] === '*' && value[start - 3] !== '*';
  if (outside && !bolded && start >= marker.length) {
    return { start: start - marker.length, end: end + marker.length, text: selected, selectStart: start - marker.length, selectEnd: end - marker.length };
  }
  const inner = selected || placeholder;
  const text = `${marker}${inner}${marker}`;
  return { start, end, text, selectStart: start + marker.length, selectEnd: start + marker.length + inner.length };
}

/** Prefix every line the selection touches, or take the prefix off when they all have it. */
function lineEdit(value: string, start: number, end: number, format: keyof typeof LINE_PREFIX): TextEdit {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  const newline = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end);
  const to = newline === -1 ? value.length : newline;
  const lines = value.slice(from, to).split('\n');
  const rule = LINE_PREFIX[format];
  /* Blank lines between paragraphs are left alone, unless the caret sits on one. */
  const skip = (line: string) => lines.length > 1 && line.trim() === '';
  const on = lines.every((line) => skip(line) || rule.test.test(line));
  let counted = 0;
  const text = lines
    .map((line) => (skip(line) ? line : on ? line.replace(rule.test, '') : rule.add(line, counted++)))
    .join('\n');
  /* A caret with nothing selected keeps its place in the line; a selection covers the lines it now spans. */
  if (start === end) {
    const caret = Math.min(Math.max(start + text.length - (to - from), from), from + text.length);
    return { start: from, end: to, text, selectStart: caret, selectEnd: caret };
  }
  return { start: from, end: to, text, selectStart: from, selectEnd: from + text.length };
}

/**
 * `block` on lines of its own at `[start, end)`: a blank line before and
 * after unless the text already has one. Where the caret lands after it is
 * `selectStart`.
 */
export function blockEdit(value: string, start: number, end: number, block: string): TextEdit {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const text = `${lead}${block}${tail}`;
  const caret = start + text.length;
  return { start, end, text, selectStart: caret, selectEnd: caret };
}

/** An image's alt text from its file name: no extension, nothing that would end the brackets. */
export function altFromFileName(name: string): string {
  return name
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .replace(/[[\]\s]+/g, ' ')
    .trim()
    .slice(0, 300);
}

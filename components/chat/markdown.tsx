'use client';

import { Fragment, type ReactNode } from 'react';

/** A stretch of the source (line endings as `\n`) to draw through `mark`, such as a sentence 回答核验 flagged. */
export interface TextMark {
  start: number;
  end: number;
}

interface Context {
  citation: (index: number, key: string) => ReactNode;
  marks: readonly TextMark[];
  mark?: (index: number, children: ReactNode, key: string) => ReactNode;
  /** A synthesis's `[A2]` / `[A]` markers; without it they stay text. */
  source?: (marker: string, key: string) => ReactNode;
}

const TOKENS = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[\d{1,2}\])/g;
const TOKENS_WITH_SOURCES = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[\d{1,2}\]|\[[A-E]\d{0,2}\])/g;

/** Plain text at `base` in the source, the parts inside a mark handed to `mark`. */
function marked(text: string, base: number, context: Context, key: string): ReactNode[] {
  if (!context.mark || !context.marks.length) return [text];
  const nodes: ReactNode[] = [];
  let at = 0;
  context.marks.forEach((range, index) => {
    const from = Math.max(range.start - base, at);
    const to = Math.min(range.end - base, text.length);
    if (to <= from) return;
    if (from > at) nodes.push(text.slice(at, from));
    nodes.push(context.mark!(index, text.slice(from, to), `${key}-m${index}`));
    at = to;
  });
  if (at < text.length) nodes.push(text.slice(at));
  return nodes;
}

/**
 * A small Markdown renderer for answers: paragraphs, headings, lists, fenced
 * code, bold, italics, inline code -- and `[n]` citation markers, handed to
 * `citation` so they become buttons. Builds React elements, never HTML, so
 * nothing a model writes is ever injected as markup. `marks` (sorted, apart)
 * are drawn through `mark` wherever their text is plain, bold or italic.
 */
function inline(text: string, base: number, context: Context, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = context.source ? TOKENS_WITH_SOURCES : TOKENS;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(...marked(text.slice(last, at), base + last, context, `${prefix}-t${index}`));
    const token = match[0];
    const key = `${prefix}-${index++}`;
    if (token.startsWith('**')) nodes.push(<strong key={key}>{marked(token.slice(2, -2), base + at + 2, context, key)}</strong>);
    else if (token.startsWith('`')) nodes.push(<code key={key} className="rounded bg-wash px-1 font-mono text-[12px]">{token.slice(1, -1)}</code>);
    else if (/^\[\d/.test(token)) nodes.push(context.citation(Number(token.slice(1, -1)), key));
    else if (token.startsWith('[')) nodes.push(context.source!(token.slice(1, -1), key));
    else nodes.push(<em key={key}>{marked(token.slice(1, -1), base + at + 1, context, key)}</em>);
    last = at + token.length;
  }
  if (last < text.length) nodes.push(...marked(text.slice(last), base + last, context, `${prefix}-t${index}`));
  return nodes;
}

export function Markdown({
  text,
  citation,
  marks = [],
  mark,
  source,
  className = 'flex flex-col gap-3',
}: {
  text: string;
  citation: (index: number, key: string) => ReactNode;
  marks?: readonly TextMark[];
  mark?: (index: number, children: ReactNode, key: string) => ReactNode;
  source?: (marker: string, key: string) => ReactNode;
  className?: string;
}) {
  const context: Context = { citation, marks, mark, source };
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  /* Where each line starts in the source, so marks find their text. */
  const starts: number[] = [];
  lines.reduce((offset, line) => (starts.push(offset), offset + line.length + 1), 0);
  let at = 0;
  let key = 0;
  while (at < lines.length) {
    const line = lines[at]!;
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      at += 1;
      while (at < lines.length && !/^\s*```/.test(lines[at]!)) code.push(lines[at++]!);
      at += 1;
      blocks.push(<pre key={key++} className="overflow-x-auto rounded-lg bg-wash p-3 font-mono text-[12px]">{code.join('\n')}</pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<p key={key} className="mt-1 font-bold">{inline(heading[2]!, starts[at]! + line.length - heading[2]!.length, context, `h${key}`)}</p>);
      key += 1;
      at += 1;
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { text: string; base: number }[] = [];
      while (at < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[at]!)) {
        const item = lines[at]!.replace(/^\s*([-*]|\d+[.)])\s+/, '');
        items.push({ text: item, base: starts[at]! + lines[at]!.length - item.length });
        at += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={key} className={`${ordered ? 'list-decimal' : 'list-disc'} flex flex-col gap-1 pl-5`}>
          {items.map((item, index) => (
            <li key={index}>{inline(item.text, item.base, context, `l${key}-${index}`)}</li>
          ))}
        </List>,
      );
      key += 1;
      continue;
    }
    if (!line.trim()) {
      at += 1;
      continue;
    }
    const paragraph: { text: string; base: number }[] = [];
    while (at < lines.length && lines[at]!.trim() && !/^\s*(```|#{1,4}\s|[-*]\s|\d+[.)]\s)/.test(lines[at]!)) {
      paragraph.push({ text: lines[at]!, base: starts[at]! });
      at += 1;
    }
    blocks.push(
      <p key={key}>
        {paragraph.map((part, index) => (
          <Fragment key={index}>
            {index > 0 && <br />}
            {inline(part.text, part.base, context, `p${key}-${index}`)}
          </Fragment>
        ))}
      </p>,
    );
    key += 1;
  }
  return <div className={className}>{blocks}</div>;
}

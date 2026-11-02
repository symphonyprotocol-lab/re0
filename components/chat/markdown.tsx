'use client';

import { Fragment, type ReactNode } from 'react';

/**
 * A small Markdown renderer for answers: paragraphs, headings, lists, fenced
 * code, bold, italics, inline code -- and `[n]` citation markers, handed to
 * `citation` so they become buttons. Builds React elements, never HTML, so
 * nothing a model writes is ever injected as markup.
 */
function inline(text: string, citation: (index: number, key: string) => ReactNode, prefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|\[\d{1,2}\])/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const token = match[0];
    const key = `${prefix}-${index++}`;
    if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) nodes.push(<code key={key} className="rounded bg-wash px-1 font-mono text-[12px]">{token.slice(1, -1)}</code>);
    else if (token.startsWith('[')) nodes.push(citation(Number(token.slice(1, -1)), key));
    else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = at + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text, citation, className = 'flex flex-col gap-3' }: { text: string; citation: (index: number, key: string) => ReactNode; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
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
      blocks.push(<p key={key} className="mt-1 font-bold">{inline(heading[2]!, citation, `h${key}`)}</p>);
      key += 1;
      at += 1;
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (at < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[at]!)) items.push(lines[at++]!.replace(/^\s*([-*]|\d+[.)])\s+/, ''));
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={key} className={`${ordered ? 'list-decimal' : 'list-disc'} flex flex-col gap-1 pl-5`}>
          {items.map((item, index) => (
            <li key={index}>{inline(item, citation, `l${key}-${index}`)}</li>
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
    const paragraph: string[] = [];
    while (at < lines.length && lines[at]!.trim() && !/^\s*(```|#{1,4}\s|[-*]\s|\d+[.)]\s)/.test(lines[at]!)) paragraph.push(lines[at++]!);
    blocks.push(
      <p key={key}>
        {paragraph.map((part, index) => (
          <Fragment key={index}>
            {index > 0 && <br />}
            {inline(part, citation, `p${key}-${index}`)}
          </Fragment>
        ))}
      </p>,
    );
    key += 1;
  }
  return <div className={className}>{blocks}</div>;
}

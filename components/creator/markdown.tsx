import type { ReactNode } from 'react';

/**
 * An article's Markdown, rendered as React elements -- never as HTML.
 * agent-first-proposal.md 6.5.
 *
 * Only a small, fixed subset is recognised: headings, paragraphs, lists,
 * quotes, fenced code, rules, and inline emphasis, code and links. Anything
 * else stays text, and since nothing is ever injected as markup a post
 * cannot carry script, styles or a tracking pixel. Images are the editor's
 * own (`![caption](media:<id>)`), served through `/media/<id>` -- a
 * short-lived signed URL issued per request to entitled readers; an
 * external image is shown as its caption and a link, not loaded.
 */
export function Markdown({ source }: { source: string }) {
  return <div className="flex flex-col gap-4 text-[15px] leading-[1.8] text-ink">{blocks(source)}</div>;
}

const MEDIA = /^media:([0-9a-f-]{36})$/;

function inline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
  let at = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > at) nodes.push(text.slice(at, start));
    const k = `${key}-${index++}`;
    if (match[1]) {
      const media = MEDIA.exec(match[3]!);
      nodes.push(
        media ? (
          <figure key={k} className="my-2 flex flex-col gap-1.5">
            {/* eslint-disable-next-line @next/next/no-img-element -- a per-request signed redirect, not an optimisable asset */}
            <img src={`/media/${media[1]}`} alt={match[2] ?? ''} className="max-w-full rounded-md border border-line" loading="lazy" />
            {match[2] ? <figcaption className="text-[12px] text-muted">{match[2]}</figcaption> : null}
          </figure>
        ) : (
          <span key={k} className="text-muted">
            [{match[2] || 'image'}]
          </span>
        ),
      );
    } else if (match[4]) {
      const href = safeHref(match[6]!);
      nodes.push(
        href ? (
          <a key={k} href={href} rel="nofollow noopener noreferrer" target="_blank" className="text-brandink underline underline-offset-2">
            {match[5]}
          </a>
        ) : (
          match[5]
        ),
      );
    } else if (match[7]) {
      nodes.push(
        <code key={k} className="rounded bg-mutedbg px-1 font-mono text-[13px]">
          {match[8]}
        </code>,
      );
    } else if (match[9]) {
      nodes.push(<strong key={k}>{match[10]}</strong>);
    } else if (match[11]) {
      nodes.push(<em key={k}>{match[12]}</em>);
    }
    at = start + match[0].length;
  }
  if (at < text.length) nodes.push(text.slice(at));
  return nodes;
}

function safeHref(value: string): string | null {
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

function blocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let index = 0;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    const key = `p-${out.length}`;
    out.push(<p key={key}>{inline(paragraph.join(' '), key)}</p>);
    paragraph = [];
  };
  while (index < lines.length) {
    const line = lines[index]!;
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index]!)) code.push(lines[index++]!);
      index += 1;
      out.push(
        <pre key={`c-${out.length}`} className="overflow-x-auto rounded-md border border-line bg-subtle p-4 font-mono text-[12.5px] leading-[1.6]">
          {code.join('\n')}
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const key = `h-${out.length}`;
      const level = heading[1]!.length;
      const size = level === 1 ? 'text-[24px]' : level === 2 ? 'text-[20px]' : 'text-[17px]';
      out.push(
        <p key={key} role="heading" aria-level={level + 1} className={`${size} font-semibold leading-[1.4]`}>
          {inline(heading[2]!, key)}
        </p>,
      );
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      out.push(<hr key={`r-${out.length}`} className="border-line" />);
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^>\s?/, ''));
      const key = `q-${out.length}`;
      out.push(
        <blockquote key={key} className="border-l-2 border-line pl-4 text-steel">
          {inline(quote.join(' '), key)}
        </blockquote>,
      );
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index]!)) items.push(lines[index++]!.replace(/^\s*([-*]|\d+\.)\s+/, ''));
      const key = `l-${out.length}`;
      const children = items.map((item, at) => <li key={`${key}-${at}`}>{inline(item, `${key}-${at}`)}</li>);
      out.push(
        ordered ? (
          <ol key={key} className="list-decimal pl-6">
            {children}
          </ol>
        ) : (
          <ul key={key} className="list-disc pl-6">
            {children}
          </ul>
        ),
      );
      continue;
    }
    if (line.trim() === '') flush();
    else paragraph.push(line.trim());
    index += 1;
  }
  flush();
  return out;
}

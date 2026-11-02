/**
 * A web page's HTML as Markdown: the main content only (`<main>`, `<article>`
 * or the body without navigation, header, footer, aside, scripts and forms),
 * with headings, paragraphs, lists, code blocks, quotes and table rows kept,
 * so the chunker sees the page's structure and a citation its heading.
 *
 * A regex walk rather than a DOM: pages are untrusted, nothing here executes
 * them, and the output is plain text the chunker splits anyway.
 */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  middot: '·',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** Whitespace inside a block collapsed; tags dropped. */
function inline(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export function htmlTitle(html: string): string | null {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const value = decodeEntities((title?.[1] ?? og?.[1] ?? '').replace(/\s+/g, ' ')).trim();
  return value || null;
}

const DROPPED = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'form', 'nav', 'header', 'footer', 'aside', 'button', 'select'];

/** The part of the page that is content. */
function mainOf(html: string): string {
  let body = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROPPED) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body) ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body);
  if (main?.[1] && inline(main[1]).length > 200) return main[1];
  return /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(body)?.[1] ?? body;
}

export function htmlToMarkdown(html: string): string {
  const body = mainOf(html);
  const blocks: string[] = [];
  /* Code first: its whitespace is content, so it is lifted out before anything collapses it. */
  const codes: string[] = [];
  const marked = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    codes.push(decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\s+$/, ''));
    return `<p>\u0000CODE${codes.length - 1}\u0000</p>`;
  });
  const pattern = /<(h[1-6]|p|li|tr|blockquote|dt|dd|figcaption|caption)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of marked.matchAll(pattern)) {
    const tag = match[1]!.toLowerCase();
    const inner = match[2] ?? '';
    const code = /^\s*\u0000CODE(\d+)\u0000\s*$/.exec(inner);
    if (code) {
      blocks.push(`\`\`\`\n${codes[Number(code[1])] ?? ''}\n\`\`\``);
      continue;
    }
    if (tag === 'tr') {
      const cells = [...inner.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => inline(cell[1] ?? '').replace(/\n/g, ' '));
      if (cells.some(Boolean)) blocks.push(`| ${cells.join(' | ')} |`);
      continue;
    }
    /* A list item or quote that wraps paragraphs is reached through them instead. */
    if ((tag === 'li' || tag === 'blockquote') && /<(p|li|pre|h[1-6])\b/i.test(inner)) continue;
    const text = inline(inner);
    if (!text) continue;
    if (tag[0] === 'h' && tag.length === 2) blocks.push(`${'#'.repeat(Number(tag[1]))} ${text.replace(/\n/g, ' ')}`);
    else if (tag === 'li') blocks.push(`- ${text}`);
    else if (tag === 'blockquote') blocks.push(text.split('\n').map((line) => `> ${line}`).join('\n'));
    else blocks.push(text);
  }
  /* A page built from bare <div>s: fall back to its text, line by line. */
  if (blocks.join('').length < 80) {
    const text = inline(marked.replace(/<\/(div|section|td|span)>/gi, '\n').replace(/\u0000CODE(\d+)\u0000/g, (_, n: string) => codes[Number(n)] ?? ''));
    return text.replace(/\n{3,}/g, '\n\n');
  }
  return blocks.join('\n\n');
}

/** Absolute http(s) links in the page, fragments dropped. */
export function htmlLinks(html: string, base: URL): URL[] {
  const found: URL[] = [];
  const baseHref = /<base\b[^>]*href=["']([^"']+)["']/i.exec(html)?.[1];
  let root = base;
  if (baseHref) {
    try {
      root = new URL(baseHref, base);
    } catch {
      /* a broken <base> is ignored */
    }
  }
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = decodeEntities(match[1] ?? '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    try {
      const url = new URL(href, root);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      url.hash = '';
      found.push(url);
    } catch {
      /* not a URL */
    }
  }
  return found;
}

/** Whether a page asks not to be indexed (`<meta name="robots" content="noindex">`). */
export function isNoIndex(html: string): boolean {
  return /<meta[^>]+name=["']robots["'][^>]*content=["'][^"']*noindex/i.test(html);
}

import { NextResponse, type NextRequest } from 'next/server';
import { markdownSourcePath, pageHtmlToMarkdown } from '@/lib/http/page-markdown';
import { readerHeader } from '@/lib/http/reading-limit';

export const runtime = 'nodejs';

const DISCOVERY = '</.well-known/agent-skills/index.json>; rel="agent-skills"; type="application/json"';

function responseHeaders(sourceUrl: URL): HeadersInit {
  return {
    'access-control-allow-origin': '*',
    'cache-control': 'private, no-store',
    'content-location': sourceUrl.href,
    'content-type': 'text/markdown; charset=utf-8',
    link: `<${sourceUrl.href}>; rel="canonical", ${DISCOVERY}`,
    vary: 'Cookie, Accept-Language',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex',
  };
}

async function render(request: NextRequest, head: boolean): Promise<Response> {
  const source = markdownSourcePath(
    request.headers.get('x-re0-markdown-page') ?? request.nextUrl.searchParams.get('source'),
  );
  if (!source) {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'source must be a local content-page path' } },
      { status: 400 },
    );
  }

  const sourceUrl = new URL(source, request.nextUrl.origin);
  const headers = new Headers({ accept: 'text/html', 'x-re0-markdown-source': '1' });
  for (const name of ['accept-language', 'cookie', 'user-agent']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  /* The page counts a session-less reader against the anonymous reading limit by address; this fetch is ours, so it names whose (lib/http/reading-limit.ts). */
  const reader = await readerHeader(request.headers);
  if (reader) headers.set(...reader);
  const fetchPage = (url: URL) =>
    fetch(url, { method: head ? 'HEAD' : 'GET', headers, cache: 'no-store', redirect: 'manual' });

  const page = await fetchPage(sourceUrl);

  /*
   * Asset ids may contain dots, so an asset can be named like the
   * representation suffix (a repository `notes.md`). When the path without
   * the suffix is no page, the request was for that literal page: serve it
   * as HTML. The header above keeps the middleware from rewriting it again.
   */
  if (page.status === 404 && sourceUrl.pathname !== '/') {
    const literalUrl = new URL(sourceUrl);
    literalUrl.pathname = `${sourceUrl.pathname}.md`;
    const literal = await fetchPage(literalUrl);
    const literalType = literal.headers.get('content-type') ?? '';
    if (literal.ok && literalType.toLowerCase().includes('text/html')) {
      await page.body?.cancel();
      return new NextResponse(head ? null : literal.body, {
        status: literal.status,
        headers: { 'content-type': literalType, 'cache-control': 'private, no-store', vary: 'Cookie, Accept-Language' },
      });
    }
    await literal.body?.cancel();
  }

  if (page.status >= 300 && page.status < 400) {
    const location = page.headers.get('location');
    return new NextResponse(null, {
      status: page.status,
      headers: location ? { location } : undefined,
    });
  }

  const contentType = page.headers.get('content-type') ?? '';
  if (!head && !contentType.toLowerCase().includes('text/html')) {
    return NextResponse.json(
      { error: { code: 'unsupported_media_type', message: 'source is not an HTML content page' } },
      { status: 415 },
    );
  }

  const outputHeaders = responseHeaders(sourceUrl);
  if (head) return new NextResponse(null, { status: page.status, headers: outputHeaders });

  const markdown = pageHtmlToMarkdown(await page.text(), sourceUrl);
  return new NextResponse(markdown, { status: page.status, headers: outputHeaders });
}

export async function GET(request: NextRequest): Promise<Response> {
  return render(request, false);
}

export async function HEAD(request: NextRequest): Promise<Response> {
  return render(request, true);
}

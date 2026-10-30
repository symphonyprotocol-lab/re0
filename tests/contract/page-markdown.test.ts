import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { GET as renderMarkdownPage } from '@/app/api/page-markdown/route';
import { markdownSourcePath, pageHtmlToMarkdown } from '@/lib/http/page-markdown';
import { middleware } from '@/middleware';

describe('Markdown page representations', () => {
  it('accepts local page paths and keeps their query string', () => {
    expect(markdownSourcePath('/assets?q=next.js&sort=recent')).toBe(
      '/assets?q=next.js&sort=recent',
    );
    expect(markdownSourcePath('/')).toBe('/');
  });

  it('rejects non-pages and recursive representations', () => {
    for (const source of [
      'https://attacker.example/',
      '//attacker.example/',
      '/api/v1/context',
      '/_next/static/app.js',
      '/.well-known/agent-skills/index.json',
      '/about.md',
    ]) {
      expect(markdownSourcePath(source)).toBeNull();
    }
  });

  it('keeps semantic page content while dropping layout and executable noise', () => {
    const html = `<!doctype html>
      <html><body>
        <nav>Site navigation</nav>
        <main>
          <h1>Guide</h1>
          <p>Read the <a href="/docs/start?mode=fast">quick start</a>.</p>
          <table><thead><tr><th>Name</th><th>State</th></tr></thead>
          <tbody><tr><td>Index</td><td>Ready</td></tr></tbody></table>
          <script>ignoreMe()</script>
        </main>
        <footer>Footer</footer>
      </body></html>`;

    const markdown = pageHtmlToMarkdown(html, new URL('https://re0.test/about'));

    expect(markdown).toContain('# Guide');
    expect(markdown).toContain('[quick start](https://re0.test/docs/start?mode=fast)');
    expect(markdown).toContain('| Name | State |');
    expect(markdown).not.toContain('Site navigation');
    expect(markdown).not.toContain('ignoreMe');
    expect(markdown).not.toContain('Footer');
    expect(markdown.endsWith('\n')).toBe(true);
  });

  it('carries the source in the rewritten request instead of relying on rewritten searchParams', () => {
    const response = middleware(
      new NextRequest('https://re0.test/status.md?probe=1', {
        headers: { 'accept-language': 'en' },
      }),
    );

    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'https://re0.test/api/page-markdown?source=%2Fstatus%3Fprobe%3D1',
    );
    expect(response.headers.get('x-middleware-request-x-re0-markdown-page')).toBe(
      '/status?probe=1',
    );
  });

  it('renders the source supplied by a middleware rewrite header', async () => {
    const fetchPage = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body><main><h1>Service status</h1></main></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    try {
      /* Next can leave this URL as the original URL after a middleware
         rewrite, so there is intentionally no `source` search parameter. */
      const response = await renderMarkdownPage(
        new NextRequest('https://re0.test/status.md', {
          headers: { 'x-re0-markdown-page': '/status' },
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('# Service status\n');
      expect(fetchPage.mock.calls[0]?.[0]).toEqual(new URL('https://re0.test/status'));
    } finally {
      fetchPage.mockRestore();
    }
  });

  it('lets the renderer\'s own fetch of a literal `.md` page through', () => {
    const response = middleware(
      new NextRequest('https://re0.test/assets/owner/notes.md', {
        headers: { 'x-re0-markdown-source': '1' },
      }),
    );

    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('serves the literal page when the path without `.md` is no page', async () => {
    /* An asset mirroring a repository named `notes.md`: /owner/notes does not exist. */
    const fetchPage = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof URL ? input : new URL(String(input));
      return url.pathname === '/assets/owner/notes.md'
        ? new Response('<html><body><main><h1>notes.md</h1></main></body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        : new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    });
    try {
      const response = await renderMarkdownPage(
        new NextRequest('https://re0.test/assets/owner/notes.md', {
          headers: { 'x-re0-markdown-page': '/assets/owner/notes' },
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(await response.text()).toContain('<h1>notes.md</h1>');
      const literal = fetchPage.mock.calls[1]?.[0] as URL;
      expect(literal.pathname).toBe('/assets/owner/notes.md');
      expect(new Headers(fetchPage.mock.calls[1]?.[1]?.headers).get('x-re0-markdown-source')).toBe('1');
    } finally {
      fetchPage.mockRestore();
    }
  });

  it('keeps a plain 404 when neither reading is a page', async () => {
    const fetchPage = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('<html><body><main><h1>Not found</h1></main></body></html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      }),
    );
    try {
      const response = await renderMarkdownPage(
        new NextRequest('https://re0.test/assets/owner/missing.md', {
          headers: { 'x-re0-markdown-page': '/assets/owner/missing' },
        }),
      );

      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('text/markdown');
    } finally {
      fetchPage.mockRestore();
    }
  });
});

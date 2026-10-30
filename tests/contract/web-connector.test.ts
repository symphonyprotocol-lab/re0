/**
 * How a website becomes a list of files. architecture.md 8.2, step 2.
 *
 * The network is faked; what is under test is discovery -- which pages a crawl
 * asks for, in which order, and what it calls them -- plus the two request
 * headers that decide whether a documentation host answers at all, and with
 * what. Each of these is a decision a real site would only reveal by failing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fetchWebSnapshot } from '@/lib/infrastructure/connectors/web';
import { IngestionFailure } from '@/lib/domain/ingestion';

const HOST = 'https://docs.example.test';

type Page = { body: string; type?: string; status?: number };

/**
 * A fake site, plus optionally a fake rendering provider. Anything not
 * listed is a 404. Renderer requests are answered from `rendered`, keyed by
 * the page URL the provider was asked for, so a test can say what a browser
 * would have seen.
 */
function serve(pages: Record<string, Page>, rendered: Record<string, string> = {}) {
  const requests: { url: string; headers: Headers; body: string | null }[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : null;
    requests.push({ url, headers: new Headers(init?.headers), body });

    const scrape = /^(https:\/\/api\.firecrawl\.dev|http:\/\/firecrawl\.internal:3002)\/(v1|v2)\/scrape$/.exec(url);
    if (scrape) {
      if (scrape[1] === 'http://firecrawl.internal:3002' && scrape[2] === 'v2' && pages['__no_v2__']) {
        return new Response('not found', { status: 404 });
      }
      const asked = (JSON.parse(body ?? '{}') as { url?: string }).url ?? '';
      const markdown = rendered[asked];
      return Response.json(
        markdown ? { success: true, data: { markdown } } : { success: false, error: 'no page' },
      );
    }
    if (url.startsWith('https://r.jina.ai/')) {
      const markdown = rendered[url.slice('https://r.jina.ai/'.length)];
      return markdown
        ? new Response(markdown, { status: 200, headers: { 'content-type': 'text/plain' } })
        : new Response('no page', { status: 422 });
    }

    const page = pages[url.replace(HOST, '')];
    if (!page) return new Response('missing', { status: 404 });
    return new Response(page.body, {
      status: page.status ?? 200,
      headers: { 'content-type': page.type ?? 'text/html; charset=utf-8' },
    });
  }) as typeof fetch;
  return requests;
}

const html = (links: string[]) =>
  `<html><body><h1>Page</h1>${links.map((l) => `<a href="${l}">x</a>`).join('')}</body></html>`;

const urlset = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${HOST}${l}</loc></url>`)
    .join('')}</urlset>`;

const realFetch = globalThis.fetch;
const RENDER_ENV = ['RENDER_PROVIDER', 'RENDER_PROVIDER_API_KEY', 'RENDER_PROVIDER_BASE_URL'] as const;
const realEnv = Object.fromEntries(RENDER_ENV.map((name) => [name, process.env[name]]));
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of RENDER_ENV) {
    if (realEnv[name] === undefined) delete process.env[name];
    else process.env[name] = realEnv[name];
  }
});

function renderer(provider: 'firecrawl' | 'jina' | null, key = 'render-key'): void {
  for (const name of RENDER_ENV) delete process.env[name];
  if (provider) {
    process.env.RENDER_PROVIDER = provider;
    process.env.RENDER_PROVIDER_API_KEY = key;
  }
}

/** An application shell: scripts, a mount point, no text. */
const SHELL = `<html><head><script src="/app.js"></script></head><body><div id="root"></div>${'<script>window.__DATA__={}</script>'.repeat(3)}</body></html>`;

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'succeeded';
  } catch (error) {
    return error instanceof IngestionFailure ? error.code : 'unexpected';
  }
}

async function crawlPaths(pages: Record<string, Page>, indexDepth = 2) {
  const requests = serve(pages);
  const snapshot = await fetchWebSnapshot({
    location: `${HOST}/docs/`,
    indexDepth,
  });
  return { requests, paths: snapshot.files.map((f) => f.path).sort() };
}

describe('the request a site sees', () => {
  it('identifies as a browser-shaped crawler with a contact URL', async () => {
    const { requests } = await crawlPaths({ '/docs/': { body: html([]) } });
    const agent = requests.find((r) => r.url === `${HOST}/docs/`)?.headers.get('user-agent');
    expect(agent).toMatch(/^Mozilla\/5\.0 \(compatible; re0-ingestion\/\d/);
    expect(agent).toContain('+https://');
  });

  it('asks for markdown ahead of html', async () => {
    const { requests } = await crawlPaths({ '/docs/': { body: html([]) } });
    const accept = requests.find((r) => r.url === `${HOST}/docs/`)?.headers.get('accept') ?? '';
    expect(accept.startsWith('text/markdown')).toBe(true);
    expect(accept).toContain('text/html');
  });
});

describe('what a fetched page is called', () => {
  it('names an extensionless page by what the server said it was', async () => {
    const { paths } = await crawlPaths({
      '/docs/': { body: html(['/docs/routing', '/docs/notes']) },
      '/docs/routing': { body: '# Routing\n\nText.', type: 'text/markdown' },
      '/docs/notes': { body: 'plain', type: 'text/plain' },
    });
    // `docs` for the entry, not `docs/`: a trailing slash would hide the suffix.
    expect(paths).toEqual(['docs.html', 'docs/notes.txt', 'docs/routing.md']);
  });

  it('leaves a path that already has an extension alone', async () => {
    const { paths } = await crawlPaths({
      '/docs/': { body: html(['/docs/guide.html']) },
      '/docs/guide.html': { body: '# Guide', type: 'text/markdown' },
    });
    expect(paths).toEqual(['docs.html', 'docs/guide.html']);
  });
});

describe('discovery', () => {
  it('follows exactly the selected number of child-page levels, up to three', async () => {
    const pages = {
      '/docs/': { body: html(['/docs/a']) },
      '/docs/a': { body: html(['/docs/a/b']) },
      '/docs/a/b': { body: html(['/docs/a/b/c']) },
      '/docs/a/b/c': { body: html(['/docs/a/b/c/d']) },
      '/docs/a/b/c/d': { body: html([]) },
    };

    expect((await crawlPaths(pages, 0)).paths).toEqual(['docs.html']);
    expect((await crawlPaths(pages, 2)).paths).toEqual([
      'docs.html',
      'docs/a.html',
      'docs/a/b.html',
    ]);
    expect((await crawlPaths(pages, 3)).paths).toEqual([
      'docs.html',
      'docs/a.html',
      'docs/a/b.html',
      'docs/a/b/c.html',
    ]);
    /* The connector keeps the hard ceiling even if an internal caller skips
       the form parser. */
    expect((await crawlPaths(pages, 99)).paths).toEqual([
      'docs.html',
      'docs/a.html',
      'docs/a/b.html',
      'docs/a/b/c.html',
    ]);
  });

  it('does not let a sitemap bypass a zero-depth website crawl', async () => {
    const { paths, requests } = await crawlPaths(
      {
        '/docs/': { body: html([]) },
        '/sitemap.xml': { body: urlset(['/docs/unlinked']), type: 'application/xml' },
        '/docs/unlinked': { body: html([]) },
      },
      0,
    );
    expect(paths).toEqual(['docs.html']);
    expect(requests.some((request) => request.url.endsWith('/sitemap.xml'))).toBe(false);
    expect(requests.some((request) => request.url.endsWith('/docs/unlinked'))).toBe(false);
  });

  it('follows links inside a page served as markdown', async () => {
    const { paths } = await crawlPaths({
      '/docs/': { body: '# Docs\n\nSee [routing](/docs/routing).', type: 'text/markdown' },
      '/docs/routing': { body: '# Routing', type: 'text/markdown' },
    });
    expect(paths).toEqual(['docs.md', 'docs/routing.md']);
  });

  it('seeds the crawl from /sitemap.xml, inside the entry scope only', async () => {
    const { paths, requests } = await crawlPaths({
      '/docs/': { body: html([]) },
      '/sitemap.xml': { body: urlset(['/docs/unlinked', '/blog/post']), type: 'application/xml' },
      '/docs/unlinked': { body: html([]) },
      '/blog/post': { body: html([]) },
    });
    expect(paths).toEqual(['docs.html', 'docs/unlinked.html']);
    expect(requests.some((r) => r.url.endsWith('/blog/post'))).toBe(false);
  });

  it('scopes an entry typed without a trailing slash to its section, not the site', async () => {
    const requests = serve({
      '/docs': { body: html(['/docs/routing', '/blog/post', '/docs-archive/old']) },
      '/docs/routing': { body: html([]) },
      '/blog/post': { body: html([]) },
      '/docs-archive/old': { body: html([]) },
      '/sitemap.xml': { body: urlset(['/docs/unlinked', '/pricing']), type: 'application/xml' },
      '/docs/unlinked': { body: html([]) },
      '/pricing': { body: html([]) },
    });
    const snapshot = await fetchWebSnapshot({
      location: `${HOST}/docs`,
      indexDepth: 2,
    });
    expect(snapshot.files.map((f) => f.path).sort()).toEqual([
      'docs.html',
      'docs/routing.html',
      'docs/unlinked.html',
    ]);
    const fetched = requests.map((r) => r.url.replace(HOST, ''));
    for (const outside of ['/blog/post', '/docs-archive/old', '/pricing']) {
      expect(fetched).not.toContain(outside);
    }
  });

  it('scopes a file entry to its directory', async () => {
    const requests = serve({
      '/docs/index.html': { body: html(['/docs/routing', '/blog/post']) },
      '/docs/routing': { body: html([]) },
      '/blog/post': { body: html([]) },
    });
    const snapshot = await fetchWebSnapshot({
      location: `${HOST}/docs/index.html`,
      indexDepth: 2,
    });
    expect(snapshot.files.map((f) => f.path).sort()).toEqual([
      'docs/index.html',
      'docs/routing.html',
    ]);
    expect(requests.some((r) => r.url.endsWith('/blog/post'))).toBe(false);
  });

  it('reads sitemap locations from robots.txt and follows a sitemap index', async () => {
    const { paths, requests } = await crawlPaths({
      '/docs/': { body: html([]) },
      '/robots.txt': {
        body: `User-agent: *\nAllow: /\nSitemap: ${HOST}/maps/index.xml\nSitemap: https://elsewhere.test/sitemap.xml\n`,
        type: 'text/plain',
      },
      '/maps/index.xml': {
        body: `<sitemapindex><sitemap><loc>${HOST}/maps/docs.xml</loc></sitemap><sitemap><loc>${HOST}/maps/old.xml.gz</loc></sitemap></sitemapindex>`,
        type: 'application/xml',
      },
      '/maps/docs.xml': { body: urlset(['/docs/deep/page']), type: 'application/xml' },
      '/docs/deep/page': { body: html([]) },
    });
    expect(paths).toEqual(['docs.html', 'docs/deep/page.html']);
    expect(requests.some((r) => r.url.startsWith('https://elsewhere.test'))).toBe(false);
    expect(requests.some((r) => r.url.endsWith('.gz'))).toBe(false);
    expect(requests.some((r) => r.url === `${HOST}/sitemap.xml`)).toBe(false);
  });

  it('falls back to following links when there is no sitemap at all', async () => {
    const { paths } = await crawlPaths({
      '/docs/': { body: html(['/docs/a']) },
      '/docs/a': { body: html(['/docs/b']) },
      '/docs/b': { body: html([]) },
    });
    expect(paths).toEqual(['docs.html', 'docs/a.html', 'docs/b.html']);
  });
});

describe('pages that need a browser', () => {
  it('reports an entry point that is a script shell under its own code', async () => {
    renderer(null);
    serve({ '/docs/': { body: SHELL } });
    await expect(
      failureOf(fetchWebSnapshot({ location: `${HOST}/docs/` })),
    ).resolves.toBe('source_unrendered');
  });

  it('skips a shell found mid-crawl and keeps the rest', async () => {
    renderer(null);
    const { paths } = await crawlPaths({
      '/docs/': { body: html(['/docs/app', '/docs/static']) },
      '/docs/app': { body: SHELL },
      '/docs/static': { body: html([]) },
    });
    expect(paths).toEqual(['docs.html', 'docs/static.html']);
  });

  it('renders a shell through Firecrawl and crawls the markdown it returns', async () => {
    renderer('firecrawl');
    const requests = serve(
      { '/docs/': { body: SHELL }, '/docs/routing': { body: '# Routing', type: 'text/markdown' } },
      { [`${HOST}/docs/`]: '# Docs\n\nRendered. See [routing](/docs/routing).' },
    );
    const snapshot = await fetchWebSnapshot({
      location: `${HOST}/docs/`,
      indexDepth: 1,
    });
    expect(snapshot.files.map((f) => f.path).sort()).toEqual(['docs.md', 'docs/routing.md']);
    expect(snapshot.files.find((f) => f.path === 'docs.md')?.content).toContain('Rendered.');

    const call = requests.find((r) => r.url.startsWith('https://api.firecrawl.dev/'));
    expect(call?.headers.get('authorization')).toBe('Bearer render-key');
    expect(JSON.parse(call?.body ?? '{}')).toMatchObject({ url: `${HOST}/docs/`, formats: ['markdown'] });
  });

  it('renders a page the site refused, through Jina, and asks for markdown', async () => {
    renderer('jina');
    const requests = serve(
      { '/docs/': { body: 'forbidden', status: 403 } },
      { [`${HOST}/docs/`]: '# Docs\n\nSeen by a browser.' },
    );
    const snapshot = await fetchWebSnapshot({ location: `${HOST}/docs/` });
    expect(snapshot.files.map((f) => f.path)).toEqual(['docs.md']);
    const call = requests.find((r) => r.url.startsWith('https://r.jina.ai/'));
    expect(call?.url).toBe(`https://r.jina.ai/${HOST}/docs/`);
    expect(call?.headers.get('x-respond-with')).toBe('markdown');
    expect(call?.headers.get('authorization')).toBe('Bearer render-key');
  });

  it('never asks the renderer for a page the plain fetch answered', async () => {
    renderer('firecrawl');
    const { requests } = await crawlPaths({ '/docs/': { body: html(['/docs/a']) }, '/docs/a': { body: html([]) } });
    expect(requests.some((r) => r.url.startsWith('https://api.firecrawl.dev/'))).toBe(false);
  });

  it('keeps the original refusal when the site is forbidden and the renderer fails too', async () => {
    renderer('firecrawl');
    serve({ '/docs/': { body: 'forbidden', status: 403 } });
    await expect(
      failureOf(fetchWebSnapshot({ location: `${HOST}/docs/` })),
    ).resolves.toBe('source_forbidden');
  });

  it('does not launder a private address through the renderer', async () => {
    renderer('firecrawl');
    const requests = serve({}, { 'https://10.0.0.5/docs/': '# Internal' });
    await expect(
      failureOf(fetchWebSnapshot({ location: 'https://10.0.0.5/docs/' })),
    ).resolves.toBe('source_forbidden');
    expect(requests).toHaveLength(0);
  });

  it('is off when Firecrawl is named without a key', async () => {
    renderer('firecrawl', '');
    serve({ '/docs/': { body: SHELL } }, { [`${HOST}/docs/`]: '# Docs' });
    await expect(
      failureOf(fetchWebSnapshot({ location: `${HOST}/docs/` })),
    ).resolves.toBe('source_unrendered');
  });

  it('reaches a self-hosted Firecrawl on a private http address, without a key', async () => {
    renderer('firecrawl', '');
    process.env.RENDER_PROVIDER_BASE_URL = 'http://firecrawl.internal:3002/';
    const requests = serve({ '/docs/': { body: SHELL } }, { [`${HOST}/docs/`]: '# Docs\n\nSelf-hosted.' });
    const snapshot = await fetchWebSnapshot({ location: `${HOST}/docs/` });
    expect(snapshot.files[0]?.content).toContain('Self-hosted.');
    const call = requests.find((r) => r.url.startsWith('http://firecrawl.internal:3002/'));
    expect(call?.url).toBe('http://firecrawl.internal:3002/v2/scrape');
    expect(call?.headers.get('authorization')).toBeNull();
  });

  it('sends the key to a self-hosted instance that has authentication on', async () => {
    renderer('firecrawl', 'self-hosted-key');
    process.env.RENDER_PROVIDER_BASE_URL = 'http://firecrawl.internal:3002';
    const requests = serve({ '/docs/': { body: SHELL } }, { [`${HOST}/docs/`]: '# Docs\n\nGuarded.' });
    const snapshot = await fetchWebSnapshot({ location: `${HOST}/docs/` });
    expect(snapshot.files[0]?.content).toContain('Guarded.');
    const call = requests.find((r) => r.url.startsWith('http://firecrawl.internal:3002/'));
    expect(call?.headers.get('authorization')).toBe('Bearer self-hosted-key');
  });

  it('falls back to /v1/scrape on a self-hosted instance without the v2 API', async () => {
    renderer('firecrawl', '');
    process.env.RENDER_PROVIDER_BASE_URL = 'http://firecrawl.internal:3002';
    const requests = serve(
      { '/docs/': { body: SHELL }, __no_v2__: { body: '' } },
      { [`${HOST}/docs/`]: '# Docs\n\nOlder instance.' },
    );
    const snapshot = await fetchWebSnapshot({ location: `${HOST}/docs/` });
    expect(snapshot.files[0]?.content).toContain('Older instance.');
    const versions = requests
      .filter((r) => r.url.startsWith('http://firecrawl.internal:3002/'))
      .map((r) => r.url.split('/')[3]);
    expect(versions).toEqual(['v2', 'v1']);
  });

  it('still holds the target page to the address rules when the renderer is self-hosted', async () => {
    renderer('firecrawl', '');
    process.env.RENDER_PROVIDER_BASE_URL = 'http://firecrawl.internal:3002';
    const requests = serve({}, { 'https://192.168.1.1/docs/': '# Router admin' });
    await expect(
      failureOf(fetchWebSnapshot({ location: 'https://192.168.1.1/docs/' })),
    ).resolves.toBe('source_forbidden');
    expect(requests).toHaveLength(0);
  });
});

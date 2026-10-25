/**
 * The rendering fallback's key pool and the AnySearch adapter.
 * architecture.md 8.2, lib/infrastructure/connectors/render.ts.
 *
 * The network is faked. What is under test is which key each call carries,
 * when the pool moves on, what it reports against a key, and the exact
 * request AnySearch is sent -- its endpoint refuses any field but `url`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { IngestionFailure } from '@/lib/domain/ingestion';
import {
  pageRendererFor,
  renderConfigFromEnvironment,
  type RenderConfig,
} from '@/lib/infrastructure/connectors/render';

const PAGE = new URL('https://docs.example.test/guide/');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; authorization: string | null; body: string | null };

/** Answers each call by the key it carries: a status, or success. */
function vendor(statusByKey: Record<string, number>, answer: (call: Call) => Response) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(input),
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    const key = call.authorization?.replace('Bearer ', '') ?? '';
    const status = statusByKey[key];
    if (status) return new Response('{"code":-1,"message":"no"}', { status });
    return answer(call);
  }) as typeof fetch;
  return calls;
}

const firecrawlOk = () =>
  Response.json({ success: true, data: { markdown: '# Guide\n\nRendered.', metadata: { title: 'Guide' } } });
const anysearchOk = () =>
  Response.json({
    code: 0,
    message: 'success',
    request_id: 'b84e2c71-5f36-4a9d-8c42-1e7b63d5f290',
    data: { url: PAGE.toString(), title: 'Guide', content: '# Guide\n\nExtracted.' },
  });

function config(overrides: Partial<RenderConfig> & Pick<RenderConfig, 'provider'>) {
  const failures: { keyId: string; failure: string }[] = [];
  const answered: string[] = [];
  const full: RenderConfig = {
    baseUrl: null,
    keys: [
      { id: 'a', apiKey: 'key-a' },
      { id: 'b', apiKey: 'key-b' },
      { id: 'c', apiKey: 'key-c' },
    ],
    onKeyFailure: async (keyId, failure) => {
      failures.push({ keyId, failure });
    },
    onKeyAnswered: async (keyId) => {
      answered.push(keyId);
    },
    ...overrides,
  };
  return { config: full, failures, answered };
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'succeeded';
  } catch (error) {
    return error instanceof IngestionFailure ? error.code : 'unexpected';
  }
}

describe('the key pool', () => {
  it('moves past a spent key to the next one and reports it as exhausted', async () => {
    const calls = vendor({ 'key-a': 402 }, firecrawlOk);
    const { config: c, failures, answered } = config({ provider: 'firecrawl' });
    const page = await pageRendererFor(c)!.render(PAGE);
    expect(page.body).toContain('Rendered.');
    expect(page.renderedBy).toBe('firecrawl');
    expect(calls.map((call) => call.authorization)).toEqual(['Bearer key-a', 'Bearer key-b']);
    expect(failures).toEqual([{ keyId: 'a', failure: 'exhausted' }]);
    expect(answered).toEqual(['b']);
  });

  it('keeps a spent key set aside for the rest of the build', async () => {
    const calls = vendor({ 'key-a': 402 }, firecrawlOk);
    const { config: c, answered } = config({ provider: 'firecrawl' });
    const renderer = pageRendererFor(c)!;
    await renderer.render(PAGE);
    await renderer.render(new URL('https://docs.example.test/other/'));
    expect(calls.map((call) => call.authorization)).toEqual([
      'Bearer key-a',
      'Bearer key-b',
      'Bearer key-b',
    ]);
    /* Told once per key, not once per page. */
    expect(answered).toEqual(['b']);
  });

  it('reports a refused key, but not a rate-limited one', async () => {
    vendor({ 'key-a': 401, 'key-b': 429 }, firecrawlOk);
    const { config: c, failures } = config({ provider: 'firecrawl' });
    await pageRendererFor(c)!.render(PAGE);
    expect(failures).toEqual([{ keyId: 'a', failure: 'rejected' }]);
  });

  it("does not count Firecrawl's 403 -- a site it will not scrape -- against the key", async () => {
    const calls = vendor({ 'key-a': 403 }, firecrawlOk);
    const { config: c, failures } = config({ provider: 'firecrawl' });
    await expect(failureOf(pageRendererFor(c)!.render(PAGE))).resolves.toBe('source_unrendered');
    expect(calls).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it("counts AnySearch's 403 -- an expired key -- as refused", async () => {
    vendor({ 'key-a': 403 }, anysearchOk);
    const { config: c, failures } = config({ provider: 'anysearch' });
    await pageRendererFor(c)!.render(PAGE);
    expect(failures).toEqual([{ keyId: 'a', failure: 'rejected' }]);
  });

  it('fails the page as unrendered once every key is spent', async () => {
    const calls = vendor({ 'key-a': 402, 'key-b': 402, 'key-c': 401 }, firecrawlOk);
    const { config: c, failures } = config({ provider: 'firecrawl' });
    const renderer = pageRendererFor(c)!;
    await expect(failureOf(renderer.render(PAGE))).resolves.toBe('source_unrendered');
    expect(failures.map((f) => f.keyId)).toEqual(['a', 'b', 'c']);
    /* A second page does not ask again with keys already known to be spent. */
    await expect(failureOf(renderer.render(PAGE))).resolves.toBe('source_unrendered');
    expect(calls).toHaveLength(3);
  });

  it('does not rotate on a failure that is the page, not the key', async () => {
    const calls = vendor({}, () => new Response('upstream', { status: 500 }));
    const { config: c, failures } = config({ provider: 'firecrawl' });
    await expect(failureOf(pageRendererFor(c)!.render(PAGE))).resolves.toBe('source_unrendered');
    expect(calls).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  it('still tries the next key when recording a failure fails', async () => {
    vendor({ 'key-a': 402 }, firecrawlOk);
    const { config: c } = config({
      provider: 'firecrawl',
      onKeyFailure: async () => {
        throw new Error('database down');
      },
    });
    await expect(pageRendererFor(c)!.render(PAGE)).resolves.toMatchObject({ renderedBy: 'firecrawl' });
  });

  it('is off for hosted Firecrawl with no key, and calls AnySearch anonymously', async () => {
    expect(pageRendererFor({ provider: 'firecrawl', baseUrl: null, keys: [] })).toBeNull();
    const calls = vendor({}, anysearchOk);
    await pageRendererFor({ provider: 'anysearch', baseUrl: null, keys: [] })!.render(PAGE);
    expect(calls[0]?.authorization).toBeNull();
  });
});

describe('AnySearch', () => {
  it('posts exactly { url } to /v1/extract and returns the content with its title', async () => {
    const calls = vendor({}, anysearchOk);
    const { config: c } = config({ provider: 'anysearch' });
    const page = await pageRendererFor(c)!.render(PAGE);
    expect(calls[0]?.url).toBe('https://api.anysearch.com/v1/extract');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ url: PAGE.toString() });
    expect(calls[0]?.authorization).toBe('Bearer key-a');
    expect(page).toMatchObject({
      contentType: 'text/markdown',
      title: 'Guide',
      renderedBy: 'anysearch',
    });
    expect(page.body).toContain('Extracted.');
  });

  it('passes cleaned HTML on as HTML rather than as markdown', async () => {
    vendor({}, () =>
      Response.json({ code: 0, data: { title: '', content: '<article><h1>Guide</h1></article>' } }),
    );
    const page = await pageRendererFor({ provider: 'anysearch', baseUrl: null, keys: [] })!.render(PAGE);
    expect(page.contentType).toBe('text/html');
    expect(page.title).toBeUndefined();
  });

  it('treats an error envelope as a page it could not render', async () => {
    vendor({}, () => Response.json({ code: -1, message: 'Unable to extract', error_code: 'x' }));
    await expect(
      failureOf(pageRendererFor({ provider: 'anysearch', baseUrl: null, keys: [] })!.render(PAGE)),
    ).resolves.toBe('source_unrendered');
  });

  it('never asks for a private address', async () => {
    const calls = vendor({}, anysearchOk);
    await expect(
      failureOf(
        pageRendererFor({ provider: 'anysearch', baseUrl: null, keys: [] })!.render(
          new URL('https://10.0.0.5/docs/'),
        ),
      ),
    ).resolves.toBe('source_forbidden');
    expect(calls).toHaveLength(0);
  });
});

describe('the deployment variables', () => {
  const NAMES = ['RENDER_PROVIDER', 'RENDER_PROVIDER_API_KEY', 'RENDER_PROVIDER_BASE_URL'] as const;
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('read several comma-separated keys as a pool, in order', () => {
    process.env.RENDER_PROVIDER = 'AnySearch';
    process.env.RENDER_PROVIDER_API_KEY = ' key-1, key-2 ,,';
    delete process.env.RENDER_PROVIDER_BASE_URL;
    expect(renderConfigFromEnvironment()).toEqual({
      provider: 'anysearch',
      baseUrl: null,
      keys: [
        { id: 'env:0', apiKey: 'key-1' },
        { id: 'env:1', apiKey: 'key-2' },
      ],
    });
  });

  it('configure nothing for an unknown provider', () => {
    process.env.RENDER_PROVIDER = 'puppeteer';
    expect(renderConfigFromEnvironment()).toBeNull();
  });
});

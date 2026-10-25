/**
 * Rendered-page fallback for website sources. architecture.md 8.2, 15.1.
 *
 * A documentation site that refuses a plain fetch, or answers it with a
 * JavaScript shell, can still be read by handing the URL to a service that
 * runs a browser and returns Markdown. Ingestion runs in Vercel Workflows,
 * where a headless browser of our own is too large and too cold to keep; the
 * service is the browser. It is a fallback, never the first attempt: the
 * plain fetch is free and answers most sites (`web.ts`), and every page
 * rendered elsewhere is a page whose content we did not fetch ourselves.
 *
 * Which provider, and with which keys, is console configuration
 * (`manage-render-config.ts`), resolved once per source fetch and handed in
 * as a `RenderConfig`. An installation that never saved one keeps running on
 * the deployment's variables:
 *
 *   RENDER_PROVIDER          firecrawl | anysearch | jina; unset means no fallback
 *   RENDER_PROVIDER_API_KEY  required for hosted Firecrawl; optional for
 *                            AnySearch, Jina and a self-hosted instance.
 *                            Several keys may be given, comma-separated, and
 *                            are tried in order
 *   RENDER_PROVIDER_BASE_URL unset means the vendor's hosted API; set it to
 *                            a self-hosted instance -- `http://firecrawl:3002`
 *                            on the private network is the normal case
 *
 * Several keys are a pool, tried in order. A key the provider answers with
 * 402 (quota spent), 401 (refused) or 429 (rate limited) is set aside for
 * the rest of this renderer's life and the same page is asked again with the
 * next one; the first two are also reported (`onKeyFailure`) so the console
 * can show the key as spent and later builds try it last. A page fails only
 * when every key has been set aside.
 *
 * The target page is always held to the source-address rules (a renderer
 * must not be asked for a private address, even though it could not reach
 * one), and the provider call carries the same timeout and size caps as a
 * direct fetch. A self-hosted endpoint is the operator's own service, so it
 * is exempt from those address rules and, in exchange, may not redirect
 * (`trustedEndpoint` in http.ts). A self-hosted Firecrawl that predates the
 * v2 API is answered by falling back to `/v1/scrape`, whose response has the
 * same shape.
 */
import { IngestionFailure, INGESTION_LIMITS } from '@/lib/domain/ingestion';
import {
  DEFAULT_RENDER_BASE_URL,
  hostedRequiresKey,
  isRenderProvider,
  keyFailureOf,
  type RenderKeyFailure,
  type RenderProviderName,
} from '@/lib/domain/render-config';
import { assertFetchable, fetchDocument, fetchJson, type FetchedResource } from './http';

export type { RenderProviderName } from '@/lib/domain/render-config';

export interface PageRenderer {
  readonly name: RenderProviderName;
  /** The page as Markdown, with `contentType: 'text/markdown'`. */
  render(target: URL): Promise<FetchedResource>;
}

/** One key of the pool. `id` is what a failure is reported against. */
export interface RenderKey {
  id: string;
  apiKey: string;
}

export interface RenderConfig {
  provider: RenderProviderName;
  /** A self-hosted instance; null calls the vendor's hosted API. */
  baseUrl: string | null;
  /** In the order they are tried. Empty calls without authentication. */
  keys: readonly RenderKey[];
  /**
   * Told when the provider says a key is spent or refused. Awaited, but a
   * failure to record it never fails the page: the next key is still tried.
   */
  onKeyFailure?(keyId: string, failure: RenderKeyFailure, detail: string): Promise<void>;
  /** Told the first time each key answers, so an earlier failure mark can be cleared. */
  onKeyAnswered?(keyId: string): Promise<void>;
}

/** What the deployment's variables configure, or null when they configure nothing. */
export function renderConfigFromEnvironment(): RenderConfig | null {
  const name = process.env.RENDER_PROVIDER?.trim().toLowerCase();
  if (!isRenderProvider(name)) return null;
  const keys = (process.env.RENDER_PROVIDER_API_KEY ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
    .map((apiKey, index) => ({ id: `env:${index}`, apiKey }));
  const baseUrl = process.env.RENDER_PROVIDER_BASE_URL?.trim() || null;
  return { provider: name, baseUrl, keys };
}

/** The renderer the deployment's variables configure. Kept for callers without a console. */
export function pageRenderer(): PageRenderer | null {
  const config = renderConfigFromEnvironment();
  return config ? pageRendererFor(config) : null;
}

/**
 * The renderer a configuration describes, or null when it cannot render at
 * all -- hosted Firecrawl without a key is the fallback being off, not a call
 * that will fail on every source.
 */
export function pageRendererFor(config: RenderConfig): PageRenderer | null {
  const selfHosted = config.baseUrl !== null;
  if (!selfHosted && hostedRequiresKey(config.provider) && config.keys.length === 0) return null;
  const endpoint: Endpoint = {
    baseUrl: (config.baseUrl ?? DEFAULT_RENDER_BASE_URL[config.provider]).replace(/\/+$/, ''),
    selfHosted,
  };
  const pool = keyPool(config);
  switch (config.provider) {
    case 'firecrawl':
      return firecrawl(endpoint, pool);
    case 'anysearch':
      return anysearch(endpoint, pool);
    case 'jina':
      return jina(endpoint, pool);
  }
}

interface Endpoint {
  baseUrl: string;
  /** True for a self-hosted instance rather than the vendor's API. */
  selfHosted: boolean;
}

/** Runs one provider call with the next usable key. */
type KeyPool = <T>(call: (headers: Record<string, string>) => Promise<T>) => Promise<T>;

/**
 * The keys of one configuration, set aside one by one as the provider
 * refuses them. Shared by every page this renderer renders, so a spent key
 * costs one wasted call per build rather than one per page.
 */
function keyPool(config: RenderConfig): KeyPool {
  const setAside = new Set<string>();
  const answered = new Set<string>();
  return async (call) => {
    if (config.keys.length === 0) return call({});
    let last: unknown = null;
    for (const key of config.keys) {
      if (setAside.has(key.id)) continue;
      try {
        const result = await call({ authorization: `Bearer ${key.apiKey}` });
        if (!answered.has(key.id)) {
          answered.add(key.id);
          await config.onKeyAnswered?.(key.id).catch(() => undefined);
        }
        return result;
      } catch (error) {
        const status = error instanceof IngestionFailure ? error.httpStatus : undefined;
        const failure = keyFailureOf(config.provider, status);
        if (!failure) throw error;
        setAside.add(key.id);
        last = error;
        if (failure !== 'rate_limited' && config.onKeyFailure) {
          const detail = error instanceof Error ? error.message : `answered ${status}`;
          await config.onKeyFailure(key.id, failure, detail).catch(() => undefined);
        }
      }
    }
    throw new IngestionFailure(
      'source_unrendered',
      'fetch-snapshot',
      `every ${config.provider} key is spent, refused or rate limited` +
        (last instanceof Error ? ` (last: ${last.message})` : ''),
    );
  };
}

function unrendered(name: RenderProviderName, target: URL, detail: string): IngestionFailure {
  return new IngestionFailure(
    'source_unrendered',
    'fetch-snapshot',
    `${name} could not render ${target.host}: ${detail}`,
  );
}

/** Wrapped as `unrendered`, except a pool that ran dry, which already says why. */
function asUnrendered(name: RenderProviderName, target: URL, error: unknown): IngestionFailure {
  if (error instanceof IngestionFailure && error.code === 'source_unrendered') return error;
  return unrendered(name, target, error instanceof Error ? error.message : 'request failed');
}

/**
 * A provider's answer, held to the per-document cap like a fetched page.
 *
 * Every provider is asked for Markdown, but AnySearch decides the format
 * itself and may answer a page with cleaned HTML; that is passed on as HTML,
 * which the parser reads and the crawl takes links from, rather than as
 * Markdown full of tags.
 */
function markdownResource(
  name: RenderProviderName,
  target: URL,
  markdown: unknown,
  title?: unknown,
): FetchedResource {
  if (typeof markdown !== 'string' || markdown.trim().length === 0) {
    throw unrendered(name, target, 'no markdown in the response');
  }
  const bytes = new TextEncoder().encode(markdown).length;
  if (bytes > INGESTION_LIMITS.maxDocumentBytes) {
    throw new IngestionFailure('source_too_large', 'fetch-snapshot', `${target.host} rendered too much`);
  }
  const declared = typeof title === 'string' && title.trim().length > 0 ? title.trim() : undefined;
  return {
    url: target.toString(),
    contentType: looksLikeHtml(markdown) ? 'text/html' : 'text/markdown',
    body: markdown,
    bytes,
    renderedBy: name,
    ...(declared ? { title: declared } : {}),
  };
}

function looksLikeHtml(body: string): boolean {
  return /^\s*(?:<!doctype html|<html[\s>]|<body[\s>]|<(?:article|main|div|section)[\s>])/i.test(body);
}

interface FirecrawlAnswer {
  success?: boolean;
  /** `metadata.title` is the page's `<title>`, which the markdown may lack. */
  data?: { markdown?: unknown; metadata?: { title?: unknown } };
  error?: unknown;
}

/** POST /v2/scrape, markdown only; /v1/scrape for an older self-hosted instance. */
function firecrawl(endpoint: Endpoint, pool: KeyPool): PageRenderer {
  const scrape = (version: 'v2' | 'v1', target: URL) =>
    pool((headers) =>
      fetchJson<FirecrawlAnswer>(`${endpoint.baseUrl}/${version}/scrape`, {
        method: 'POST',
        headers,
        body: { url: target.toString(), formats: ['markdown'], onlyMainContent: true },
        trustedEndpoint: endpoint.selfHosted,
      }),
    );

  return {
    name: 'firecrawl',
    async render(target) {
      assertFetchable(target);
      let answer: FirecrawlAnswer;
      try {
        try {
          answer = await scrape('v2', target);
        } catch (error) {
          /* A 404 on the route is an instance without the v2 API, not a page
             that could not be rendered. Anything else is final. */
          const noV2 =
            endpoint.selfHosted &&
            error instanceof IngestionFailure &&
            error.code === 'source_empty';
          if (!noV2) throw error;
          answer = await scrape('v1', target);
        }
      } catch (error) {
        throw asUnrendered('firecrawl', target, error);
      }
      if (answer.success === false) {
        throw unrendered('firecrawl', target, typeof answer.error === 'string' ? answer.error : 'refused');
      }
      return markdownResource('firecrawl', target, answer.data?.markdown, answer.data?.metadata?.title);
    },
  };
}

interface AnysearchAnswer {
  /** 0 on success, -1 on an error, with `message` and maybe `error_code`. */
  code?: unknown;
  message?: unknown;
  data?: { url?: unknown; title?: unknown; content?: unknown };
}

/**
 * POST /v1/extract with exactly `{ url }` -- the endpoint refuses unknown
 * fields, so no format can be asked for. Quota and key problems arrive as
 * HTTP statuses (401, 402, 403, 429) and are the pool's to handle; a 422 is
 * a page it could not extract.
 */
function anysearch(endpoint: Endpoint, pool: KeyPool): PageRenderer {
  return {
    name: 'anysearch',
    async render(target) {
      assertFetchable(target);
      let answer: AnysearchAnswer;
      try {
        answer = await pool((headers) =>
          fetchJson<AnysearchAnswer>(`${endpoint.baseUrl}/v1/extract`, {
            method: 'POST',
            headers,
            body: { url: target.toString() },
            trustedEndpoint: endpoint.selfHosted,
          }),
        );
      } catch (error) {
        throw asUnrendered('anysearch', target, error);
      }
      if (answer.code !== 0) {
        throw unrendered('anysearch', target, typeof answer.message === 'string' ? answer.message : 'refused');
      }
      return markdownResource('anysearch', target, answer.data?.content, answer.data?.title);
    },
  };
}

/** GET {base}/{url}, answered as Markdown text. */
function jina(endpoint: Endpoint, pool: KeyPool): PageRenderer {
  return {
    name: 'jina',
    async render(target) {
      assertFetchable(target);
      let page: FetchedResource;
      try {
        page = await pool((headers) =>
          fetchDocument(`${endpoint.baseUrl}/${target.toString()}`, {
            accept: 'text/plain',
            headers: { 'x-respond-with': 'markdown', ...headers },
            maxBytes: INGESTION_LIMITS.maxDocumentBytes,
            trustedEndpoint: endpoint.selfHosted,
          }),
        );
      } catch (error) {
        throw asUnrendered('jina', target, error);
      }
      return markdownResource('jina', target, page.body);
    },
  };
}

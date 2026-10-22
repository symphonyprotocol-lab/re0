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
 * Provider is configuration, credential is environment (15.3):
 *
 *   RENDER_PROVIDER          firecrawl | jina; unset means no fallback
 *   RENDER_PROVIDER_API_KEY  required for hosted Firecrawl; optional for
 *                            Jina and for a self-hosted instance, which
 *                            usually runs without authentication
 *   RENDER_PROVIDER_BASE_URL unset means the vendor's hosted API; set it to
 *                            a self-hosted instance -- `http://firecrawl:3002`
 *                            on the private network is the normal case
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
import { assertFetchable, fetchDocument, fetchJson, type FetchedResource } from './http';

export type RenderProviderName = 'firecrawl' | 'jina';

export interface PageRenderer {
  readonly name: RenderProviderName;
  /** The page as Markdown, with `contentType: 'text/markdown'`. */
  render(target: URL): Promise<FetchedResource>;
}

const DEFAULT_BASE_URL: Record<RenderProviderName, string> = {
  firecrawl: 'https://api.firecrawl.dev',
  jina: 'https://r.jina.ai',
};

function providerName(): RenderProviderName | null {
  const name = process.env.RENDER_PROVIDER?.trim().toLowerCase();
  return name === 'firecrawl' || name === 'jina' ? name : null;
}

export function isRendererConfigured(): boolean {
  return pageRenderer() !== null;
}

interface Endpoint {
  baseUrl: string;
  apiKey: string | null;
  /** True for a self-hosted instance named in the environment. */
  selfHosted: boolean;
}

/** The configured renderer, or null when the fallback is switched off. */
export function pageRenderer(): PageRenderer | null {
  const name = providerName();
  if (!name) return null;
  const apiKey = process.env.RENDER_PROVIDER_API_KEY?.trim() || null;
  const custom = process.env.RENDER_PROVIDER_BASE_URL?.trim() || null;
  /* The hosted Firecrawl API refuses anonymous calls; a missing key there is
     the fallback being off, not a call that will fail on every source. A
     self-hosted instance normally has authentication disabled. */
  if (name === 'firecrawl' && !custom && !apiKey) return null;
  const endpoint: Endpoint = {
    baseUrl: (custom ?? DEFAULT_BASE_URL[name]).replace(/\/+$/, ''),
    apiKey,
    selfHosted: custom !== null,
  };
  return name === 'firecrawl' ? firecrawl(endpoint) : jina(endpoint);
}

function authHeaders(endpoint: Endpoint): Record<string, string> {
  return endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {};
}

function unrendered(name: RenderProviderName, target: URL, detail: string): IngestionFailure {
  return new IngestionFailure(
    'source_unrendered',
    'fetch-snapshot',
    `${name} could not render ${target.host}: ${detail}`,
  );
}

/** A provider's answer, held to the per-document cap like a fetched page. */
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
    contentType: 'text/markdown',
    body: markdown,
    bytes,
    renderedBy: name,
    ...(declared ? { title: declared } : {}),
  };
}

interface FirecrawlAnswer {
  success?: boolean;
  /** `metadata.title` is the page's `<title>`, which the markdown may lack. */
  data?: { markdown?: unknown; metadata?: { title?: unknown } };
  error?: unknown;
}

/** POST /v2/scrape, markdown only; /v1/scrape for an older self-hosted instance. */
function firecrawl(endpoint: Endpoint): PageRenderer {
  const scrape = (version: 'v2' | 'v1', target: URL) =>
    fetchJson<FirecrawlAnswer>(`${endpoint.baseUrl}/${version}/scrape`, {
      method: 'POST',
      headers: authHeaders(endpoint),
      body: { url: target.toString(), formats: ['markdown'], onlyMainContent: true },
      trustedEndpoint: endpoint.selfHosted,
    });

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
        throw unrendered('firecrawl', target, error instanceof Error ? error.message : 'request failed');
      }
      if (answer.success === false) {
        throw unrendered('firecrawl', target, typeof answer.error === 'string' ? answer.error : 'refused');
      }
      return markdownResource('firecrawl', target, answer.data?.markdown, answer.data?.metadata?.title);
    },
  };
}

/** GET {base}/{url}, answered as Markdown text. */
function jina(endpoint: Endpoint): PageRenderer {
  return {
    name: 'jina',
    async render(target) {
      assertFetchable(target);
      let page: FetchedResource;
      try {
        page = await fetchDocument(`${endpoint.baseUrl}/${target.toString()}`, {
          accept: 'text/plain',
          headers: { 'x-respond-with': 'markdown', ...authHeaders(endpoint) },
          maxBytes: INGESTION_LIMITS.maxDocumentBytes,
          trustedEndpoint: endpoint.selfHosted,
        });
      } catch (error) {
        throw unrendered('jina', target, error instanceof Error ? error.message : 'request failed');
      }
      return markdownResource('jina', target, page.body);
    },
  };
}

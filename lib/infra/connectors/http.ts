/**
 * The only way knowledge processing reaches the network (from the old
 * `http.ts`). Every URL here was typed by an owner or found in a page that
 * URL served, so scheme, host, every redirect hop, response size and
 * credentials are checked here rather than in each connector.
 *
 * The host check is the literal-address half of SSRF defence: it refuses
 * `localhost`, metadata names and private ranges before any request. A
 * public name that resolves to a private address needs resolution-time
 * pinning, which `fetch` does not expose; the deployment's egress rules are
 * the other half.
 */
import { isPublicHost } from '@/lib/domain/sources';
import { ProcessingFailure } from './failure';

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Browser-shaped and honest about who is asking, so an operator who wants us gone can say so. */
const USER_AGENT = 'Mozilla/5.0 (compatible; re0-knowledge/1.0; +https://re0.com)';

/** Headers that authenticate us and must not survive a change of origin. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

export interface FetchOptions {
  accept?: string;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface FetchedResource {
  /** Where the body actually came from, after redirects. */
  url: string;
  status: number;
  headers: Headers;
  contentType: string;
  body: string;
}

export function assertFetchable(url: URL): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProcessingFailure('source_forbidden', 'only http(s) sources are fetched');
  }
  if (url.username || url.password) throw new ProcessingFailure('source_forbidden', 'credentials in a source URL');
  if (!isPublicHost(url.hostname)) throw new ProcessingFailure('source_forbidden', 'a local or private address is not a source');
}

function credentialSafe(headers: Record<string, string> | undefined, url: URL, origin: string): Record<string, string> {
  if (!headers) return {};
  if (url.origin === origin) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
}

async function readCapped(response: Response, limit: number, host: string): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new ProcessingFailure('source_too_large', `${host} served more than ${limit} bytes`);
    }
    parts.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/**
 * Fetches one resource, following redirects by hand so each hop is checked:
 * a source that redirects to a private address has just defeated the check
 * on the URL the owner typed.
 */
export async function fetchBytes(target: string, options: FetchOptions = {}): Promise<FetchedResource & { bytes: Uint8Array }> {
  const origin = new URL(target).origin;
  let url = new URL(target);
  const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertFetchable(url);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: options.accept ?? 'text/html, text/markdown;q=0.9, text/plain;q=0.8, */*;q=0.5',
          'user-agent': USER_AGENT,
          ...credentialSafe(options.headers, url, origin),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch {
      throw new ProcessingFailure('source_unreachable', `${url.host} did not answer`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new ProcessingFailure('source_unreachable', 'redirect without a location');
      url = new URL(location, url);
      continue;
    }
    /* GitHub answers an exhausted rate limit with 403 (or 429): busy, not a refusal. */
    if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
      await response.body?.cancel();
      throw new ProcessingFailure('rate_limited', `${url.host} is rate limiting (${response.status})`);
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new ProcessingFailure('source_forbidden', `${url.host} refused the request (${response.status})`, response.status);
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      throw new ProcessingFailure('source_missing', `${url.host} has nothing at ${url.pathname}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ProcessingFailure('source_unreachable', `${url.host} answered ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > limit) {
      await response.body?.cancel();
      throw new ProcessingFailure('source_too_large', `${url.host} declared ${declared} bytes`);
    }
    const bytes = await readCapped(response, limit, url.host);
    return {
      url: url.toString(),
      status: response.status,
      headers: response.headers,
      contentType: (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
      body: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
      bytes,
    };
  }
  throw new ProcessingFailure('source_unreachable', 'too many redirects');
}

export async function fetchDocument(target: string, options: FetchOptions = {}): Promise<FetchedResource> {
  const { bytes: _bytes, ...resource } = await fetchBytes(target, options);
  return resource;
}

/** JSON from an API, with the same guards. */
export async function fetchJson<T>(target: string, options: FetchOptions = {}): Promise<T> {
  const resource = await fetchDocument(target, { ...options, accept: 'application/json' });
  try {
    return JSON.parse(resource.body) as T;
  } catch {
    throw new ProcessingFailure('parse_failed', `${new URL(target).host} did not return JSON`);
  }
}

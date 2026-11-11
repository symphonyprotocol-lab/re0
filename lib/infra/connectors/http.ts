/**
 * The only way knowledge processing reaches the network (from the old
 * `http.ts`). Every URL here was typed by an owner or found in a page that
 * URL served, so scheme, host, every redirect hop, response size and
 * credentials are checked here rather than in each connector.
 *
 * SSRF defence has two halves. Before each hop, `assertFetchable` refuses
 * other schemes, non-default ports, credentials, and private names or
 * literals. At connect time, `publicOnlyDispatcher` resolves the name,
 * refuses it if any answer is private (loopback, RFC 1918, CGNAT,
 * link-local / metadata, v4-mapped v6, ...), and dials only the address it
 * checked, so DNS rebinding cannot swap it between check and connect.
 */
import { meterTransfer } from '@/lib/infra/ai/provider-meter';
import { isPublicHost } from '@/lib/domain/sources';
import { isIP } from 'node:net';
import { isPrivateAddressFailure, isPublicAddress, publicOnlyDispatcher } from './address';
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
  /* `URL` drops a scheme's default port, so anything left is a non-standard one. */
  if (url.port && url.port !== '80' && url.port !== '443') throw new ProcessingFailure('source_forbidden', 'only the standard http(s) ports are fetched');
  if (url.username || url.password) throw new ProcessingFailure('source_forbidden', 'credentials in a source URL');
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (!isPublicHost(url.hostname) || (isIP(literal) && !isPublicAddress(literal))) {
    throw new ProcessingFailure('source_forbidden', 'a local or private address is not a source');
  }
}

/** `retry-after` (seconds or an HTTP date), else GitHub's `x-ratelimit-reset` once the quota is spent. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (headers.get('x-ratelimit-remaining') === '0' && reset && /^\d+$/.test(reset)) return Math.max(0, Number(reset) * 1000 - now);
  return undefined;
}

/** The start of a body, for telling a refusal from a throttle; the rest is dropped. */
async function peekText(response: Response, limit = 4096): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.length;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return parts.map((part) => decoder.decode(part, { stream: true })).join('').slice(0, limit);
}

/**
 * GitHub throttles with 429, or with 403 for both its primary limit
 * (`x-ratelimit-remaining: 0`) and its secondary one (a `retry-after`, or
 * only "secondary rate limit" in the body). Busy, not a refusal.
 */
async function throttled(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  if (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')) return true;
  return /rate limit/i.test(await peekText(response));
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
        // Node's fetch is undici; the dispatcher option is not in the DOM RequestInit type.
        ...({ dispatcher: publicOnlyDispatcher() } as RequestInit),
      });
    } catch (error) {
      if (isPrivateAddressFailure(error)) throw new ProcessingFailure('source_forbidden', `${url.host} resolves to a local or private address`);
      throw new ProcessingFailure('source_unreachable', `${url.host} did not answer`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new ProcessingFailure('source_unreachable', 'redirect without a location');
      url = new URL(location, url);
      continue;
    }
    if (await throttled(response)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProcessingFailure('rate_limited', `${url.host} is rate limiting (${response.status})`, response.status, retryAfterMs(response.headers));
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
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
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, limit, url.host);
    } catch (error) {
      // A body cut off at the limit was still transferred up to it.
      if (error instanceof ProcessingFailure && error.code === 'source_too_large') meterTransfer('fetch', limit);
      throw error;
    }
    meterTransfer('fetch', bytes.length);
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

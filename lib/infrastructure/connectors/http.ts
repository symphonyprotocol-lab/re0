/**
 * The only way ingestion reaches the network.
 *
 * Every fetch here is against a URL an operator typed, or one discovered inside
 * a document that URL served. architecture.md 15.1 makes source fetching a
 * security boundary, so this module is where that boundary is: scheme, host,
 * redirect chain, response size and content type are all checked here rather
 * than in each connector, because a check that each connector has to remember
 * is a check one of them will forget.
 */
import { IngestionFailure, type IngestionStage } from '@/lib/domain/ingestion';

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 4;

/** Ceiling on one response. The per-document cap is applied by the caller. */
const MAX_BYTES = 8 * 1024 * 1024;

const STAGE: IngestionStage = 'fetch-snapshot';

/**
 * Hostnames that resolve inside our own network, refused before the request.
 *
 * This is the literal-address half of SSRF defence: it stops the obvious
 * `https://169.254.169.254/...` and `https://localhost/...` without a DNS
 * lookup. It cannot stop a public name that resolves to a private address --
 * that needs resolution-time pinning, which the platform's fetch does not
 * expose -- so the deployment keeps egress restricted as well. Both are cheap;
 * neither alone is enough.
 */
const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata.goog']);

const PRIVATE_V4 =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/;

export function assertFetchable(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new IngestionFailure('source_forbidden', STAGE, 'only https sources are fetched');
  }
  if (url.username || url.password) {
    throw new IngestionFailure('source_forbidden', STAGE, 'credentials in a source URL');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost')) {
    throw new IngestionFailure('source_forbidden', STAGE, 'a local address is not a source');
  }
  if (PRIVATE_V4.test(host)) {
    throw new IngestionFailure('source_forbidden', STAGE, 'a private address is not a source');
  }
  if (isPrivateV6(host)) {
    throw new IngestionFailure('source_forbidden', STAGE, 'a private address is not a source');
  }
}

/**
 * The IPv6 half of the same check.
 *
 * Matching literal prefixes is not enough, because the URL parser canonicalises
 * before we ever see the host: `[::ffff:169.254.169.254]` arrives as
 * `::ffff:a9fe:a9fe`, which is neither dotted-quad for `PRIVATE_V4` nor any of
 * the textual forms a prefix test looks for. So expand to the sixteen bytes and
 * decide on those -- one shape, whatever the literal was written as.
 */
function isPrivateV6(host: string): boolean {
  const bytes = parseV6(host);
  if (!bytes) return false;

  // v4-mapped (::ffff:a.b.c.d) and v4-compatible: judge the embedded address.
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0));
  if (mapped) {
    const v4 = bytes.slice(12).join('.');
    // `::` and `::1` land here as 0.0.0.0 and 0.0.0.1, which `PRIVATE_V4` covers.
    return PRIVATE_V4.test(v4);
  }

  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((bytes[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  return false;
}

/** The sixteen bytes of an IPv6 literal, or null if `host` is not one. */
function parseV6(host: string): number[] | null {
  if (!host.includes(':')) return null;

  const halves = host.split('::');
  if (halves.length > 2) return null;

  const expand = (part: string): number[] | null => {
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (group.length === 0) continue;
      if (group.includes('.')) {
        // A trailing dotted quad, as in `::ffff:127.0.0.1`.
        const quad = group.split('.');
        if (quad.length !== 4) return null;
        for (const octet of quad) {
          if (!/^\d{1,3}$/.test(octet) || Number(octet) > 255) return null;
          out.push(Number(octet));
        }
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const value = Number.parseInt(group, 16);
      out.push(value >> 8, value & 0xff);
    }
    return out;
  };

  const head = expand(halves[0] ?? '');
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : [];
  if (!head || !tail) return null;

  const gap = 16 - head.length - tail.length;
  if (halves.length === 2 ? gap < 0 : gap !== 0) return null;
  return [...head, ...new Array<number>(Math.max(gap, 0)).fill(0), ...tail];
}

export interface FetchedResource {
  url: string;
  contentType: string;
  body: string;
  bytes: number;
  /** Set when a rendering provider produced the body rather than a plain fetch. */
  renderedBy?: 'firecrawl' | 'jina';
  /**
   * The page's declared title when it is known apart from the body: a
   * renderer's metadata, or the `<title>` of the shell the page was fetched
   * as. A plain HTML body carries its own and leaves this unset.
   */
  title?: string;
}

/**
 * Fetches one document, following redirects by hand.
 *
 * By hand because each hop has to be checked: a source that redirects to
 * `http://` or to a private address has just defeated the check on the URL the
 * operator typed. `redirect: 'manual'` is what makes every hop visible.
 */
export interface FetchOptions {
  accept?: string;
  headers?: Record<string, string>;
  maxBytes?: number;
  /**
   * The URL is an operator's own service, named in the environment -- a
   * self-hosted renderer on the private network, say -- not an address that
   * came from a source. It is exempt from the source-address rules (https
   * only, no private ranges), which exist to stop a *source* steering a
   * request; the environment is not a source. In exchange the request may
   * not be redirected at all: an endpoint that answers with a `Location` is
   * treated as unreachable, so the exemption cannot be turned into a hop to
   * somewhere the rules would have refused.
   */
  trustedEndpoint?: boolean;
  /** Only a query endpoint needs anything but GET. */
  method?: 'GET' | 'POST';
  /** Sent as JSON. Ignored unless `method` is POST. */
  body?: unknown;
}

export async function fetchDocument(
  target: string,
  options: FetchOptions = {},
): Promise<FetchedResource> {
  const origin = new URL(target).origin;
  let url = new URL(target);
  let method = options.method ?? 'GET';
  const limit = options.maxBytes ?? MAX_BYTES;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!options.trustedEndpoint) assertFetchable(url);

    const sendBody = method === 'POST' && options.body !== undefined;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          /*
           * Markdown first: documentation hosts that negotiate on `Accept`
           * (Mintlify, Fumadocs, Vercel's docs) return the source page instead
           * of the rendered one, which is smaller, has no chrome to strip and
           * keeps its headings. `web.ts` reads the content type back to decide
           * what the page is.
           */
          accept: options.accept ?? 'text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.5',
          'user-agent': USER_AGENT,
          ...(sendBody ? { 'content-type': 'application/json' } : {}),
          ...credentialSafe(options.headers, url, origin),
        },
        body: sendBody ? JSON.stringify(options.body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: 'no-store',
      });
    } catch {
      throw new IngestionFailure('source_unreachable', STAGE, `${url.host} did not answer`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (options.trustedEndpoint) {
        throw new IngestionFailure('source_unreachable', STAGE, `${url.host} redirected an endpoint call`);
      }
      if (!location) {
        throw new IngestionFailure('source_unreachable', STAGE, 'redirect without a location');
      }
      /*
       * 307 and 308 preserve the method; 301, 302 and 303 turn a POST into a
       * GET, which is what every client does and what the endpoints expect.
       */
      if (method === 'POST' && response.status !== 307 && response.status !== 308) {
        method = 'GET';
      }
      url = new URL(location, url);
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new IngestionFailure('source_forbidden', STAGE, `${url.host} refused the request`);
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      throw new IngestionFailure('source_empty', STAGE, `${url.host} has nothing at that path`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new IngestionFailure('source_unreachable', STAGE, `${url.host} answered ${response.status}`);
    }

    /*
     * Checked before reading, when the server declares it, and again after --
     * `content-length` is a claim, not a guarantee, and a chunked response
     * makes no claim at all.
     */
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > limit) {
      await response.body?.cancel();
      throw new IngestionFailure('source_too_large', STAGE, `${url.host} served too much`);
    }

    const body = await readCapped(response, limit, url);
    return {
      url: url.toString(),
      contentType: (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '',
      body,
      bytes: new TextEncoder().encode(body).length,
    };
  }

  throw new IngestionFailure('source_unreachable', STAGE, 'too many redirects');
}

/**
 * Browser-shaped, and honest about who is asking.
 *
 * A bare product token is what most CDN bot rules match on first, and a 403 at
 * the edge looks exactly like a site that refuses to be indexed. The
 * `Mozilla/5.0 (compatible; ...)` form is the one well-behaved crawlers have
 * used for two decades: it passes the coarse filters while still naming the
 * bot and a contact URL, so an operator who wants us gone can say so.
 */
const USER_AGENT = 'Mozilla/5.0 (compatible; re0-ingestion/1.0; +https://re0.com)';

/**
 * Headers that authenticate us, and must not survive a change of origin.
 *
 * `notion.ts` and `github.ts` both hand a bearer token to `fetchDocument`, and
 * the loop above follows redirects itself. Replaying the header on the next hop
 * is how a redirect -- an open one, a hijacked edge, a vendor's
 * misconfiguration -- turns into a token handed to whoever the `Location`
 * names. Browsers strip credentials on a cross-origin redirect for exactly this
 * reason; following redirects by hand means doing it by hand too.
 */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

function credentialSafe(
  headers: Record<string, string> | undefined,
  url: URL,
  origin: string,
): Record<string, string> {
  if (!headers) return {};
  if (url.origin === origin) return headers;

  const carried: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) carried[name] = value;
  }
  return carried;
}

/** Reads a body, aborting the stream rather than buffering past the cap. */
async function readCapped(response: Response, limit: number, url: URL): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new IngestionFailure('source_too_large', STAGE, `${url.host} served too much`);
    }
    parts.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(joined);
}

/** JSON from an API, with the same guards. */
export async function fetchJson<T>(target: string, options: FetchOptions = {}): Promise<T> {
  const resource = await fetchDocument(target, { ...options, accept: 'application/json' });
  try {
    return JSON.parse(resource.body) as T;
  } catch {
    throw new IngestionFailure('parse_failed', STAGE, `${new URL(target).host} did not return JSON`);
  }
}

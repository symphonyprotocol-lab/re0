/**
 * Object storage behind one seam: Vercel Blob when `BLOB_READ_WRITE_TOKEN`
 * is set (the deployment's own store, architecture.md 1.2), otherwise an
 * S3-compatible bucket configured through `OBJECT_STORE_*`. Callers only see
 * `ObjectStore` and the key layout below; which of the two answers is an
 * environment fact.
 *
 * The S3 half is written by hand: only the portable subset is used -- no
 * vendor-specific API.
 *
 * Signed by hand with SigV4 over `fetch` rather than through an SDK. The four
 * calls below are the whole of architecture.md 7's requirement, every one of
 * them is a single request, and the AWS SDK would add tens of megabytes to a
 * serverless bundle to save about a hundred lines. Nothing here is
 * vendor-specific: path-style addressing and SigV4 are what every S3-compatible
 * implementation accepts.
 */

import { uploadKey } from '@/lib/domain/asset';
import { isVercelBlobConfigured, VercelBlobStore } from './vercel-blob';

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Size and type without the bytes; null when there is no such object. */
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  /**
   * What a browser needs to upload one object straight to the store, so a
   * file never passes through the app (or its request-size limit). The shape
   * depends on the store -- a presigned PUT for S3, a scoped client token for
   * Vercel Blob -- and the wizard knows how to redeem each.
   */
  uploadTicket(
    key: string,
    options: { contentType: string; maxBytes: number; ttlSeconds: number },
  ): Promise<UploadTicket>;
  /** Every object under a prefix, paginated to the end. */
  list(prefix: string): Promise<StoredObject[]>;
}

export interface StoredObject {
  key: string;
  /** Null when the store does not say. */
  uploadedAt: Date | null;
}

export type UploadTicket =
  /** PUT the bytes to this URL. The bucket must allow CORS PUT from the app. */
  | { kind: 'put'; url: string }
  /** `put(pathname, file, { token })` from `@vercel/blob/client`. */
  | { kind: 'vercel-blob'; pathname: string; token: string };

export interface ObjectStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/**
 * `auto` is what R2 expects and what every other implementation tolerates,
 * because the region only ever appears inside the signature's scope string.
 */
const DEFAULT_REGION = 'auto';

const SERVICE = 's3';
const TIMEOUT_MS = 30_000;
const UNSIGNED = 'UNSIGNED-PAYLOAD';

export function objectStoreConfig(): ObjectStoreConfig | null {
  const endpoint = process.env.OBJECT_STORE_ENDPOINT;
  const bucket = process.env.OBJECT_STORE_BUCKET;
  const accessKeyId = process.env.OBJECT_STORE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OBJECT_STORE_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.OBJECT_STORE_REGION ?? DEFAULT_REGION,
  };
}

export function isObjectStoreConfigured(): boolean {
  return isVercelBlobConfigured() || objectStoreConfig() !== null;
}

export function objectStore(): ObjectStore {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (blobToken) return new VercelBlobStore(blobToken);
  const config = objectStoreConfig();
  if (!config) throw new Error('object storage is not configured');
  return new S3Store(config);
}

class S3Store implements ObjectStore {
  constructor(private readonly config: ObjectStoreConfig) {}

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const response = await this.send('PUT', key, { body, contentType });
    if (!response.ok) throw await storeError('put', key, response);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const response = await this.send('GET', key, {});
    if (response.status === 404) return null;
    if (!response.ok) throw await storeError('get', key, response);
    return new Uint8Array(await response.arrayBuffer());
  }

  async head(key: string): Promise<{ size: number; contentType: string | null } | null> {
    const response = await this.send('HEAD', key, {});
    if (response.status === 404) return null;
    if (!response.ok) throw await storeError('head', key, response);
    const size = Number(response.headers.get('content-length') ?? '');
    return {
      size: Number.isFinite(size) ? size : 0,
      contentType: response.headers.get('content-type'),
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', key, {});
    // A delete of something that is already gone has achieved its purpose.
    if (!response.ok && response.status !== 404) throw await storeError('delete', key, response);
  }

  /**
   * A presigned GET, so a download never proxies bytes through the app.
   *
   * Query-signed rather than header-signed: the URL is handed to a browser,
   * which cannot add an `authorization` header of its own.
   */
  async signedUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.presign('GET', key, ttlSeconds);
  }

  async uploadTicket(
    key: string,
    options: { contentType: string; maxBytes: number; ttlSeconds: number },
  ): Promise<UploadTicket> {
    /* A presigned PUT cannot bind the size or the type; the create step
       confirms both against the object once it is there. */
    return { kind: 'put', url: await this.presign('PUT', key, options.ttlSeconds) };
  }

  private async presign(method: 'GET' | 'PUT', key: string, ttlSeconds: number): Promise<string> {
    const url = this.url(key);
    const now = new Date();
    const stamp = amzDate(now);
    const scope = `${stamp.slice(0, 8)}/${this.config.region}/${SERVICE}/aws4_request`;

    url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
    url.searchParams.set('X-Amz-Credential', `${this.config.accessKeyId}/${scope}`);
    url.searchParams.set('X-Amz-Date', stamp);
    url.searchParams.set('X-Amz-Expires', String(Math.max(1, Math.min(604_800, ttlSeconds))));
    url.searchParams.set('X-Amz-SignedHeaders', 'host');

    const canonical = canonicalRequest(method, url, { host: url.host }, UNSIGNED);
    const signature = await sign(this.config, stamp, await sha256Hex(canonical));
    url.searchParams.set('X-Amz-Signature', signature);
    return url.toString();
  }

  /**
   * ListObjectsV2, the one listing call every S3 implementation offers. The
   * response is XML; the two elements read are `Key` and `LastModified`, and
   * a continuation token is followed until the store says it is done.
   */
  async list(prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    let continuation: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (continuation) query['continuation-token'] = continuation;
      const response = await this.send('GET', '', { query });
      if (!response.ok) throw await storeError('list', prefix, response);
      const body = await response.text();
      for (const match of body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(match[1] ?? '')?.[1];
        const modified = /<LastModified>([^<]*)<\/LastModified>/.exec(match[1] ?? '')?.[1];
        if (!key) continue;
        const stamp = modified ? new Date(decodeXml(modified)) : null;
        objects.push({
          key: decodeXml(key),
          uploadedAt: stamp && !Number.isNaN(stamp.getTime()) ? stamp : null,
        });
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(body);
      continuation = truncated
        ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(body)?.[1]
        : undefined;
      if (continuation) continuation = decodeXml(continuation);
    } while (continuation);
    return objects;
  }

  private url(key: string, query?: Record<string, string>): URL {
    const path = key
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const url = new URL(`${this.config.endpoint}/${this.config.bucket}/${path}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url;
  }

  private async send(
    method: string,
    key: string,
    options: { body?: Uint8Array; contentType?: string; query?: Record<string, string> },
  ): Promise<Response> {
    const url = this.url(key, options.query);
    const now = new Date();
    const stamp = amzDate(now);
    const payloadDigest = options.body ? await sha256HexBytes(options.body) : await sha256Hex('');

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadDigest,
      'x-amz-date': stamp,
    };
    if (options.contentType) headers['content-type'] = options.contentType;

    const canonical = canonicalRequest(method, url, headers, payloadDigest);
    const signature = await sign(this.config, stamp, await sha256Hex(canonical));
    const signed = Object.keys(headers).sort().join(';');
    const scope = `${stamp.slice(0, 8)}/${this.config.region}/${SERVICE}/aws4_request`;

    const requestHeaders = new Headers(headers);
    requestHeaders.delete('host');
    requestHeaders.set(
      'authorization',
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    );

    return fetch(url, {
      method,
      headers: requestHeaders,
      body: options.body ? (options.body.slice().buffer as ArrayBuffer) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  }
}

/**
 * The store's own error: the status, the S3 error code, and never the body.
 *
 * An S3 error body echoes the key and sometimes the bucket policy; neither
 * belongs in a message that may reach a screen. The `<Code>` element is a
 * different thing -- a fixed vocabulary (`NoSuchBucket`, `AccessDenied`,
 * `SignatureDoesNotMatch`) that carries no content of ours -- and it is the
 * difference between "404" and "the bucket does not exist", which is the whole
 * of what someone reading this needs to know.
 */
async function storeError(operation: string, key: string, response: Response): Promise<Error> {
  let code = '';
  try {
    const body = await response.text();
    code = /<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1] ?? '';
  } catch {
    /* A body we cannot read is not worth failing differently over. */
  }
  const detail = code ? `${response.status} ${code}` : String(response.status);
  return new Error(`object store ${operation} failed with ${detail} for ${key}`);
}

/** The five entities S3 escapes in XML text. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ sigv4 */

const encoder = new TextEncoder();

function amzDate(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function sha256HexBytes(value: Uint8Array): Promise<string> {
  const copy = value.slice();
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer)));
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    key.slice().buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', material, encoder.encode(value)));
}

/**
 * The canonical request of SigV4.
 *
 * The URI is taken from `url.pathname`, which is already percent-encoded by
 * `URL` -- re-encoding it would double every escape and produce a signature
 * that matches nothing.
 */
function canonicalRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadDigest: string,
): string {
  const query = [...url.searchParams.entries()]
    .map(([name, value]) => [encodeRfc3986(name), encodeRfc3986(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${(headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');

  return [
    method,
    url.pathname,
    query,
    canonicalHeaders,
    names.join(';'),
    payloadDigest,
  ].join('\n');
}

/** `encodeURIComponent` leaves `!'()*` alone; SigV4 requires them escaped. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function sign(
  config: ObjectStoreConfig,
  stamp: string,
  canonicalDigest: string,
): Promise<string> {
  const date = stamp.slice(0, 8);
  const scope = `${date}/${config.region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, canonicalDigest].join('\n');

  let key: Uint8Array = encoder.encode(`AWS4${config.secretAccessKey}`);
  for (const part of [date, config.region, SERVICE, 'aws4_request']) {
    key = await hmac(key, part);
  }
  return hex(await hmac(key, stringToSign));
}

/* ------------------------------------------------------------------- keys */

/**
 * The key layout of architecture.md 7.
 *
 * Object keys never carry user input verbatim, which is why every one of these
 * is built from ids rather than from titles, slugs or URLs.
 */
export const objectKeys = {
  snapshot: (assetId: string, operationId: string, extension: string): string =>
    `sources/platform/${assetId}/${operationId}/snapshot.${extension}`,
  normalized: (assetId: string, versionId: string, documentId: string): string =>
    `normalized/${assetId}/${versionId}/${documentId}.json`,
  documentManifest: (assetId: string, versionId: string): string =>
    `manifests/${assetId}/${versionId}/documents.json`,
  vectorManifest: (assetId: string, versionId: string): string =>
    `manifests/${assetId}/${versionId}/vectors.json`,
  quarantine: (operationId: string, objectId: string): string =>
    `quarantine/${operationId}/${objectId}`,
  /** Uploaded files; the layout is fixed in `lib/domain/asset.ts`. */
  upload: uploadKey,
};

/**
 * Fetched sources as data (rebuild-proposal.md 2.1, 2.2): which URLs a page,
 * a website or a repository may be, and the domain-claim rules -- the
 * challenge, where each check looks for it, and which hosts a verified
 * domain covers. No network here.
 */
import { KNOWLEDGE_URL_MAX } from '@/lib/constants';

export type SourceUrlError = 'url' | 'github_url';

const BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal', 'metadata.goog']);
const PRIVATE_V4 =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)/;

/**
 * Whether a host may be fetched at all: not a local or private address, by
 * name or literal (the address half of the old `http.ts` SSRF guard; the
 * fetcher checks every redirect hop with this too).
 */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  if (PRIVATE_V4.test(host)) return false;
  if (host.includes(':')) {
    /* IPv6 literals: loopback, unspecified, link-local, unique-local and v4-mapped private ranges. */
    if (host === '::' || host === '::1' || /^fe[89ab]/.test(host) || /^f[cd]/.test(host)) return false;
    const mapped = /^::ffff:(.+)$/.exec(host);
    if (mapped) {
      const tail = mapped[1]!;
      if (tail.includes('.')) return !PRIVATE_V4.test(tail);
      const [hi, lo] = tail.split(':').map((part) => Number.parseInt(part, 16));
      if (hi === undefined || lo === undefined || Number.isNaN(hi) || Number.isNaN(lo)) return false;
      return !PRIVATE_V4.test(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
  }
  /* A bare number or a single label is not a public site. */
  return host.includes('.') || host.includes(':');
}

/** A page or website URL: http(s), no credentials, a public host. The fragment is dropped. */
export function parseWebUrl(raw: unknown): URL | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > KNOWLEDGE_URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || !isPublicHost(url.hostname)) return null;
  url.hash = '';
  return url;
}

export interface RepositoryRef {
  owner: string;
  name: string;
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * `https://github.com/owner/name`, with or without `.git`, a trailing path
 * (`/tree/main/docs`) or `www.`; also a bare `owner/name`. The default
 * branch is always what is read.
 */
export function parseGithubRepo(raw: unknown): RepositoryRef | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text || text.length > KNOWLEDGE_URL_MAX) return null;
  let parts: string[];
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    parts = text.split('/');
  } else {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || (host !== 'github.com' && host !== 'www.github.com')) return null;
    parts = url.pathname.split('/').filter(Boolean);
  }
  const owner = parts[0];
  const name = parts[1]?.replace(/\.git$/i, '');
  if (!owner || !name || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(name) || name === '.' || name === '..') return null;
  return { owner, name };
}

export function repositoryUrl(ref: RepositoryRef): string {
  return `https://github.com/${ref.owner}/${ref.name}`;
}

/* ------------------------------------------------------------ domain claims */

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** What the user typed, as a domain: lower case, no scheme, path, port or trailing dot (prototype `domain-form`). */
export function normalizeDomain(raw: unknown): string | null {
  let text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  text = text.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  return DOMAIN.test(text) && isPublicHost(text) ? text : null;
}

/** The TXT record name the DNS check reads (prototype: `Host: _re0.<domain>`). */
export function dnsRecordName(domain: string): string {
  return `_re0.${domain}`;
}

/** The file the well-known check fetches. */
export function wellKnownUrl(domain: string): string {
  return `https://${domain}/.well-known/re0-verification.txt`;
}

/** The value both checks look for: `re0-verification=<token>`. */
export function challengeValue(token: string): string {
  return `re0-verification=${token}`;
}

/** A TXT record set matches when any record, its strings joined, is the challenge. */
export function txtMatches(records: readonly (readonly string[])[], challenge: string): boolean {
  return records.some((record) => record.join('').trim() === challenge);
}

/** A well-known file matches when one of its lines is the challenge. */
export function wellKnownMatches(body: string, challenge: string): boolean {
  return body.split(/\r?\n/).some((line) => line.trim() === challenge);
}

/**
 * A verified domain covers itself and its subdomains: proving
 * `example.com` makes `docs.example.com` crawlable, not the reverse.
 */
export function domainCovers(domain: string, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === domain || host.endsWith(`.${domain}`);
}

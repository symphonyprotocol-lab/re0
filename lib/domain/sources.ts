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
  /* `localhost.` is `localhost`: a fully qualified name must not slip past the names below. */
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
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
  /** The branch, tag or commit to read; absent: the repository's default branch. */
  ref?: string;
  /** The directory (or single file) inside it to read, no slash at either end; absent: the whole tree. */
  path?: string;
  /**
   * `/tree/a/b/c` names the ref and the path in one run of segments: the ref
   * might be `a`, `a/b` or `a/b/c`. Parsing takes the first segment as the
   * ref; `settleTreeRef` corrects it against the repository's refs.
   */
  refUnsettled?: boolean;
}

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** A ref or path segment GitHub could have: no empty, `.` or `..` part, no control characters. */
function validSegment(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..' && !/[\u0000-\u001f\u007f\\]/.test(segment);
}

/**
 * `https://github.com/owner/name`, with or without `.git` or `www.`; also a
 * bare `owner/name`. `/tree/<ref>` reads that branch, tag or commit instead
 * of the default branch, and `/tree/<ref>/<path>` (or `/blob/<ref>/<path>`)
 * only that directory or file. A ref containing `/` may be written with it
 * encoded (`feature%2Fdocs`), which is how `repositoryUrl` writes it back;
 * written plainly it is settled against the repository's refs when the
 * source is checked (`refUnsettled`). Any other trailing path (`/issues`,
 * `/pulls`) reads the whole repository as before.
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
  const base: RepositoryRef = { owner, name };
  if ((parts[2] !== 'tree' && parts[2] !== 'blob') || parts.length < 4) return base;
  const raws = parts.slice(3);
  const segments = raws.map(decodeSegment);
  if (segments.some((segment) => segment === null)) return null;
  const [ref, ...rest] = segments as string[];
  /* The ref may carry an encoded `/`; a path segment may not (it would be two segments). */
  if (!ref || !ref.split('/').every(validSegment) || !rest.every((segment) => validSegment(segment) && !segment.includes('/'))) return null;
  const scoped: RepositoryRef = { ...base, ref };
  if (rest.length > 0) scoped.path = rest.join('/');
  /* Plain `a/b/...` could be ref `a/b`; an encoded slash, a commit SHA or a lone ref cannot be read two ways. */
  if (rest.length > 0 && !raws[0]!.toLowerCase().includes('%2f') && !COMMIT_SHA.test(ref)) scoped.refUnsettled = true;
  return scoped;
}

/**
 * Splits `/tree/<segments>` between ref and path: the longest leading run of
 * segments that names one of `refs` (branch or tag names, without
 * `refs/heads/`), or else the first segment alone -- what GitHub's own
 * `/tree/` pages do with a ref they cannot match.
 */
export function settleTreeRef(ref: RepositoryRef, refs: readonly string[]): RepositoryRef {
  if (!ref.refUnsettled || !ref.ref) return ref;
  const segments = [...ref.ref.split('/'), ...(ref.path ? ref.path.split('/') : [])];
  const known = new Set(refs);
  let take = ref.ref.split('/').length;
  for (let count = segments.length; count >= 1; count -= 1) {
    if (known.has(segments.slice(0, count).join('/'))) {
      take = count;
      break;
    }
  }
  const settled: RepositoryRef = { owner: ref.owner, name: ref.name, ref: segments.slice(0, take).join('/') };
  if (take < segments.length) settled.path = segments.slice(take).join('/');
  return settled;
}

/**
 * The canonical URL a source is stored as and refreshed from. A ref with `/`
 * is written encoded, so reading it back names the same ref without asking
 * GitHub again.
 */
export function repositoryUrl(ref: RepositoryRef): string {
  const base = `https://github.com/${ref.owner}/${ref.name}`;
  if (!ref.ref) return base;
  const path = ref.path ? `/${ref.path.split('/').map(encodeURIComponent).join('/')}` : '';
  return `${base}/tree/${encodeURIComponent(ref.ref)}${path}`;
}

/** A repository source's title: `owner/name`, then the directory read and the ref when one was named. */
export function repositoryTitle(fullName: string, ref: Pick<RepositoryRef, 'ref' | 'path'>): string {
  return `${fullName}${ref.path ? `/${ref.path}` : ''}${ref.ref ? ` @ ${ref.ref}` : ''}`;
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

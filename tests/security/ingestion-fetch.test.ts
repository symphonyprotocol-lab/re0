/**
 * What ingestion is allowed to fetch. architecture.md 15.1.
 *
 * A platform asset's location is typed by an operator and then followed --
 * through redirects, through a sitemap, through a crawl. Every one
 * of those is a URL our server requests on someone else's say-so, which makes
 * this the classic server-side request forgery surface: the interesting target
 * is not the open internet but the metadata endpoint and the private network
 * the app itself sits in.
 *
 * `assertFetchable` is the literal-address half of the defence and the half a
 * test can hold still. It cannot stop a public hostname that resolves to a
 * private address -- that needs resolution-time pinning the platform's `fetch`
 * does not expose -- so the deployment restricts egress as well. This checks
 * that the half we own does not regress.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { assertFetchable, fetchDocument } from '@/lib/infrastructure/connectors/http';
import { IngestionFailure } from '@/lib/domain/ingestion';

function refusalOf(url: string): string {
  try {
    assertFetchable(new URL(url));
    return 'allowed';
  } catch (error) {
    return error instanceof IngestionFailure ? error.code : 'unexpected';
  }
}

describe('what ingestion may fetch', () => {
  it('allows an ordinary public https URL', () => {
    expect(refusalOf('https://nextjs.org/docs')).toBe('allowed');
    expect(refusalOf('https://raw.githubusercontent.com/o/r/sha/README.md')).toBe('allowed');
  });

  it('refuses plaintext http, whatever the host', () => {
    // A platform asset is republished under re0's own name; following http
    // makes the content whatever the nearest network can rewrite it to.
    expect(refusalOf('http://nextjs.org/docs')).toBe('source_forbidden');
  });

  it('refuses the cloud metadata endpoints', () => {
    expect(refusalOf('https://169.254.169.254/latest/meta-data/')).toBe('source_forbidden');
    expect(refusalOf('https://metadata.google.internal/computeMetadata/v1/')).toBe(
      'source_forbidden',
    );
  });

  it('refuses loopback and private ranges by literal address', () => {
    for (const host of [
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://sub.localhost/x',
      'https://10.0.0.5/x',
      'https://192.168.1.1/x',
      'https://172.16.0.1/x',
      'https://172.31.255.1/x',
      'https://100.64.0.1/x',
      'https://[::1]/x',
      'https://[fe80::1]/x',
      'https://[fd00::1]/x',
    ]) {
      expect(refusalOf(host)).toBe('source_forbidden');
    }
  });

  /**
   * The URL parser canonicalises an IPv6 literal before the check sees it, so
   * `[::ffff:169.254.169.254]` arrives as `::ffff:a9fe:a9fe` -- neither a
   * dotted quad for the v4 test nor any of the textual prefixes a literal
   * comparison looks for. Every one of these reached the metadata endpoint.
   */
  it('refuses private addresses written as IPv6 literals, in every form', () => {
    for (const host of [
      'https://[::ffff:169.254.169.254]/latest/meta-data/',
      'https://[::ffff:127.0.0.1]/x',
      'https://[::ffff:10.0.0.5]/x',
      'https://[::ffff:192.168.1.1]/x',
      'https://[0:0:0:0:0:ffff:7f00:1]/x',
      'https://[0:0:0:0:0:0:0:1]/x',
      'https://[::]/x',
      'https://[febf::1]/x',
      'https://[fdff::1]/x',
    ]) {
      expect(refusalOf(host), host).toBe('source_forbidden');
    }
  });

  it('leaves public IPv6 addresses alone', () => {
    expect(refusalOf('https://[2606:4700:4700::1111]/x')).toBe('allowed');
    expect(refusalOf('https://[2001:db8::1]/x')).toBe('allowed');
    expect(refusalOf('https://[::ffff:8.8.8.8]/x')).toBe('allowed');
  });

  it('leaves public addresses that only look private alone', () => {
    // 172.32 is outside the private block, and 11.x is public space.
    expect(refusalOf('https://172.32.0.1/x')).toBe('allowed');
    expect(refusalOf('https://11.0.0.1/x')).toBe('allowed');
  });

  it('refuses credentials smuggled into the URL', () => {
    expect(refusalOf('https://user:secret@example.com/x')).toBe('source_forbidden');
  });

  it('refuses non-http schemes outright', () => {
    expect(refusalOf('file:///etc/passwd')).toBe('source_forbidden');
    expect(refusalOf('ftp://example.com/x')).toBe('source_forbidden');
  });
});

/**
 * Credentials and redirects.
 *
 * `fetchDocument` follows redirects by hand, which means it also has to strip
 * by hand what a browser strips for it. `notion.ts` and `github.ts` both pass a
 * bearer token in, and a redirect is the one place that token can be handed to
 * a host we never meant to talk to.
 */
describe('credentials across a redirect', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Records every request, answering the first with a redirect. */
  function redirectingTo(location: string) {
    const seen: { url: string; authorization: string | null; method: string }[] = [];
    globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        authorization: headers.get('authorization'),
        method: init?.method ?? 'GET',
      });
      if (seen.length === 1) {
        return new Response(null, { status: 302, headers: { location } });
      }
      return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;
    return seen;
  }

  it('keeps the token on a same-origin redirect', async () => {
    const seen = redirectingTo('https://api.notion.com/v1/other');
    await fetchDocument('https://api.notion.com/v1/pages/x', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.authorization).toBe('Bearer secret-token');
  });

  it('drops the token when the redirect changes origin', async () => {
    const seen = redirectingTo('https://evil.example.com/collect');
    await fetchDocument('https://api.notion.com/v1/pages/x', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.url).toContain('evil.example.com');
    expect(seen[1]?.authorization).toBeNull();
  });

  it('drops it on a redirect to a different host of the same vendor too', async () => {
    // Same registrable domain is still a different origin, and the token is
    // scoped to the origin it was issued for, not to the company.
    const seen = redirectingTo('https://objects.notion.com/blob');
    await fetchDocument('https://api.notion.com/v1/pages/x', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(seen[1]?.authorization).toBeNull();
  });

  it('turns a redirected POST into a GET unless the status preserves it', async () => {
    const seen = redirectingTo('https://api.notion.com/v1/moved');
    await fetchDocument('https://api.notion.com/v1/databases/x/query', {
      method: 'POST',
      body: { page_size: 100 },
    });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[1]?.method).toBe('GET');
  });
});

/**
 * An operator's own endpoint -- a self-hosted renderer on the private network
 * -- is exempt from the source-address rules, because the environment is not
 * a source. The exemption must not become a way around them: such a call may
 * not be redirected anywhere, so a private http endpoint cannot be used as a
 * hop to an address the rules would have refused.
 */
describe('a trusted endpoint', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('may be a private http address, but is never followed through a redirect', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: URL | RequestInfo) => {
      seen.push(String(input));
      if (seen.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } });
      }
      return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } });
    }) as typeof fetch;

    await expect(
      fetchDocument('http://10.0.0.7:3002/v2/scrape', { trustedEndpoint: true }),
    ).rejects.toMatchObject({ code: 'source_unreachable' });
    expect(seen).toEqual(['http://10.0.0.7:3002/v2/scrape']);
  });

  it('is an opt-in: the same address as a source is still refused before any request', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('x');
    }) as typeof fetch;
    await expect(fetchDocument('http://10.0.0.7:3002/v2/scrape')).rejects.toMatchObject({
      code: 'source_forbidden',
    });
    expect(called).toBe(false);
  });
});

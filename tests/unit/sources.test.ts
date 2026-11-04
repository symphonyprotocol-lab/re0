/**
 * Step 2's pure rules: which URLs a page, website or repository may be; the
 * domain-claim challenge and coverage; HTML to Markdown; the holds and
 * prices of 8.2; repository files cut by line; audio cut into pieces.
 */
import { describe, expect, it } from 'vitest';
import {
  challengeValue,
  dnsRecordName,
  domainCovers,
  isPublicHost,
  normalizeDomain,
  parseGithubRepo,
  parseWebUrl,
  txtMatches,
  wellKnownMatches,
  wellKnownUrl,
} from '@/lib/domain/sources';
import { assemble, chunkLines, cleanFolderName, cleanTitle, holdFor } from '@/lib/domain/knowledge';
import { htmlLinks, htmlToMarkdown } from '@/lib/infra/connectors/html';
import { basePath, inScope, pageKey, parseSitemap } from '@/lib/infra/connectors/web';
import { selectPaths } from '@/lib/infra/connectors/github';
import { audioPieces } from '@/lib/infra/ai/transcription';
import { simulatedFailureFor } from '@/lib/infra/connectors/failure';

describe('source URLs', () => {
  it('reads GitHub repository URLs in their common shapes', () => {
    expect(parseGithubRepo('https://github.com/vercel/next.js')).toEqual({ owner: 'vercel', name: 'next.js' });
    expect(parseGithubRepo('https://github.com/acme/handbook.git')).toEqual({ owner: 'acme', name: 'handbook' });
    expect(parseGithubRepo('https://www.github.com/acme/handbook/tree/main/docs')).toEqual({ owner: 'acme', name: 'handbook' });
    expect(parseGithubRepo('acme/handbook')).toEqual({ owner: 'acme', name: 'handbook' });
    expect(parseGithubRepo('https://github.com/acme')).toBeNull();
    expect(parseGithubRepo('https://gitlab.com/acme/handbook')).toBeNull();
    expect(parseGithubRepo('https://github.com/acme/..')).toBeNull();
  });

  it('accepts public http(s) pages and refuses local, private and credentialed ones', () => {
    expect(parseWebUrl('https://docs.example.com/guide#intro')?.href).toBe('https://docs.example.com/guide');
    expect(parseWebUrl('http://example.org')?.href).toBe('http://example.org/');
    for (const bad of ['ftp://example.org', 'https://user:pw@example.org', 'http://localhost:3000', 'http://127.0.0.1', 'http://10.1.2.3', 'http://192.168.0.1', 'http://169.254.169.254', 'http://[::1]/', 'http://[::ffff:a9fe:a9fe]/', 'http://intranet', 'http://localhost./', 'http://metadata.google.internal./computeMetadata/v1/', 'nope']) {
      expect(parseWebUrl(bad), bad).toBeNull();
    }
    expect(isPublicHost('metadata.google.internal')).toBe(false);
    expect(isPublicHost('localhost.')).toBe(false);
    expect(isPublicHost('api.internal.')).toBe(false);
    expect(isPublicHost('example.com')).toBe(true);
  });
});

describe('domain claims', () => {
  it('normalizes what is typed into a bare domain', () => {
    expect(normalizeDomain(' https://Docs.Example.com/path?q=1 ')).toBe('docs.example.com');
    expect(normalizeDomain('example.com.')).toBe('example.com');
    expect(normalizeDomain('example.com:8080')).toBe('example.com');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('exa mple.com')).toBeNull();
    expect(normalizeDomain('10.0.0.1')).toBeNull();
  });

  it('puts the challenge where the prototype says, and matches it exactly', () => {
    const challenge = challengeValue('abc123');
    expect(challenge).toBe('re0-verification=abc123');
    expect(dnsRecordName('example.com')).toBe('_re0.example.com');
    expect(wellKnownUrl('example.com')).toBe('https://example.com/.well-known/re0-verification.txt');
    expect(txtMatches([['v=spf1 -all'], ['re0-verification=', 'abc123']], challenge)).toBe(true);
    expect(txtMatches([['re0-verification=abc1234']], challenge)).toBe(false);
    expect(wellKnownMatches('# re0\r\nre0-verification=abc123\r\n', challenge)).toBe(true);
    expect(wellKnownMatches('<p>re0-verification=abc123</p>', challenge)).toBe(false);
  });

  it('covers the domain and its subdomains, not its parent or look-alikes', () => {
    expect(domainCovers('example.com', 'example.com')).toBe(true);
    expect(domainCovers('example.com', 'docs.example.com')).toBe(true);
    expect(domainCovers('docs.example.com', 'example.com')).toBe(false);
    expect(domainCovers('example.com', 'badexample.com')).toBe(false);
  });
});

describe('web pages', () => {
  it('keeps the main content as Markdown and drops the chrome', () => {
    const markdown = htmlToMarkdown(`<html><head><script>alert(1)</script></head><body>
      <header>Site header</header><nav>Menu</nav>
      <main><h1>Guide &amp; notes</h1><p>First   paragraph with <strong>bold</strong> text and enough words to count as content for the page.</p>
      <ul><li>One</li><li>Two</li></ul><pre><code>const a = 1;\n  const b = 2;</code></pre>
      <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Team</td><td>$10</td></tr></table></main>
      <footer>Footer</footer></body></html>`);
    expect(markdown).toContain('# Guide & notes');
    expect(markdown).toContain('First paragraph with **bold** text');
    expect(markdown).toContain('- One');
    expect(markdown).toContain('```\nconst a = 1;\n  const b = 2;\n```');
    expect(markdown).toContain('| Team | $10 |');
    expect(markdown).not.toMatch(/Site header|Menu|Footer|alert/);
  });

  it('finds in-site links and sitemap pages within the entry path', () => {
    const entry = new URL('https://docs.example.com/guide/');
    expect(basePath(entry)).toBe('/guide/');
    expect(basePath(new URL('https://docs.example.com/guide/index.html'))).toBe('/guide/');
    expect(inScope(new URL('https://docs.example.com/guide/install'), entry)).toBe(true);
    expect(inScope(new URL('https://docs.example.com/blog'), entry)).toBe(false);
    expect(inScope(new URL('https://cdn.example.com/guide/x'), entry)).toBe(false);
    expect(inScope(new URL('https://docs.example.com/guide/logo.png'), entry)).toBe(false);
    expect(pageKey(new URL('https://docs.example.com/guide/?utm_source=x#top'))).toBe(pageKey(new URL('https://docs.example.com/guide')));
    const links = htmlLinks('<a href="install">i</a><a href="mailto:x@y.z">m</a><a href="#top">t</a><a href="https://a.example/x#y">a</a>', entry);
    expect(links.map((url) => url.href)).toEqual(['https://docs.example.com/guide/install', 'https://a.example/x']);
    const sitemap = parseSitemap('<sitemapindex><sitemap><loc>https://docs.example.com/s1.xml</loc></sitemap><sitemap><loc>https://docs.example.com/s2.xml.gz</loc></sitemap></sitemapindex>', entry);
    expect(sitemap.sitemaps.map((url) => url.pathname)).toEqual(['/s1.xml']);
  });
});

describe('repositories', () => {
  it('reads documentation first, then source, skipping vendored, lock and binary files', () => {
    const paths = selectPaths([
      { path: 'src/deep/a.ts', size: 10 },
      { path: 'README.md', size: 10 },
      { path: 'docs/guide.md', size: 10 },
      { path: 'node_modules/x/index.js', size: 10 },
      { path: 'package-lock.json', size: 10 },
      { path: 'dist/app.min.js', size: 10 },
      { path: 'logo.png', size: 10 },
      { path: 'LICENSE', size: 10 },
      { path: 'big.md', size: 10 * 1024 * 1024 },
    ]);
    expect(paths).toEqual(['README.md', 'docs/guide.md', 'src/deep/a.ts']);
  });

  it('cuts a file by lines and cites the line each passage starts on', () => {
    const body = ['# Title', '', 'Intro.', '', '## Install', '', 'Run it.', '', '## Limits', '', 'Ten seats.'].join('\n');
    const chunks = chunkLines('docs/guide.md', body);
    expect(chunks.map((chunk) => chunk.locator)).toEqual([
      { path: 'docs/guide.md', line: 1, heading: 'Title' },
      { path: 'docs/guide.md', line: 5, heading: 'Title › Install' },
      { path: 'docs/guide.md', line: 9, heading: 'Title › Limits' },
    ]);
    const code = chunkLines('src/a.ts', Array.from({ length: 600 }, (_, n) => `const value${n} = compute(${n}); // line ${n + 1}`).join('\n'));
    expect(code.length).toBeGreaterThan(1);
    expect(code[1]!.locator.line).toBeGreaterThan(1);
    expect(code[1]!.content.startsWith(`const value${code[1]!.locator.line! - 1} `)).toBe(true);
  });

  it('stores files untrimmed so line numbers hold, and records where each sits', () => {
    const { content, children } = assemble([
      { text: '\n\nline three\n', locator: { path: 'a.md' }, byLines: true, child: { label: 'a.md', path: 'a.md' } },
      { text: '  b  ', locator: { path: 'b.md' }, child: { label: 'b.md', path: 'b.md' } },
    ]);
    expect(content).toBe('\n\nline three\n\nb');
    expect(children.map((child) => content.slice(child.offset, child.offset + child.length))).toEqual(['\n\nline three', 'b']);
  });
});

describe('holds and prices (8.2)', () => {
  it('starts with the same refundable balance check for every kind', () => {
    for (const kind of ['document', 'page', 'github', 'site', 'text', 'audio'] as const) expect(holdFor(kind)).toBe(1);
  });

  it('cleans display names and folder names', () => {
    expect(cleanTitle('  a   b ')).toBe('a b');
    expect(cleanTitle('x'.repeat(201))).toBeNull();
    expect(cleanFolderName('ＡＢＣ')).toBe('ABC');
    expect(cleanFolderName('x'.repeat(40))).toHaveLength(40);
    expect(cleanFolderName('x'.repeat(41))).toBeNull();
  });
});

describe('audio pieces', () => {
  it('cuts MP3 at frame boundaries and WAV on samples with a fresh header each', () => {
    const mp3 = new Uint8Array(50_000);
    for (let at = 0; at + 4 <= mp3.length; at += 417) mp3.set([0xff, 0xfb, 0x90, 0x64], at);
    const pieces = audioPieces(mp3, 'mp3', 20_000);
    expect(pieces.length).toBe(3);
    expect(pieces.every((piece) => piece.bytes.length <= 20_000)).toBe(true);
    expect(pieces.reduce((sum, piece) => sum + piece.bytes.length, 0)).toBe(50_000);
    for (const piece of pieces.slice(1)) expect([piece.bytes[0], piece.bytes[1]]).toEqual([0xff, 0xfb]);

    const data = 16_000 * 3;
    const wav = new Uint8Array(44 + data);
    const view = new DataView(wav.buffer);
    wav.set([0x52, 0x49, 0x46, 0x46], 0);
    view.setUint32(4, 36 + data, true);
    wav.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    wav.set([0x64, 0x61, 0x74, 0x61], 36);
    view.setUint32(40, data, true);
    const wavPieces = audioPieces(wav, 'wav', 20_000);
    expect(wavPieces.length).toBe(3);
    expect(wavPieces.reduce((sum, piece) => sum + (piece.seconds ?? 0), 0)).toBeCloseTo(3, 5);
    for (const piece of wavPieces) expect(String.fromCharCode(...piece.bytes.subarray(0, 4))).toBe('RIFF');
    expect(audioPieces(new Uint8Array(10), 'm4a', 5)).toHaveLength(1);
  });
});

describe('the failure switch', () => {
  it('is on in tests and off in production builds', () => {
    expect(simulatedFailureFor('报告-失败.pdf')).toBe(true);
    expect(simulatedFailureFor('report.pdf', null)).toBe(false);
    const environment = process.env as Record<string, string | undefined>;
    const previous = environment.NODE_ENV;
    environment.NODE_ENV = 'production';
    try {
      expect(simulatedFailureFor('报告-失败.pdf')).toBe(false);
    } finally {
      environment.NODE_ENV = previous;
    }
  });
});

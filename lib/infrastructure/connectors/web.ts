/**
 * Websites, `llms.txt` indexes and OpenAPI documents.
 *
 * Three source types share one connector because they differ only in how the
 * list of documents is discovered: a crawl finds it by following links, an
 * `llms.txt` is handed the list, and an OpenAPI document is a list of one.
 * Everything after discovery -- fetching, capping, ordering -- is identical,
 * and duplicating it three times is how the three would drift apart.
 */
import {
  documentFormat,
  htmlTitle,
  INGESTION_LIMITS,
  IngestionFailure,
  isRenderedShell,
  parseSourceConfig,
} from '@/lib/domain/ingestion';
import { fetchDocument, type FetchedResource } from './http';
import { pageRenderer } from './render';
import type { FetchedFile, SourceSnapshot } from './types';

export type WebSourceType = 'website' | 'llms_txt' | 'openapi';

/** How many sitemap files one crawl reads. An index with more is a whole site. */
const MAX_SITEMAPS = 10;

export async function fetchWebSnapshot(input: {
  type: WebSourceType;
  location: string;
  /** Website/llms_txt: how many child-page or nested-index levels to follow. */
  indexDepth?: number;
}): Promise<SourceSnapshot> {
  const entry = new URL(input.location);
  const indexDepth = boundedDepth(input.indexDepth);
  const files =
    input.type === 'openapi'
      ? [await fetchOne(entry.toString(), entry)]
      : input.type === 'llms_txt'
        ? await fetchIndex(entry, indexDepth)
        : await crawl(entry, indexDepth);

  if (files.length === 0) {
    throw new IngestionFailure('source_empty', 'discover-parse', 'nothing was fetched');
  }

  return {
    files,
    config: parseSourceConfig(''),
    /* A page has no revision of its own; the snapshot digest is the identity. */
    revision: null,
    lastModifiedAt: null,
    /*
     * A crawled site says nothing machine-readable about its licence. Trust
     * treats that as absent rather than guessing from a footer.
     */
    hasLicense: false,
    stale: false,
  };
}

/** Defense in depth for internal callers that did not use the form parser. */
function boundedDepth(value: number | undefined): number {
  if (!Number.isInteger(value)) return 0;
  return Math.min(Math.max(value ?? 0, 0), INGESTION_LIMITS.maxCrawlDepth);
}

async function fetchOne(target: string, entry: URL): Promise<FetchedFile> {
  return toFile(await fetchPage(target), entry);
}

/**
 * One page, as the site serves it -- or, failing that, as a browser would.
 *
 * The plain fetch comes first, always: it is free, and most documentation
 * sites answer it (many with Markdown). The rendering fallback is reached in
 * exactly two cases. A refusal (403) at the edge, where a browser-shaped
 * request is the difference; and an application shell -- markup with
 * scripts and no text -- where the content only exists once JavaScript has
 * run. Anything else that fails is a failure of the source, not of how it
 * was asked.
 *
 * Without a configured renderer a shell is `source_unrendered`, its own
 * code rather than `parse_failed`, so the console can count how many
 * sources need a browser before deciding whether to pay for one.
 */
async function fetchPage(target: string): Promise<FetchedResource> {
  let resource: FetchedResource;
  try {
    resource = await fetchDocument(target, { maxBytes: INGESTION_LIMITS.maxDocumentBytes });
  } catch (error) {
    if (error instanceof IngestionFailure && error.code === 'source_forbidden') {
      /*
       * A refusal of the address itself (private range, plain http) throws
       * the same code and must not be laundered through a renderer; the
       * renderer re-checks the address and throws again, and the original
       * refusal is what the operator sees.
       */
      const rendered = await renderIfConfigured(target).catch(() => null);
      if (rendered) return rendered;
    }
    throw error;
  }

  if (resource.contentType.includes('html') && isRenderedShell(resource.body)) {
    const rendered = await renderIfConfigured(target);
    /* The shell has no content, but it usually has the page's `<title>`; the
       rendered markdown often has neither a level-1 heading nor that. */
    if (rendered) return rendered.title ? rendered : withShellTitle(rendered, resource.body);
    throw new IngestionFailure(
      'source_unrendered',
      'fetch-snapshot',
      `${new URL(target).host} serves a script shell with no content`,
    );
  }
  return resource;
}

/** Null when no renderer is configured; the renderer's own failure otherwise. */
async function renderIfConfigured(target: string): Promise<FetchedResource | null> {
  const renderer = pageRenderer();
  if (!renderer) return null;
  return renderer.render(new URL(target));
}

function withShellTitle(rendered: FetchedResource, shellHtml: string): FetchedResource {
  const title = htmlTitle(shellHtml);
  return title ? { ...rendered, title } : rendered;
}

function toFile(resource: FetchedResource, entry: URL): FetchedFile {
  return {
    path: withFormat(pathOf(resource.url, entry), resource.contentType),
    url: resource.url,
    content: resource.body,
    fetchedVia: resource.renderedBy ?? 'direct',
    ...(resource.title ? { title: resource.title } : {}),
  };
}

/**
 * An `llms.txt` index: fetch it, then fetch every document it links to.
 *
 * Links are restricted to the host the index was served from. An index is a
 * list of *this* site's documentation, and following it to another host would
 * let one site's index decide what gets published under another site's Library
 * ID -- the same reason architecture.md 15.1 treats source scope as a security
 * property rather than a convenience.
 *
 * An index may point at further indexes -- ethereum.org's top-level file
 * names `/developers/docs/llms.txt` for the developer documentation, in prose
 * rather than as a link. Whether those are followed, and how deep, is the
 * source's own setting (`indexDepth`, default none): same host, a bounded
 * number of indexes, and the documents they list join the set. Pages are
 * never crawled from: an index is the site saying what its documentation
 * is, and following links out of the listed pages would replace that
 * statement with a walk.
 */
async function fetchIndex(entry: URL, depth: number): Promise<FetchedFile[]> {
  const index = await fetchPage(entry.toString());

  const files: FetchedFile[] = [toFile(index, entry)];
  const seen = new Set<string>([normalizeUrl(entry)]);
  const targets: URL[] = [];
  /* Indexes still to expand, each with the level it sits at. */
  const indexes: { url: URL; level: number; body: string }[] = [{ url: entry, level: 0, body: index.body }];
  let followed = 0;

  while (indexes.length > 0) {
    const current = indexes.shift()!;
    for (const url of indexLinks(current.body, current.url)) {
      if (url.hostname !== entry.hostname) continue;
      const key = normalizeUrl(url);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!isIndexUrl(url)) {
        targets.push(url);
        continue;
      }
      if (current.level >= depth || followed >= INGESTION_LIMITS.maxNestedIndexes) continue;
      followed += 1;
      let page: FetchedResource;
      try {
        page = await fetchPage(url.toString());
      } catch (error) {
        if (error instanceof IngestionFailure) continue;
        throw error;
      }
      files.push(toFile(page, entry));
      indexes.push({ url, level: current.level + 1, body: page.body });
    }
  }

  for (const target of targets.slice(0, INGESTION_LIMITS.maxIndexPages)) {
    try {
      files.push(await fetchOne(target.toString(), entry));
    } catch (error) {
      /*
       * One dead link in an index is not a reason to abandon the build. A
       * failure that means the whole source is unusable -- the index itself --
       * has already been thrown above, before this loop.
       */
      if (error instanceof IngestionFailure) continue;
      throw error;
    }
  }
  return dedupe(files);
}

/** `llms.txt` and `llms-full.txt`, wherever they sit. */
function isIndexUrl(url: URL): boolean {
  return /\/llms(?:-full)?\.txt$/i.test(url.pathname);
}

/**
 * Everything an index points at: its Markdown links, plus bare URLs of
 * further indexes that the prose mentions without linking.
 */
function indexLinks(body: string, base: URL): URL[] {
  const found = markdownLinks(body, base);
  for (const match of body.matchAll(BARE_INDEX_URL)) {
    const url = toUrl(match[0], base);
    if (url) found.push(url);
  }
  return found;
}

const BARE_INDEX_URL = /https?:\/\/[^\s<>"'()]+\/llms(?:-full)?\.txt/gi;

/**
 * A breadth-first crawl from one entry point, same host only.
 *
 * The site's own sitemap seeds the first level when there is one: it is the
 * list of pages the site wants found, it does not depend on rendering a
 * navigation menu, and it reaches pages the entry point links to only through
 * JavaScript. Link-following still runs after it, for sites without one and
 * for pages the sitemap forgot.
 *
 * Breadth-first because depth-first on a documentation site walks straight into
 * the deepest changelog and spends the page budget there. The first pages a
 * crawl reaches from the entry point are the ones the site itself considers
 * important.
 */
async function crawl(entry: URL, maxDepth: number): Promise<FetchedFile[]> {
  const seen = new Set<string>([normalizeUrl(entry)]);
  let frontier: { url: URL; depth: number }[] = [{ url: entry, depth: 0 }];
  /* A sitemap page is a child discovered from the entry point, not another
     root. This keeps depth zero honest: only the URL the owner supplied is
     fetched, even when the host publishes a site-wide sitemap. */
  if (maxDepth > 0) {
    for (const seed of await sitemapPages(entry)) {
      const key = normalizeUrl(seed);
      if (seen.has(key)) continue;
      seen.add(key);
      frontier.push({ url: seed, depth: 1 });
    }
  }

  const files: FetchedFile[] = [];

  while (frontier.length > 0) {
    const next: { url: URL; depth: number }[] = [];
    for (const current of frontier) {
      if (files.length >= INGESTION_LIMITS.maxCrawlPages) break;

      let resource;
      try {
        resource = await fetchPage(current.url.toString());
      } catch (error) {
        // The entry point failing is fatal; a page discovered from it is not.
        if (files.length === 0) throw error;
        continue;
      }

      files.push(toFile(resource, entry));

      if (current.depth >= maxDepth) continue;

      for (const link of linksIn(resource)) {
        const key = normalizeUrl(link);
        if (seen.has(key)) continue;
        if (!inScope(link, entry)) continue;
        seen.add(key);
        next.push({ url: link, depth: current.depth + 1 });
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return dedupe(files);
}

/**
 * The links a fetched page carries, in whichever syntax it was served in.
 *
 * A host that honours `Accept: text/markdown` answers the crawl with markdown,
 * and a crawl that only knew `<a href>` would stop dead on the first page.
 */
function linksIn(resource: FetchedResource): URL[] {
  const base = new URL(resource.url);
  if (resource.contentType.includes('html')) return htmlLinks(resource.body, base);
  if (resource.contentType === 'text/markdown') return markdownLinks(resource.body, base);
  return [];
}

/** Same host, and under the section the entry point names. */
function inScope(link: URL, entry: URL): boolean {
  if (link.hostname !== entry.hostname) return false;
  const path = `${link.pathname.replace(/\/+$/, '')}/`;
  return path.startsWith(basePath(entry));
}

/**
 * The section the entry point names, as a path with a trailing slash.
 *
 * A crawl starting at `https://example.com/docs/` stays under `/docs/`. Without
 * this, one documentation section's Library ID would quietly acquire the whole
 * marketing site.
 *
 * The entry is a section whether or not it was typed with a trailing slash.
 * `/docs` and `/docs/` are one page on any site built this decade, and
 * reading `/whitepaper` as a *file* in `/` scoped one whitepaper's Library ID
 * to the whole of ethereum.org -- two hundred pages, one of them the
 * whitepaper. Only a last segment with an extension (`/docs/index.html`,
 * `/llms.txt`) is a file, and scopes to its directory; a segment such as
 * `/v2.0` reads the same way, and errs wider, which is the harmless side.
 */
function basePath(entry: URL): string {
  const path = entry.pathname.replace(/\/+$/, '');
  if (path === '') return '/';
  const cut = path.lastIndexOf('/');
  const last = path.slice(cut + 1);
  return /\.[a-z0-9]+$/i.test(last) ? path.slice(0, cut + 1) : `${path}/`;
}

/* ---------------------------------------------------------------- sitemaps */

/**
 * The pages a site's sitemap lists inside the crawl's scope.
 *
 * `robots.txt` names the sitemaps when the site bothered to; `/sitemap.xml` is
 * where they are otherwise. A sitemap index is followed, a bounded number of
 * files deep. Every failure here is silent: a site without a sitemap is normal,
 * and the crawl falls back to following links.
 */
async function sitemapPages(entry: URL): Promise<URL[]> {
  const queue = await sitemapLocations(entry);
  const visited = new Set<string>();
  const pages: URL[] = [];

  while (queue.length > 0 && visited.size < MAX_SITEMAPS) {
    const sitemap = queue.shift();
    if (!sitemap) break;
    if (visited.has(sitemap.toString())) continue;
    visited.add(sitemap.toString());
    if (pages.length >= INGESTION_LIMITS.maxCrawlPages) break;

    let resource: FetchedResource;
    try {
      resource = await fetchDocument(sitemap.toString(), {
        accept: 'application/xml, text/xml;q=0.9, */*;q=0.5',
      });
    } catch {
      continue;
    }

    const parsed = parseSitemap(resource.body, new URL(resource.url));
    for (const child of parsed.sitemaps) {
      if (child.hostname === entry.hostname) queue.push(child);
    }
    for (const page of parsed.pages) {
      if (inScope(page, entry)) pages.push(page);
    }
  }

  return pages.slice(0, INGESTION_LIMITS.maxCrawlPages);
}

const ROBOTS_SITEMAP = /^\s*sitemap:\s*(\S+)/gim;

/** `Sitemap:` lines from `robots.txt`, or the conventional path without one. */
async function sitemapLocations(entry: URL): Promise<URL[]> {
  const fallback = [new URL('/sitemap.xml', entry.origin)];
  let robots: string;
  try {
    robots = (await fetchDocument(new URL('/robots.txt', entry.origin).toString())).body;
  } catch {
    return fallback;
  }

  const listed: URL[] = [];
  for (const match of robots.matchAll(ROBOTS_SITEMAP)) {
    const url = match[1] ? toUrl(match[1], entry) : null;
    // A sitemap on another host is that host's list, not this one's.
    if (url && url.hostname === entry.hostname && isReadableSitemap(url)) listed.push(url);
  }
  return listed.length > 0 ? listed : fallback;
}

/** The fetcher decodes text; a gzipped sitemap would come back as noise. */
function isReadableSitemap(url: URL): boolean {
  return !url.pathname.endsWith('.gz');
}

const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

/**
 * `<loc>` entries, sorted by which kind of file this is.
 *
 * A sitemap index and a URL set use the same element for their entries; only
 * the root element says whether a location is a page or another sitemap.
 */
function parseSitemap(body: string, base: URL): { sitemaps: URL[]; pages: URL[] } {
  const isIndex = /<sitemapindex\b/i.test(body);
  const found: URL[] = [];
  for (const match of body.matchAll(LOC)) {
    const url = match[1] ? toUrl(decodeXml(match[1]), base) : null;
    if (url) found.push(url);
  }
  return isIndex
    ? { sitemaps: found.filter(isReadableSitemap), pages: [] }
    : { sitemaps: [], pages: found };
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/* ------------------------------------------------------------------- links */

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)/g;

function markdownLinks(body: string, base: URL): URL[] {
  const found: URL[] = [];
  for (const match of body.matchAll(MARKDOWN_LINK)) {
    const href = match[1];
    if (!href) continue;
    const url = toUrl(href, base);
    if (url) found.push(url);
  }
  return found;
}

const HREF = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;

function htmlLinks(body: string, base: URL): URL[] {
  const found: URL[] = [];
  for (const match of body.matchAll(HREF)) {
    const href = match[1];
    if (!href) continue;
    const url = toUrl(href, base);
    if (url) found.push(url);
  }
  return found;
}

/** Only absolute-resolvable https links; fragments and `mailto:` are dropped. */
function toUrl(href: string, base: URL): URL | null {
  if (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^https?:/i.test(href)) {
    return null;
  }
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'https:') return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

/** Same page, one with a trailing slash and one without, is one page. */
function normalizeUrl(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${url.host}${path}${url.search}`;
}

/* ------------------------------------------------------------------- paths */

function pathOf(target: string, entry: URL): string {
  const url = new URL(target);
  const path = `${url.pathname.replace(/\/+$/, '')}${url.search}`.replace(/^\/+/, '');
  if (url.hostname !== entry.hostname) return `${url.hostname}/${path}`;
  return path.length > 0 ? path : 'index';
}

/**
 * What the server said a page was, made visible in its path.
 *
 * Parsing chooses a format by file extension (`documentFormat`), and a URL such
 * as `/docs/routing` has none -- so without this, every page a crawl fetched
 * was silently dropped at the parse step. The content type is the only place
 * the answer exists, and it is also what tells markdown negotiated through
 * `Accept` apart from the rendered page at the same address.
 */
const SUFFIX_FOR: Record<string, string> = {
  'text/markdown': 'md',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/yaml': 'yaml',
  'text/yaml': 'yaml',
};

function withFormat(path: string, contentType: string): string {
  if (documentFormat(path)) return path;
  const suffix = SUFFIX_FOR[contentType];
  return suffix ? `${path}.${suffix}` : path;
}

/** A crawl reaches the same page by two paths often; a library should not. */
function dedupe(files: FetchedFile[]): FetchedFile[] {
  const byPath = new Map<string, FetchedFile>();
  for (const file of files) {
    if (!byPath.has(file.path)) byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

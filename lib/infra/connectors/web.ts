/**
 * Web pages and websites (rebuild-proposal.md 2.1).
 *
 * A page is one fetch, its main content turned into Markdown. A website is
 * every page of the same host under the entry's path, found from the
 * sitemap (`robots.txt` → `Sitemap:` lines, else `/sitemap.xml`, sitemap
 * indexes followed) and then from links inside the pages fetched, up to 500
 * pages. Pages are fetched a few at a time, and the crawl stops at a time
 * budget so processing finishes inside the function's limit; what was
 * fetched by then is kept.
 */
import { PAGE_MAX_BYTES, SITE_MAX_PAGES } from '@/lib/constants';
import { decodeEntities, htmlLinks, htmlTitle, htmlToMarkdown, isNoIndex } from './html';
import { fetchDocument, type FetchedResource } from './http';
import { ProcessingFailure } from './failure';

export interface WebPage {
  url: string;
  title: string;
  markdown: string;
}

const MAX_SITEMAPS = 10;
const CONCURRENCY = 6;
/** Wall-clock budget for a crawl; embedding and storing still need time after it. */
const CRAWL_BUDGET_MS = 150_000;

function isReadable(resource: FetchedResource): boolean {
  const type = resource.contentType;
  return type === '' || type.includes('html') || type.startsWith('text/');
}

function toPage(resource: FetchedResource): WebPage {
  const html = resource.contentType === '' || resource.contentType.includes('html');
  if (html) {
    const markdown = htmlToMarkdown(resource.body).trim();
    const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
    return { url: resource.url, title: htmlTitle(resource.body) ?? heading ?? new URL(resource.url).pathname, markdown };
  }
  const markdown = resource.body.replace(/\r\n?/g, '\n').trim();
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return { url: resource.url, title: heading ?? new URL(resource.url).pathname, markdown };
}

/** One page, as Markdown. Throws `ProcessingFailure` when it cannot be read. */
export async function fetchPage(target: string): Promise<WebPage> {
  const resource = await fetchDocument(target, { maxBytes: PAGE_MAX_BYTES });
  if (!isReadable(resource)) throw new ProcessingFailure('unsupported_format', `${target} is ${resource.contentType}`);
  const page = toPage(resource);
  if (!page.markdown) throw new ProcessingFailure('empty_text', `${target} has no readable text`);
  return page;
}

/* --------------------------------------------------------------- the crawl */

/** Where in-site links must stay: the entry's directory and below. */
export function basePath(entry: URL): string {
  const path = entry.pathname.replace(/\/+$/, '');
  if (path === '') return '/';
  const cut = path.lastIndexOf('/');
  const last = path.slice(cut + 1);
  return /\.[a-z0-9]+$/i.test(last) ? path.slice(0, cut + 1) : `${path}/`;
}

export function inScope(link: URL, entry: URL): boolean {
  if (link.hostname !== entry.hostname) return false;
  if (/\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|tar|mp[34]|m4a|wav|mov|avi|css|js|json|xml|woff2?|ttf|eot)$/i.test(link.pathname)) return false;
  return `${link.pathname.replace(/\/+$/, '')}/`.startsWith(basePath(entry));
}

/** One key per page: no fragment, no trailing slash, no tracking parameters. */
export function pageKey(url: URL): string {
  const copy = new URL(url);
  copy.hash = '';
  for (const name of [...copy.searchParams.keys()]) if (/^(utm_|ref$|fbclid$|gclid$)/i.test(name)) copy.searchParams.delete(name);
  return `${copy.host}${copy.pathname.replace(/\/+$/, '') || '/'}${copy.search}`;
}

const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

export function parseSitemap(body: string, base: URL): { sitemaps: URL[]; pages: URL[] } {
  const isIndex = /<sitemapindex\b/i.test(body);
  const found: URL[] = [];
  for (const match of body.matchAll(LOC)) {
    try {
      found.push(new URL(decodeEntities(match[1] ?? ''), base));
    } catch {
      /* not a URL */
    }
  }
  const readable = found.filter((url) => !url.pathname.endsWith('.gz'));
  return isIndex ? { sitemaps: readable, pages: [] } : { sitemaps: [], pages: found };
}

async function sitemapPages(entry: URL): Promise<URL[]> {
  const queue: URL[] = [];
  try {
    const robots = await fetchDocument(new URL('/robots.txt', entry.origin).toString(), { accept: 'text/plain', maxBytes: 256 * 1024 });
    for (const match of robots.body.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      try {
        const url = new URL(match[1]!, entry);
        if (url.hostname === entry.hostname) queue.push(url);
      } catch {
        /* not a URL */
      }
    }
  } catch {
    /* no robots.txt is the common case */
  }
  if (queue.length === 0) queue.push(new URL('/sitemap.xml', entry.origin));
  const pages: URL[] = [];
  const visited = new Set<string>();
  while (queue.length > 0 && visited.size < MAX_SITEMAPS && pages.length < SITE_MAX_PAGES) {
    const sitemap = queue.shift()!;
    if (visited.has(sitemap.href)) continue;
    visited.add(sitemap.href);
    try {
      const resource = await fetchDocument(sitemap.toString(), { accept: 'application/xml, text/xml;q=0.9, */*;q=0.5', maxBytes: PAGE_MAX_BYTES });
      const parsed = parseSitemap(resource.body, new URL(resource.url));
      for (const child of parsed.sitemaps) if (child.hostname === entry.hostname) queue.push(child);
      for (const page of parsed.pages) if (inScope(page, entry)) pages.push(page);
    } catch {
      /* a missing or broken sitemap leaves the link walk */
    }
  }
  return pages;
}

/**
 * Every page of the site under `entry`, the entry first. The entry failing
 * is fatal; a page found from it failing is skipped.
 */
export async function crawlSite(
  entry: URL,
  options: { maxPages?: number; budgetMs?: number; now?: () => number } = {},
): Promise<{ pages: WebPage[]; truncated: boolean }> {
  const maxPages = Math.min(options.maxPages ?? SITE_MAX_PAGES, SITE_MAX_PAGES);
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? CRAWL_BUDGET_MS);

  const first = await fetchDocument(entry.toString(), { maxBytes: PAGE_MAX_BYTES });
  if (!isReadable(first)) throw new ProcessingFailure('unsupported_format', `${entry} is ${first.contentType}`);
  /* A redirect at the root (`/` → `/docs/`) moves the scope with it, but never off the host. */
  const root = new URL(first.url).hostname === entry.hostname ? new URL(first.url) : entry;

  const seen = new Set<string>([pageKey(entry), pageKey(root)]);
  const queue: URL[] = [];
  const enqueue = (url: URL): void => {
    const key = pageKey(url);
    if (seen.has(key) || !inScope(url, root)) return;
    seen.add(key);
    queue.push(url);
  };

  const pages: WebPage[] = [];
  const keep = (resource: FetchedResource): void => {
    const html = resource.contentType === '' || resource.contentType.includes('html');
    if (html) for (const link of htmlLinks(resource.body, new URL(resource.url))) enqueue(link);
    if (html && isNoIndex(resource.body)) return;
    const page = toPage(resource);
    if (page.markdown) pages.push(page);
  };
  keep(first);
  for (const url of await sitemapPages(root)) enqueue(url);

  let truncated = false;
  while (queue.length > 0 && pages.length < maxPages) {
    if (now() > deadline) {
      truncated = true;
      break;
    }
    const batch = queue.splice(0, Math.min(CONCURRENCY, maxPages - pages.length));
    const results = await Promise.allSettled(batch.map((url) => fetchDocument(url.toString(), { maxBytes: PAGE_MAX_BYTES })));
    for (const result of results) {
      if (result.status !== 'fulfilled' || !isReadable(result.value)) continue;
      /* A redirect off the site is not a page of it. */
      if (!inScope(new URL(result.value.url), root) && result.value.url !== root.href) continue;
      if (pages.length < maxPages) keep(result.value);
    }
  }
  if (queue.length > 0 && pages.length >= maxPages) truncated = true;
  if (pages.length === 0) throw new ProcessingFailure('empty_text', `${entry} has no readable pages`);
  return { pages, truncated };
}

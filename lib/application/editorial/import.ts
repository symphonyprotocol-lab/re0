/**
 * Importing articles from a URL or an RSS/Atom feed. agent-first-proposal.md
 * 6.5: one article per source item, fetched through the same fetch and SSRF
 * checks every source uses (`fetchDocument`: https only, no private ranges,
 * every redirect hop checked, a size cap).
 *
 * An import creates drafts, not publications: the creator reads what came
 * in, declares their rights to it and publishes it like anything written in
 * the editor. A page becomes one draft; a feed becomes one draft per item,
 * newest first, at most `feedItemsMax`. An item whose feed carries no body
 * is fetched from its own link.
 */
import { EDITORIAL_LIMITS, EditorialRefused, looksLikeFeed, parseFeed } from '@/lib/domain/editorial';
import { pageHtmlToMarkdown } from '@/lib/http/page-markdown';
import { fetchDocument, type FetchedResource } from '@/lib/infrastructure/connectors/http';
import { createEditorialAsset, saveEditorialDraft, type EditorActor } from './assets';

export interface ImportedDraft {
  assetId: string;
  publicId: string;
  title: string;
}

type Fetcher = (url: string) => Promise<Pick<FetchedResource, 'url' | 'contentType' | 'body'>>;

const defaultFetcher: Fetcher = (url) =>
  fetchDocument(url, { accept: 'application/rss+xml, application/atom+xml, text/html;q=0.9, text/markdown;q=0.8, */*;q=0.5' });

function toMarkdown(resource: Pick<FetchedResource, 'url' | 'contentType' | 'body'>): string {
  if (/text\/(markdown|plain)/i.test(resource.contentType)) return resource.body;
  return pageHtmlToMarkdown(resource.body, new URL(resource.url));
}

function titleOf(markdown: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return (heading || fallback).slice(0, EDITORIAL_LIMITS.titleMax);
}

function bodyOf(markdown: string, title: string): string {
  /* The title is the post's own; a body that opens by repeating it would index it twice. */
  const trimmed = markdown.replace(new RegExp(`^#\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n`), '').trim();
  return `${trimmed}`.slice(0, EDITORIAL_LIMITS.bodyMax);
}

function withSource(body: string, link: string | null): string {
  return link ? `${body}\n\n---\n\nOriginally published at <${link}>` : body;
}

export async function importPosts(
  input: EditorActor & { url: string; channelId?: string | null },
  fetcher: Fetcher = defaultFetcher,
): Promise<ImportedDraft[]> {
  let resource: Pick<FetchedResource, 'url' | 'contentType' | 'body'>;
  try {
    resource = await fetcher(new URL(input.url.trim()).href);
  } catch (error) {
    throw new EditorialRefused('import_failed', error instanceof Error ? error.message : 'the address could not be read');
  }

  const items: { title: string; body: string }[] = [];
  if (looksLikeFeed(resource.contentType, resource.body)) {
    for (const item of parseFeed(resource.body)) {
      let markdown = item.content ? pageHtmlToMarkdown(`<main>${item.content}</main>`, new URL(item.link ?? resource.url)) : '';
      if (!markdown.trim() && item.link) {
        try {
          markdown = toMarkdown(await fetcher(item.link));
        } catch {
          markdown = '';
        }
      }
      if (!markdown.trim()) continue;
      items.push({ title: item.title, body: withSource(bodyOf(markdown, item.title), item.link) });
    }
  } else {
    const markdown = toMarkdown(resource);
    const title = titleOf(markdown, new URL(resource.url).hostname);
    items.push({ title, body: withSource(bodyOf(markdown, title), resource.url) });
  }
  if (items.length === 0) throw new EditorialRefused('import_failed', 'nothing readable was found at that address');

  const drafts: ImportedDraft[] = [];
  for (const item of items.slice(0, EDITORIAL_LIMITS.feedItemsMax)) {
    const created = await createUnique(input, item.title);
    await saveEditorialDraft({
      ...input,
      assetId: created.assetId,
      title: item.title,
      body: item.body,
      channelId: input.channelId ?? null,
      access: 'free',
    });
    drafts.push({ ...created, title: item.title });
  }
  return drafts;
}

/** A slug from the title, suffixed until it is free. */
async function createUnique(actor: EditorActor, title: string): Promise<{ assetId: string; publicId: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
      const base = title
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 56);
      return await createEditorialAsset({ ...actor, kind: 'post', title, slug: base ? `${base}${suffix}` : undefined });
    } catch (error) {
      if (!(error instanceof EditorialRefused && error.code === 'slug_taken')) throw error;
    }
  }
  return createEditorialAsset({ ...actor, kind: 'post', title });
}

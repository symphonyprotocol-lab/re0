import { cache } from 'react';
import { lookupShowcase, showcaseByHost, type ShowcaseLookup } from '@/lib/application/showcase';
import { currentSession } from '@/lib/http/session';

/**
 * One read per request: `generateMetadata`, the Open Graph image and the
 * page all need the same row, and `cache()` shares it within one render
 * without the application layer learning about React. The dashboard
 * session is resolved only when the owner asks for a preview (`?preview=1`),
 * so an anonymous visit never pays for it.
 */
export const showcaseLookup = cache(async (slug: string, preview: boolean): Promise<ShowcaseLookup> => {
  const session = preview ? await currentSession().catch(() => null) : null;
  return lookupShowcase(slug, { ownerWorkspaceId: session?.workspace.id ?? null });
});

export const PREVIEW_PARAM = 'preview';

export function wantsPreview(value: string | string[] | undefined | null): boolean {
  return value === '1';
}

/** The page behind a custom host, shared between the by-host page and its metadata. */
export const hostLookup = cache(showcaseByHost);

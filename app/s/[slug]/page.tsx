import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { customHostOf } from '@/lib/application/showcase';
import { PREVIEW_PARAM, showcaseLookup, wantsPreview } from './lookup';
import { ShowcaseScreen, showcaseMetadata } from './render';

type Params = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  return showcaseMetadata(slug, wantsPreview(query[PREVIEW_PARAM]), null);
}

/**
 * `/s/{slug}` on our host. A page that has gone live on its own host sends
 * the visitor there -- temporarily, since the host can be removed or lapse
 * and a browser must come back here to learn that; the owner's preview
 * stays here. Everything else is the page as app/s/[slug]/render.tsx
 * draws it.
 */
export default async function ShowcasePage({ params, searchParams }: Params) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const preview = wantsPreview(query[PREVIEW_PARAM]);
  const found = await showcaseLookup(slug, preview);
  if (found.kind === 'page' && !found.page.preview) {
    const host = await customHostOf(found.page.id);
    const here = (await headers()).get('host')?.toLowerCase().replace(/:\d+$/, '') ?? '';
    if (host && here !== host) redirect(`https://${host}/`);
  }
  return <ShowcaseScreen slug={slug} preview={preview} customHost={null} />;
}

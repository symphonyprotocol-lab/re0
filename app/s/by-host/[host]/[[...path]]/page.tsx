import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { messagesFor } from '@/lib/i18n/dictionary';
import { hostLookup } from '../../../[slug]/lookup';
import { ShowcaseScreen, showcaseMetadata } from '../../../[slug]/render';

type Params = { params: Promise<{ host: string; path?: string[] }> };

/**
 * A showcase page on the owner's own host. The middleware rewrites every
 * request that arrives on a host that is not ours to this route, host in
 * the path; only `/` is a page there (lib/application/showcase/domain.ts
 * `showcaseByHost`), and a host nobody has claimed, or a path under it,
 * is a 404.
 */
/** The middleware names the host it rewrote for; a request that arrived here by path on our own host has none. */
async function rewrittenFor(host: string): Promise<boolean> {
  return (await headers()).get('x-re0-custom-host') === host.toLowerCase();
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { host, path } = await params;
  const found = (path && path.length > 0) || !(await rewrittenFor(host)) ? null : await hostLookup(host);
  if (!found) return { title: messagesFor('en').showcase.fallbackTitle, robots: { index: false } };
  return showcaseMetadata(found.slug, false, host.toLowerCase());
}

export default async function ShowcaseByHostPage({ params }: Params) {
  const { host, path } = await params;
  if ((path && path.length > 0) || !(await rewrittenFor(host))) notFound();
  const found = await hostLookup(host);
  if (!found) notFound();
  return <ShowcaseScreen slug={found.slug} preview={false} customHost={host.toLowerCase()} />;
}

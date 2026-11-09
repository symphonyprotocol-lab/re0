import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { appBaseUrl } from '@/lib/http/cookies';
import { currentUser } from '@/lib/http/session';
import { publicReeBySlug as lookup } from '@/lib/services/public-rees';
import { ReeDetail } from '@/components/discover/ree-detail';

/** Metadata and the page share one lookup per request. */
const publicReeBySlug = cache(lookup);

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const ree = await publicReeBySlug((await params).slug);
  if (!ree) return { title: { absolute: 'RE0' }, robots: { index: false } };
  const url = `${appBaseUrl()}/r/${ree.slug}`;
  return {
    title: ree.name,
    description: ree.description || undefined,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: { type: 'profile', title: ree.name, description: ree.description || undefined, url, siteName: 'RE0' },
    twitter: { card: 'summary_large_image', title: ree.name, description: ree.description || undefined },
  };
}

/**
 * `/r/[slug]` (rebuild-proposal.md 2.4, prototype public-dot.js): a public
 * Ree on show with public comments. Asking happens in a conversation via
 * 「加入对话」. Knowledge appears only as
 * a count. Private, taken-down and deleted Rees are not found. Indexable.
 */
export default async function PublicReePage({ params, searchParams }: Props) {
  const [{ slug }, query, user] = await Promise.all([params, searchParams, currentUser()]);
  const ree = await publicReeBySlug(slug);
  if (!ree) notFound();
  return <ReeDetail ree={ree} query={query} viewerId={user?.id} />;
}

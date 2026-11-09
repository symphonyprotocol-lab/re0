import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ReeDetail } from '@/components/discover/ree-detail';
import { serverMessages } from '@/i18n/server';
import { currentUser } from '@/lib/http/session';
import { reeForPreview } from '@/lib/services/public-rees';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.reeSetup.settings.preview, robots: { index: false, follow: false } };
}

export default async function ReePreviewPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ draft?: string | string[] }>;
}) {
  const [user, { id }, { draft }] = await Promise.all([currentUser(), params, searchParams]);
  if (!user) notFound();
  const ree = await reeForPreview(id, user.id);
  if (!ree) notFound();
  return <ReeDetail ree={ree} viewerId={user.id} preview draftId={typeof draft === 'string' ? draft : undefined} />;
}

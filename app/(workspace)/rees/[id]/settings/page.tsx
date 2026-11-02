import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { readiness } from '@/lib/services/knowledge';
import { ownedRee } from '@/lib/services/rees';
import { serverMessages } from '@/i18n/server';
import { ReeTopbar } from '@/components/rees/ree-topbar';
import { ReeSettings } from '@/components/rees/ree-settings';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.reeSetup.tabs.settings };
}

export default async function ReeSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await currentUser())!;
  const ree = await ownedRee(db(), user.id, (await params).id);
  if (!ree) notFound();
  const counts = await readiness(ree.id);
  return (
    <>
      <ReeTopbar ree={ree} active="settings" />
      <ReeSettings ree={JSON.parse(JSON.stringify(ree))} sources={counts.ready + counts.processing} />
    </>
  );
}

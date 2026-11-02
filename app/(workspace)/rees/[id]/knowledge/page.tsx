import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { ownedRee } from '@/lib/services/rees';
import { serverMessages } from '@/i18n/server';
import { ReeTopbar } from '@/components/rees/ree-topbar';
import { KnowledgeManager } from '@/components/knowledge/knowledge-manager';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.knowledge.title };
}

export default async function KnowledgePage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await currentUser())!;
  const ree = await ownedRee(db(), user.id, (await params).id);
  if (!ree) notFound();
  return (
    <>
      <ReeTopbar ree={ree} active="knowledge" />
      <KnowledgeManager reeId={ree.id} />
    </>
  );
}

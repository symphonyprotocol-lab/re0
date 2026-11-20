import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { readiness } from '@/lib/services/knowledge';
import { listReeTries } from '@/lib/services/ree-try';
import { ownedRee } from '@/lib/services/rees';
import { serverMessages } from '@/i18n/server';
import { ReeTopbar } from '@/components/rees/ree-topbar';
import { ReeTry } from '@/components/rees/ree-try';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.reeSetup.tabs.chat };
}

/**
 * `/rees/[id]/chat`: 试问 -- the owner tries a Ree against its own knowledge.
 * Each question is a private post (`source = 'test'`, lib/services/ree-try.ts)
 * shown as an answer card, not a chat.
 */
export default async function ReeTryPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await currentUser())!;
  const ree = await ownedRee(db(), user.id, (await params).id);
  if (!ree) notFound();
  const [counts, items] = await Promise.all([readiness(ree.id), listReeTries(user.id, ree.id)]);
  return (
    <>
      <ReeTopbar ree={ree} active="chat" />
      <ReeTry ree={{ id: ree.id, name: ree.name, avatarBlob: ree.avatarBlob, color: ree.color, sampleQuestions: ree.sampleQuestions }} readiness={counts} initial={items ?? []} />
    </>
  );
}

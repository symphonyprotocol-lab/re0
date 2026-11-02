import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { maxCostFor } from '@/lib/services/answer';
import { messagesOf, testConversation, toUIMessages } from '@/lib/services/chat';
import { readiness } from '@/lib/services/knowledge';
import { ownedRee } from '@/lib/services/rees';
import { serverMessages } from '@/i18n/server';
import { ReeTopbar } from '@/components/rees/ree-topbar';
import { ReeChat } from '@/components/chat/ree-chat';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.reeSetup.tabs.chat };
}

/** `/rees/[id]/chat`: the owner tests a Ree against its own knowledge (conversation.kind = ree_test). */
export default async function ReeChatPage({ params }: { params: Promise<{ id: string }> }) {
  const user = (await currentUser())!;
  const ree = await ownedRee(db(), user.id, (await params).id);
  if (!ree) notFound();
  const conversation = await testConversation(user.id, ree.id);
  const [rows, counts] = await Promise.all([messagesOf(conversation.id), readiness(ree.id)]);
  return (
    <>
      <ReeTopbar ree={ree} active="chat" />
      <ReeChat
        conversationId={conversation.id}
        ree={{ id: ree.id, name: ree.name, avatarBlob: ree.avatarBlob, color: ree.color, sampleQuestions: ree.sampleQuestions }}
        readiness={counts}
        maxCost={maxCostFor(ree, user.id)}
        initialMessages={toUIMessages(rows)}
      />
    </>
  );
}

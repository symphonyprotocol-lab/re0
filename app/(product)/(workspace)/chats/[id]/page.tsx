import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { searchReturnPath } from '@/lib/domain/conversation';
import { currentUser } from '@/lib/http/session';
import { db } from '@/lib/infra/db';
import { storedSuggestions } from '@/lib/services/answer';
import { messagesOf, toUIMessages, votesFor } from '@/lib/services/chat';
import { liveConversation, participantsOf, priceFor, reeBriefs } from '@/lib/services/conversations';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { ChatRoom, type ReeDirectory } from '@/components/conversations/chat-room';

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const user = await currentUser();
  const conversation = user ? await liveConversation(user.id, (await params).id) : null;
  const { t } = await serverMessages();
  return { title: conversation?.title || t.conversations.sidebar.untitled };
}

/** `/chats/[id]`: one conversation with its participants (rebuild-proposal.md 3, 5). */
export default async function ConversationPage({ params, searchParams }: Props) {
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  const conversation = await liveConversation(user!.id, (await params).id);
  if (!conversation) notFound();
  const [participants, rows] = await Promise.all([participantsOf(db(), conversation.id, user!.id), messagesOf(conversation.id)]);
  const answerIds = rows.filter((row) => row.role === 'ree' && !row.noAnswer).map((row) => row.id);
  const [briefs, votes, suggestions] = await Promise.all([
    reeBriefs(db(), user!.id, rows.flatMap((row) => (row.reeId ? [row.reeId] : []))),
    votesFor(user!.id, answerIds),
    storedSuggestions(user!.id, rows),
  ]);
  const members = participants.filter((ree) => ree.usable).map((ree) => ({ ...ree, price: priceFor(ree, user!.id) }));
  const directory: ReeDirectory = Object.fromEntries([...briefs.values()].map((ree) => [ree.id, { ...ree, price: priceFor(ree, user!.id) }]));
  const title = conversation.title || t.conversations.sidebar.untitled;
  const back = searchReturnPath((await searchParams).from);
  return (
    <>
      <Topbar crumbs={[{ label: t.conversations.sidebar.search, href: back }, { label: title }]} />
      <ChatRoom
        conversation={{ id: conversation.id, title, pinned: conversation.pinned, archived: Boolean(conversation.archivedAt), updatedAt: conversation.updatedAt.toISOString() }}
        members={members}
        directory={directory}
        initialMessages={toUIMessages(rows, { votes, suggestions })}
        viewerId={user!.id}
      />
    </>
  );
}

import type { Metadata } from 'next';
import { parseConversationQuery } from '@/lib/domain/conversation';
import { currentUser } from '@/lib/http/session';
import { conversationReeOptions, listConversations } from '@/lib/services/conversations';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { ConversationSearch } from '@/components/conversations/conversation-search';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.conversations.search.title };
}

/** `/chats`: search every conversation, filters in the URL, paged on the server (prototype conversations.js). */
export default async function ChatsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  const query = parseConversationQuery(params);
  const [result, rees] = await Promise.all([listConversations(user!.id, query), conversationReeOptions(user!.id)]);
  return (
    <>
      <Topbar crumbs={[{ label: t.conversations.search.title }]} />
      <ConversationSearch
        query={query}
        result={{ ...result, items: result.items.map((item) => ({ ...item, archivedAt: item.archivedAt?.toISOString() ?? null, deletedAt: item.deletedAt?.toISOString() ?? null, updatedAt: item.updatedAt.toISOString() })) }}
        rees={rees}
        focus={params.focus === '1'}
      />
    </>
  );
}

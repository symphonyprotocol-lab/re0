import type { Metadata } from 'next';
import { parseConversationQuery } from '@/lib/domain/conversation';
import { currentUser } from '@/lib/http/session';
import { conversationPosition, conversationReeOptions, listConversations } from '@/lib/services/conversations';
import { serverMessages } from '@/i18n/server';
import { Topbar } from '@/components/shell/topbar';
import { ConversationSearch } from '@/components/conversations/conversation-search';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.common.nav.myPosts };
}

/**
 * `/me/posts` -- 我的帖子 (v5; `/chats` until then): my private questions --
 * every conversation -- searched and filtered, the URL holding the filters,
 * paged on the server (prototype conversations.js). ⌘K opens it. `?select=<id>` (the sidebar's
 * "选择此对话") opens the tab and page holding that conversation, unfiltered,
 * with it selected.
 */
export default async function MyPostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const [user, { t }] = await Promise.all([currentUser(), serverMessages()]);
  const parsed = parseConversationQuery(params);
  const selectId = typeof params.select === 'string' ? params.select : null;
  const position = selectId ? await conversationPosition(user!.id, selectId, parsed.size) : null;
  const query = position ? { ...parseConversationQuery({ size: String(parsed.size) }), ...position } : parsed;
  const [result, rees] = await Promise.all([listConversations(user!.id, query), conversationReeOptions(user!.id)]);
  return (
    <>
      <Topbar crumbs={[{ label: t.common.nav.myPosts }]} />
      <ConversationSearch
        query={query}
        result={{ ...result, items: result.items.map((item) => ({ ...item, archivedAt: item.archivedAt?.toISOString() ?? null, deletedAt: item.deletedAt?.toISOString() ?? null, updatedAt: item.updatedAt.toISOString() })) }}
        rees={rees}
        focus={params.focus === '1'}
        select={position ? selectId : null}
      />
    </>
  );
}
